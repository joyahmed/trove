//! Keeping the table fresh from a folder watcher (plan 21C.1c): `notify`, recursive on the
//! root, each event turned into an insert, a remove or a rename of rows.
//!
//! On Windows `notify` hands a rename over as two events, the old name then the new
//! (`RenameMode::From`, `RenameMode::To`); a folder renamed that way is removed and walked again
//! under its new name. A backend that sends both paths at once (`RenameMode::Both`) keeps the
//! rows and only renames one.

use std::path::Path;

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind};

use super::table::{Table, TOP};
use super::walk::{fill, Skip};

/// Apply one watcher event. `true` when the watcher lost events (`notify` asks for a rescan)
/// and the table must be walked again.
pub fn apply(table: &mut Table, event: &Event, skip: &Skip) -> bool {
    if event.need_rescan() {
        return true;
    }
    match event.kind {
        EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            for p in &event.paths {
                appear(table, p, skip);
            }
        }
        EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            for p in &event.paths {
                table.remove_path(p);
            }
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            if let [from, to] = event.paths.as_slice() {
                if skip.covers(table.root(), to) {
                    table.remove_path(from);
                } else if !table.rename_path(from, to) {
                    table.remove_path(from);
                    appear(table, to, skip);
                }
            }
        }
        // the old or the new name, unsaid: whichever is on disk now
        EventKind::Modify(ModifyKind::Name(_)) => {
            for p in &event.paths {
                // ⛔ no look at a path in a skipped folder: on a Mac that may be a privacy-guarded
                // one, and even a `stat` inside it raises the prompt (`core/privacy_folders.rs`)
                if skip.covers(table.root(), p) {
                    table.remove_path(p);
                } else if p.symlink_metadata().is_ok() {
                    appear(table, p, skip);
                } else {
                    table.remove_path(p);
                }
            }
        }
        _ => {}
    }
    false
}

/// A path that is now on disk: its row, and for a folder (moved in whole) what is inside.
fn appear(table: &mut Table, path: &Path, skip: &Skip) {
    if skip.covers(table.root(), path) {
        return;
    }
    let Ok(meta) = path.symlink_metadata() else {
        // gone again before we looked
        return;
    };
    // ⛔ never into a junction or symlink, as the walk
    let is_dir = meta.is_dir() && !meta.file_type().is_symlink();
    let Some(row) = table.insert_path(path, is_dir) else {
        return;
    };
    if is_dir && row != TOP {
        fill(table, path, row, skip);
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_util::Scratch;
    use super::super::walk::mac_skips;
    use super::super::HomeIndex;
    use super::*;
    use notify::event::{CreateKind, RemoveKind};
    use std::fs;
    use std::time::{Duration, Instant};

    fn ev(kind: EventKind, paths: &[&Path]) -> Event {
        let mut e = Event::new(kind);
        for p in paths {
            e = e.add_path(p.to_path_buf());
        }
        e
    }

    #[test]
    fn events_insert_rename_and_remove_rows() {
        let dir = Scratch::new("index-events");
        let root = dir.path();
        let mut t = Table::new(root);
        let skip = Skip::defaults();
        let sub = root.join("sub");
        fs::create_dir_all(sub.join("inner")).unwrap();
        fs::write(sub.join("inner/kept.txt"), "").unwrap();
        // a folder that arrives whole is walked
        apply(
            &mut t,
            &ev(EventKind::Create(CreateKind::Any), &[&sub]),
            &skip,
        );
        assert_eq!(t.search("kept", 5).1, 1);
        // both names at once: the rows follow
        let moved = root.join("moved");
        fs::rename(&sub, &moved).unwrap();
        let both = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        apply(&mut t, &ev(both, &[&sub, &moved]), &skip);
        let (rows, _) = t.search("kept", 5);
        assert_eq!(t.path_of(rows[0]), moved.join("inner/kept.txt"));
        // into a skipped folder is out of the index
        apply(
            &mut t,
            &ev(both, &[&moved, &root.join("node_modules")]),
            &skip,
        );
        assert_eq!(t.len(), 0);
        fs::rename(&moved, &sub).unwrap();
        apply(
            &mut t,
            &ev(EventKind::Create(CreateKind::Any), &[&sub]),
            &skip,
        );
        apply(
            &mut t,
            &ev(EventKind::Remove(RemoveKind::Any), &[&sub]),
            &skip,
        );
        assert_eq!(t.len(), 0);
        // lost events ask for a walk
        let lost = Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);
        assert!(apply(&mut t, &lost, &skip));
    }

    fn found(index: &HomeIndex, text: &str) -> usize {
        index.search(text, 5).map_or(0, |(_, total)| total)
    }

    /// Wait for the live index to agree, up to 5 s (the plan's screen box asks for 2 s).
    fn until(index: &HomeIndex, text: &str, want: usize) -> Duration {
        let started = Instant::now();
        while found(index, text) != want {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "{text:?}: {} hits, wanted {want}",
                found(index, text)
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        started.elapsed()
    }

    /// The real watcher on a real folder: a file made, renamed and deleted outside Trove.
    #[test]
    fn watcher_create_rename_delete_updates_table() {
        let dir = Scratch::new("index-live");
        let root = dir.path().to_path_buf();
        fs::write(root.join("before.txt"), "").unwrap();
        let index = HomeIndex::default();
        index.start(root.clone(), Skip::defaults(), 2);
        until(&index, "before", 1);
        fs::write(root.join("fresh-note.txt"), "").unwrap();
        let made = until(&index, "fresh-note", 1);
        fs::rename(root.join("fresh-note.txt"), root.join("renamed-note.txt")).unwrap();
        until(&index, "renamed-note", 1);
        until(&index, "fresh-note", 0);
        fs::create_dir_all(root.join("box/inside")).unwrap();
        fs::write(root.join("box/inside/boxed.txt"), "").unwrap();
        until(&index, "boxed", 1);
        fs::remove_file(root.join("renamed-note.txt")).unwrap();
        until(&index, "renamed-note", 0);
        fs::remove_dir_all(root.join("box")).unwrap();
        until(&index, "boxed", 0);
        eprintln!("a new file was findable after {} ms", made.as_millis());
        index.stop();
    }

    #[test]
    fn create_under_a_mac_skip_adds_no_row() {
        let dir = Scratch::new("index-mac-skip");
        let root = dir.path();
        let mut t = Table::new(root);
        let skip = Skip::new(&[], mac_skips(root));
        let cache = root.join("Library/Caches/com.app");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("blob.bin"), "").unwrap();
        let made = ev(
            EventKind::Create(CreateKind::Any),
            &[&cache.join("blob.bin")],
        );
        assert!(!apply(&mut t, &made, &skip));
        assert_eq!(t.len(), 0);
        // the same event somewhere kept is a row
        let kept = root.join("Documents");
        fs::create_dir_all(&kept).unwrap();
        apply(
            &mut t,
            &ev(EventKind::Create(CreateKind::Any), &[&kept]),
            &skip,
        );
        assert_eq!(t.len(), 1);
    }
}

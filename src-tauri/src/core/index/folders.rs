//! Live updates one folder at a time (plan 21C.9, Linux): a watch of its own on each folder the
//! walk goes into, none on a skipped one.
//!
//! Why not `notify`'s recursive mode: on Linux it is one inotify watch per folder under the root,
//! skipped folders too, and each watch is kernel memory under a per-user cap
//! (`fs.inotify.max_user_watches`, 65,536 on this Ubuntu box). Measured 2026-10-23: the home
//! folder here holds 323,138 folders, 35,326 once the skip list leaves out `node_modules`,
//! `.git`, `~/.cache` and the rest — the recursive watch runs out, this one fits.
//!
//! A folder that appears later (made, or moved in) gets its watches when its event comes in; a
//! folder removed or moved away gives its watches back, so a moved folder never reports under
//! its old name. When the cap is reached [`Folders::add_tree`] says so and the caller drops every
//! watch and falls back to walking again on a timer.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecursiveMode, Watcher};

use super::walk::Skip;

/// What one folder's watch needs: add it, give it back.
pub trait Watches {
    fn add(&mut self, dir: &Path) -> notify::Result<()>;
    fn give_back(&mut self, dir: &Path);
}

impl<W: Watcher> Watches for W {
    fn add(&mut self, dir: &Path) -> notify::Result<()> {
        self.watch(dir, RecursiveMode::NonRecursive)
    }
    fn give_back(&mut self, dir: &Path) {
        // already gone when the folder was deleted: nothing to give back
        let _ = self.unwatch(dir);
    }
}

/// Why the watches were given up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Full {
    /// our share of `fs.inotify.max_user_watches` is used up (see [`budget`])
    Budget,
    /// the kernel said no more (`ENOSPC`): other programs hold the rest
    Kernel,
    /// nothing could be watched again, not even the root: it was removed (and maybe made
    /// again) while events were lost. Given up, so the part's timer walks it instead.
    Gone,
}

/// The watches one part holds.
pub struct Folders<W: Watches> {
    watcher: W,
    root: PathBuf,
    /// every folder watched now
    watched: HashSet<PathBuf>,
    /// the most watches this part may hold
    budget: usize,
}

impl<W: Watches> Folders<W> {
    pub fn new(watcher: W, root: &Path, budget: usize) -> Self {
        Folders {
            watcher,
            root: root.to_path_buf(),
            watched: HashSet::new(),
            budget,
        }
    }

    /// The folders watched now.
    pub fn len(&self) -> usize {
        self.watched.len()
    }

    /// Watch `dir` and every folder under it the walk would go into. A folder watched already
    /// is left as it is, so this also fills in what a lost-events walk found.
    pub fn add_tree(&mut self, dir: &Path, skip: &Skip) -> Result<(), Full> {
        let mut todo = vec![dir.to_path_buf()];
        while let Some(d) = todo.pop() {
            if !self.watched.contains(&d) {
                if self.watched.len() >= self.budget {
                    return Err(Full::Budget);
                }
                match self.watcher.add(&d) {
                    Ok(()) => {
                        self.watched.insert(d.clone());
                    }
                    Err(e) if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) => {
                        return Err(Full::Kernel);
                    }
                    // gone again, or not ours to read: the walk cannot list it either
                    Err(_) => continue,
                }
            }
            let Ok(read) = std::fs::read_dir(&d) else {
                continue;
            };
            for entry in read.flatten() {
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                // ⛔ never into a symlink, as the walk
                if !kind.is_dir() || kind.is_symlink() {
                    continue;
                }
                let name = entry.file_name();
                if !skip.dir(&d, &name.to_string_lossy()) {
                    todo.push(entry.path());
                }
            }
        }
        Ok(())
    }

    /// Set every watch again from what is on disk now: give each back, then watch the root's
    /// tree. For a walk after lost events, whose queue was drained unread: a folder removed
    /// since is still listed although the kernel dropped its watch, and one made again at the
    /// same path would never be watched (`add_tree` leaves a listed folder as it is).
    pub fn rewatch(&mut self, skip: &Skip) -> Result<(), Full> {
        for p in std::mem::take(&mut self.watched) {
            self.watcher.give_back(&p);
        }
        let root = self.root.clone();
        self.add_tree(&root, skip)?;
        // found in the review: with no watch at all the part would still count as watched,
        // so its timer never runs and nothing under it is ever found again
        if self.watched.is_empty() {
            return Err(Full::Gone);
        }
        Ok(())
    }

    /// Give back the watch on `dir` and on every folder under it.
    fn give_back_tree(&mut self, dir: &Path) {
        // a file's event, the common case, costs one look-up
        if !self.watched.contains(dir) {
            return;
        }
        let gone: Vec<PathBuf> = self
            .watched
            .iter()
            .filter(|p| p.starts_with(dir))
            .cloned()
            .collect();
        for p in gone {
            self.watcher.give_back(&p);
            self.watched.remove(&p);
        }
    }

    /// A folder that is on disk now and in the index's reach: watch it and what is inside.
    fn arrive(&mut self, path: &Path, skip: &Skip) -> Result<(), Full> {
        let is_dir = path
            .symlink_metadata()
            .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink());
        if is_dir && !skip.covers(&self.root, path) {
            self.add_tree(path, skip)
        } else {
            Ok(())
        }
    }

    /// Keep the watches in step with one event. Call it before the table applies the event, so
    /// a new folder is watched before it is listed: what lands in it in between is listed too.
    pub fn follow(&mut self, event: &Event, skip: &Skip) -> Result<(), Full> {
        match event.kind {
            EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
                for p in &event.paths {
                    self.arrive(p, skip)?;
                }
            }
            EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                for p in &event.paths {
                    self.give_back_tree(p);
                }
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
                if let [from, to] = event.paths.as_slice() {
                    self.give_back_tree(from);
                    self.arrive(to, skip)?;
                }
            }
            // the old or the new name, unsaid: whichever is on disk now
            EventKind::Modify(ModifyKind::Name(_)) => {
                for p in &event.paths {
                    if p.symlink_metadata().is_ok() {
                        self.arrive(p, skip)?;
                    } else {
                        self.give_back_tree(p);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// How many folder watches one part may hold: three quarters of `fs.inotify.max_user_watches`,
/// a quarter left for editors and the other programs that watch folders. No cap where the
/// setting does not exist (off Linux).
pub fn budget() -> usize {
    let max = std::fs::read_to_string("/proc/sys/fs/inotify/max_user_watches")
        .ok()
        .and_then(|s| s.trim().parse::<usize>().ok());
    share_of(max)
}

fn share_of(max: Option<usize>) -> usize {
    max.map_or(usize::MAX, |m| m / 4 * 3)
}

#[cfg(test)]
mod tests {
    use super::super::test_util::Scratch;
    use super::*;
    use notify::event::{CreateKind, RemoveKind};
    use std::fs;

    /// Records the watches; says `ENOSPC` once it holds `room`, and refuses a folder that is
    /// not on disk, as inotify does.
    struct Fake {
        held: Vec<PathBuf>,
        room: usize,
    }

    impl Watches for Fake {
        fn add(&mut self, dir: &Path) -> notify::Result<()> {
            if self.held.len() >= self.room {
                return Err(notify::Error::new(notify::ErrorKind::MaxFilesWatch));
            }
            if !dir.is_dir() {
                return Err(notify::Error::path_not_found());
            }
            self.held.push(dir.to_path_buf());
            Ok(())
        }
        fn give_back(&mut self, dir: &Path) {
            self.held.retain(|p| p != dir);
        }
    }

    fn fake(room: usize) -> Fake {
        Fake {
            held: Vec::new(),
            room,
        }
    }

    fn ev(kind: EventKind, paths: &[&Path]) -> Event {
        let mut e = Event::new(kind);
        for p in paths {
            e = e.add_path(p.to_path_buf());
        }
        e
    }

    #[test]
    fn folders_watches_each_folder_and_never_a_skipped_one() {
        let dir = Scratch::new("folders-tree");
        let root = dir.path();
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg/lib")).unwrap();
        fs::create_dir_all(root.join(".cache/big")).unwrap();
        fs::write(root.join("a/file.txt"), "").unwrap();
        let skip = Skip::defaults().and_folder(root.join(".cache"));
        let mut f = Folders::new(fake(100), root, 100);
        f.add_tree(root, &skip).unwrap();
        let mut held = f.watcher.held.clone();
        held.sort();
        assert_eq!(
            held,
            vec![root.to_path_buf(), root.join("a"), root.join("a/b")]
        );
        // a second pass adds nothing twice
        f.add_tree(root, &skip).unwrap();
        assert_eq!(f.len(), 3);
    }

    #[test]
    fn folders_follow_a_new_a_moved_and_a_removed_folder() {
        let dir = Scratch::new("folders-follow");
        let root = dir.path();
        let skip = Skip::defaults();
        let mut f = Folders::new(fake(100), root, 100);
        f.add_tree(root, &skip).unwrap();
        // made whole (`mkdir -p`): every level is watched
        fs::create_dir_all(root.join("new/deep")).unwrap();
        f.follow(
            &ev(EventKind::Create(CreateKind::Folder), &[&root.join("new")]),
            &skip,
        )
        .unwrap();
        assert_eq!(f.len(), 3);
        // a file's event watches nothing
        fs::write(root.join("new/x.txt"), "").unwrap();
        f.follow(
            &ev(
                EventKind::Create(CreateKind::File),
                &[&root.join("new/x.txt")],
            ),
            &skip,
        )
        .unwrap();
        assert_eq!(f.len(), 3);
        // moved: the old names are given back, the new ones watched
        fs::rename(root.join("new"), root.join("moved")).unwrap();
        let both = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        f.follow(&ev(both, &[&root.join("new"), &root.join("moved")]), &skip)
            .unwrap();
        assert!(f.watched.contains(&root.join("moved/deep")));
        assert!(!f
            .watcher
            .held
            .iter()
            .any(|p| p.starts_with(root.join("new"))));
        assert_eq!(f.len(), 3);
        // removed
        fs::remove_dir_all(root.join("moved")).unwrap();
        f.follow(
            &ev(
                EventKind::Remove(RemoveKind::Folder),
                &[&root.join("moved")],
            ),
            &skip,
        )
        .unwrap();
        assert_eq!(f.watcher.held, vec![root.to_path_buf()]);
        // a folder made inside a skipped one is never watched
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        f.follow(
            &ev(
                EventKind::Create(CreateKind::Folder),
                &[&root.join("node_modules")],
            ),
            &skip,
        )
        .unwrap();
        assert_eq!(f.len(), 1);
    }

    /// Found in the review: a folder removed and made again while events were lost.
    /// `add_tree` alone leaves it as listed, with no live watch; `rewatch` watches it again and
    /// lists nothing that is gone.
    #[test]
    fn folders_rewatch_a_folder_made_again_and_drop_one_gone() {
        let dir = Scratch::new("folders-rewatch");
        let root = dir.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::create_dir_all(root.join("old")).unwrap();
        let skip = Skip::defaults();
        let mut f = Folders::new(fake(100), root, 100);
        f.add_tree(root, &skip).unwrap();
        // lost events: docs removed and made again, old removed; the kernel dropped both
        // watches, the events that said so were never read
        fs::remove_dir_all(root.join("docs")).unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::remove_dir_all(root.join("old")).unwrap();
        f.watcher
            .held
            .retain(|p| p != &root.join("docs") && p != &root.join("old"));
        // the bug: a second add_tree trusts the list and watches docs never again
        f.add_tree(root, &skip).unwrap();
        assert!(!f.watcher.held.contains(&root.join("docs")));
        f.rewatch(&skip).unwrap();
        let mut held = f.watcher.held.clone();
        held.sort();
        assert_eq!(held, vec![root.to_path_buf(), root.join("docs")]);
        assert_eq!(f.len(), 2, "old is no longer listed");
    }

    /// Found in the review: the root itself removed while events were lost. `rewatch`
    /// watches nothing, and says so, so the caller gives up and its timer walks the part.
    #[test]
    fn folders_rewatch_says_gone_when_nothing_is_left_to_watch() {
        let dir = Scratch::new("folders-rewatch-gone");
        let root = dir.path().join("home");
        fs::create_dir_all(root.join("docs")).unwrap();
        let skip = Skip::defaults();
        let mut f = Folders::new(fake(100), &root, 100);
        f.add_tree(&root, &skip).unwrap();
        assert_eq!(f.len(), 2);
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(f.rewatch(&skip), Err(Full::Gone));
        assert_eq!(f.len(), 0);
        assert!(f.watcher.held.is_empty(), "every watch given back");
        // made again: a rewatch then holds it, as before
        fs::create_dir_all(&root).unwrap();
        assert_eq!(f.rewatch(&skip), Ok(()));
        assert_eq!(f.len(), 1);
    }

    #[test]
    fn folders_say_full_at_the_budget_and_at_the_kernel_cap() {
        let dir = Scratch::new("folders-full");
        let root = dir.path();
        for d in ["a", "b", "c", "d"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        let skip = Skip::defaults();
        let mut ours = Folders::new(fake(100), root, 3);
        assert_eq!(ours.add_tree(root, &skip), Err(Full::Budget));
        let mut kernel = Folders::new(fake(2), root, 100);
        assert_eq!(kernel.add_tree(root, &skip), Err(Full::Kernel));
    }

    #[test]
    fn budget_leaves_a_quarter_of_the_kernel_cap() {
        assert_eq!(share_of(Some(65_536)), 49_152);
        assert_eq!(share_of(None), usize::MAX);
    }

    /// The real home folder with the real skip list and the real inotify (run by hand:
    /// `cargo test --release --lib watch_the_real_home_folder -- --ignored --nocapture`).
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "watches the real home folder"]
    fn watch_the_real_home_folder() {
        let home = crate::core::shell::user_profile().expect("HOME is set");
        let skip = Skip::defaults();
        // every lost-events signal the watcher sends: a queue overflow, or an error
        let lost = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = lost.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if res.map_or(true, |e| e.need_rescan()) {
                seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        })
        .unwrap();
        let mut f = Folders::new(watcher, &home, budget());
        let started = std::time::Instant::now();
        let res = f.add_tree(&home, &skip);
        eprintln!(
            "home {}: {} watches in {} ms, budget {}, result {res:?}",
            home.display(),
            f.len(),
            started.elapsed().as_millis(),
            budget()
        );
        assert_eq!(res, Ok(()));
        // what a walk after lost events costs on top
        let started = std::time::Instant::now();
        let res = f.rewatch(&skip);
        eprintln!(
            "rewatch: {} watches in {} ms, result {res:?}",
            f.len(),
            started.elapsed().as_millis()
        );
        assert_eq!(res, Ok(()));
        // the review: a rewatch gives back ~35k watches, each an IN_IGNORED event in a
        // queue of `fs.inotify.max_queued_events` (16,384 here). An overflow would read as lost
        // events, so walk again, so rewatch again: a loop. The watcher's thread reads the queue
        // between each of our calls, so it never fills.
        std::thread::sleep(std::time::Duration::from_secs(2));
        let lost = lost.load(std::sync::atomic::Ordering::Relaxed);
        eprintln!(
            "lost-events signals after rewatch: {lost}, queue {}",
            std::fs::read_to_string("/proc/sys/fs/inotify/max_queued_events")
                .unwrap_or_default()
                .trim()
        );
        assert_eq!(lost, 0, "a rewatch must not overflow the queue");
    }
}

//! Copy / move jobs, the Windows clipboard's file list, and Recycle Bin restore. A job runs
//! on its own thread and reports through two events; the commands only start, cancel and ask.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

use crate::core::clipboard::{self, ClipboardPaths};
use crate::core::drag_out::{self, DragOutcome};
use crate::core::transfer::{self, Resolution, TransferMode, TransferProgress};

/// Emitted at most every 100 ms while a job copies; payload `TransferProgress`.
pub const PROGRESS_EVENT: &str = "transfer:progress";
/// Emitted exactly once per job, on completion, error or cancel; payload `TransferDone`.
pub const DONE_EVENT: &str = "transfer:done";

pub(crate) static NEXT_JOB: AtomicU64 = AtomicU64::new(1);
static JOBS: Mutex<Option<HashMap<u64, Arc<AtomicBool>>>> = Mutex::new(None);
pub(crate) fn with_jobs<T>(f: impl FnOnce(&mut HashMap<u64, Arc<AtomicBool>>) -> T) -> T {
    let mut guard = JOBS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn paths(list: Vec<String>) -> Vec<PathBuf> {
    list.into_iter().map(PathBuf::from).collect()
}

/// Which of `sources` would land on something that already exists in `destination`.
#[tauri::command(async)]
pub fn transfer_conflicts(sources: Vec<String>, destination: String) -> Vec<String> {
    transfer::conflicts(&paths(sources), Path::new(&destination))
}

/// The place (`N:`, `WSL`, `\\server\share`) whose missing bin means a Replace of these
/// conflicts would overwrite the old files for good — the conflict dialog says so before the
/// person picks. Only files count: a folder Replace merges and bins nothing. `None` when the
/// old files can go to the bin (or the place cannot be told).
#[tauri::command(async)]
pub fn replace_no_bin(conflicts: Vec<String>) -> Option<String> {
    let files: Vec<PathBuf> = paths(conflicts)
        .into_iter()
        .filter(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_file()))
        .collect();
    if files.is_empty() {
        return None;
    }
    crate::core::ops::bin_refusal(&files)
}

/// Start a job and return its id at once; progress and completion arrive as events.
/// `names`, when given, is the name each source lands under (one per source; see
/// `transfer::run_job_as`) — the undo of a Keep-both move puts `a (2).txt` back as `a.txt`.
#[tauri::command(async)]
pub fn start_transfer(
    app: AppHandle,
    sources: Vec<String>,
    destination: String,
    mode: TransferMode,
    resolution: Resolution,
    names: Option<Vec<String>>,
) -> u64 {
    let job_id = NEXT_JOB.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    with_jobs(|jobs| jobs.insert(job_id, Arc::clone(&cancel)));
    std::thread::spawn(move || {
        let sink = |p: TransferProgress| {
            let _ = app.emit(PROGRESS_EVENT, p);
        };
        let done = transfer::run_job_as(
            job_id,
            &paths(sources),
            Path::new(&destination),
            names.as_deref(),
            mode,
            resolution,
            &cancel,
            &sink,
        );
        with_jobs(|jobs| jobs.remove(&job_id));
        let _ = app.emit(DONE_EVENT, done);
    });
    job_id
}

/// Ask a running job to stop after the current buffer. Unknown ids are ignored.
#[tauri::command(async)]
pub fn cancel_transfer(job_id: u64) {
    if let Some(flag) = with_jobs(|jobs| jobs.get(&job_id).cloned()) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Retry Failed for "arrived, but the original could not be deleted": delete each original
/// whose copy is still at its destination. Returns the ones still left, with the new reason.
#[tauri::command(async)]
pub fn remove_moved_originals(
    failed: Vec<transfer::TransferFailure>,
) -> Vec<transfer::TransferFailure> {
    transfer::remove_originals(&failed)
}

/// After Retry of a move: remove the source folders it emptied, each only if empty. Returns how
/// many went.
#[tauri::command(async)]
pub fn remove_emptied_folders(dirs: Vec<String>) -> usize {
    transfer::remove_emptied_folders(&paths(dirs))
}

/// For each wanted path, the bin item to bring back — the most recently deleted when the same
/// path is in the bin more than once — and the wanted paths with no item at all.
///
/// Matched by original path, not by the bin's own id: the undo that calls this only ever had
/// the paths it deleted (the `trash` crate's `delete_all` returns no ids). Newest is right for
/// an undo — the delete being undone is the latest one of that path.
///
/// Case is folded on Windows only (see `fold`).
// the Mac undo of a Delete does not read the bin (`trash_mac::put_back`); its tests still run
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn pick_restorable(
    bin: Vec<trash::TrashItem>,
    paths: &[String],
) -> (Vec<trash::TrashItem>, Vec<String>) {
    let mut newest: HashMap<String, trash::TrashItem> = HashMap::new();
    for item in bin {
        let key = fold(&item.original_path().to_string_lossy());
        if !paths.iter().any(|p| fold(p) == key) {
            continue;
        }
        match newest.get(&key) {
            Some(kept) if kept.time_deleted >= item.time_deleted => {}
            _ => {
                newest.insert(key, item);
            }
        }
    }
    let mut items = Vec::new();
    let mut missing = Vec::new();
    for path in paths {
        match newest.remove(&fold(path)) {
            Some(item) => items.push(item),
            // a path listed twice by the caller found its item the first time; not missing
            None if items
                .iter()
                .any(|i| fold(&i.original_path().to_string_lossy()) == fold(path)) => {}
            None => missing.push(path.clone()),
        }
    }
    (items, missing)
}

/// The comparison form of a path: case-folded where names are case-blind (Windows), as-is
/// elsewhere.
///
/// ⛔ Folding everywhere was a Linux bug: `/a/X.txt` and `/a/x.txt` are two files there, both
/// in the bin matched an undo of one of them, and the newer — possibly the OTHER file — won.
fn fold(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

/// Put `paths` back where they were deleted from. Restores every one it can: a path no longer
/// in the bin, or one whose place is taken by a new file, is named in the error afterwards
/// instead of stopping the rest — an undo that brings back nothing because of one stray item
/// is worse than one that brings back all but that item.
///
/// On a Mac the Trash cannot be read, so the items come back from what Trove recorded when it
/// sent them (`trash_mac::put_back`): only items Trove itself trashed in this run.
#[tauri::command(async)]
pub fn restore_from_trash(paths: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return crate::core::trash_mac::put_back(&paths);
    #[cfg(not(target_os = "macos"))]
    {
        use crate::core::os_limited::{describe, list, restore_all};
        let bin = list().map_err(|e| describe(&e))?;
        let (items, missing) = pick_restorable(bin, &paths);
        let blocked = restore_each(items, restore_all).map_err(|e| describe(&e))?;
        problems(&missing, &blocked)
    }
}

/// Restore every item it can. `restore_all` stops at the first item whose original path is
/// occupied and hands back the ones it did not get to; the blocked one is dropped, the rest
/// carry on. Returns the blocked paths.
fn restore_each(
    mut items: Vec<trash::TrashItem>,
    restore_all: impl Fn(Vec<trash::TrashItem>) -> Result<(), trash::Error>,
) -> Result<Vec<String>, trash::Error> {
    let mut blocked: Vec<String> = Vec::new();
    while !items.is_empty() {
        match restore_all(items) {
            Ok(()) => break,
            Err(trash::Error::RestoreCollision {
                path,
                remaining_items,
            }) => {
                blocked.push(path.to_string_lossy().into_owned());
                items = remaining_items
                    .into_iter()
                    .filter(|i| i.original_path() != path)
                    .collect();
            }
            Err(e) => return Err(e),
        }
    }
    Ok(blocked)
}

/// The paths a restore could not bring back, as one sentence; `Ok` when there are none.
fn problems(missing: &[String], blocked: &[String]) -> Result<(), String> {
    let mut problems = Vec::new();
    if !missing.is_empty() {
        problems.push(format!(
            "Not in the Recycle Bin any more: {}",
            missing.join(", ")
        ));
    }
    if !blocked.is_empty() {
        problems.push(format!(
            "Something new is already there: {}",
            blocked.join(", ")
        ));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join(". "))
    }
}

/// A file a Replace wrote over, now in the bin: where it was, and its mark there
/// (`transfer::TransferOutput::binned_at`, and `binned_id` when the bin could tell).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedFile {
    pub path: String,
    pub binned_at: i64,
    #[serde(default)]
    pub binned_id: Option<String>,
}

/// Undo of a Replace (plan 15 G.2): each old file comes back from the bin to its place. With
/// `bin_copies` (the undo of a Copy) the copy standing there goes to the bin first; the undo of
/// a Move has already moved its file back out.
///
/// ⛔ The old file is picked by its bin id, else by its mark (`transfer::pick_replaced`), BEFORE
/// the copy goes to the bin. It used to be "the newest item of the path": after two Replaces of one file (v2 over v1,
/// v3 over v2) the second undo brought back v3, the copy the first undo had just binned. A path
/// whose old file is no longer in the bin keeps its copy (binning it would leave neither) and
/// is named in the error.
///
/// On a Mac the Trash cannot be read (`os_limited`): the undo fails with that sentence before
/// anything moves; the old file is still in the Trash.
#[tauri::command(async)]
pub fn undo_replace(files: Vec<ReplacedFile>, bin_copies: bool) -> Result<(), String> {
    use crate::core::os_limited::{list, restore_all};
    undo_replace_with(
        &files,
        bin_copies,
        list,
        crate::core::ops::trash,
        restore_all,
    )
}

/// Whether the bin can be read, so the undo of a Move that replaced files can refuse BEFORE it
/// moves anything back (on a Mac it cannot: the files would move back and the old ones stay in
/// the Trash, leaving neither in their place).
#[tauri::command(async)]
pub fn bin_readable() -> Result<(), String> {
    use crate::core::os_limited::{describe, list};
    list().map(|_| ()).map_err(|e| describe(&e))
}

/// `undo_replace` with the bin given, so tests never touch the real one.
fn undo_replace_with(
    files: &[ReplacedFile],
    bin_copies: bool,
    list: impl Fn() -> Result<Vec<trash::TrashItem>, trash::Error>,
    bin: impl Fn(&[PathBuf]) -> std::io::Result<()>,
    restore_all: impl Fn(Vec<trash::TrashItem>) -> Result<(), trash::Error>,
) -> Result<(), String> {
    use crate::core::os_limited::describe;
    let all = list().map_err(|e| describe(&e))?;
    let mut items: Vec<trash::TrashItem> = Vec::new();
    let mut missing = Vec::new();
    for file in files {
        let taken: Vec<_> = items.iter().map(|i| i.id.clone()).collect();
        let mark = transfer::BinMark {
            at: file.binned_at,
            id: file.binned_id.clone(),
        };
        match transfer::pick_replaced(&all, Path::new(&file.path), &mark, &taken) {
            Some(item) => items.push(item),
            None => missing.push(file.path.clone()),
        }
    }
    if bin_copies {
        let copies: Vec<PathBuf> = items
            .iter()
            .map(|i| i.original_path())
            .filter(|p| std::fs::symlink_metadata(p).is_ok())
            .collect();
        if !copies.is_empty() {
            bin(&copies).map_err(|e| e.to_string())?;
        }
    }
    let blocked = restore_each(items, restore_all).map_err(|e| describe(&e))?;
    problems(&missing, &blocked)
}

/// `CF_HDROP` + `Preferred DropEffect`, so Explorer pastes what was cut or copied here.
#[tauri::command(async)]
pub fn clipboard_write_paths(paths: Vec<String>, cut: bool) -> Result<(), String> {
    clipboard::write_paths(&paths, cut)
}

/// "Copy as path": the given paths, one per line, each quoted, as plain text on the clipboard.
/// The frontend chooses the spelling (Windows or `distro:/…`); the quoting is Explorer's.
#[tauri::command(async)]
pub fn clipboard_write_paths_text(paths: Vec<String>) -> Result<(), String> {
    clipboard::write_text(&clipboard::quote_paths(&paths))
}

/// Plain text on the clipboard, verbatim — the palette's calculator answer, today. The
/// path-shaped sibling above quotes its lines; this one adds nothing.
#[tauri::command(async)]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    clipboard::write_text(&text)
}

/// What Explorer (or we) put on the clipboard; None when it holds no file list.
#[tauri::command(async)]
pub fn clipboard_read_paths() -> Option<ClipboardPaths> {
    clipboard::read_paths()
}

/// Hand the dragged paths to the OS as a native drag (OLE `CF_HDROP` on Windows, an AppKit
/// dragging session on a Mac, a GTK `text/uri-list` drag on Linux); returns when the person
/// drops or cancels. `async` so the wait runs off the main thread.
#[tauri::command(async)]
pub async fn drag_out(
    app: AppHandle,
    window: tauri::WebviewWindow,
    paths: Vec<String>,
    allow_move: bool,
) -> Result<DragOutcome, String> {
    // The drag has to start on the thread that owns the window the mouse is down in — the
    // main thread — so it can take over the pointer; a worker thread's drag ends at once with
    // no effect. OLE blocks that thread until the drop (pumping its own messages); AppKit and
    // GTK return at once and report later, so the outcome arrives through a callback either
    // way. The command stays async so the webview is not blocked on it.
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        drag_out::start_drag(
            &window,
            &paths,
            allow_move,
            Box::new(move |outcome| {
                let _ = tx.send(outcome);
            }),
        );
    })
    .map_err(|e| format!("main thread: {e}"))?;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .unwrap_or_else(|_| Err("the drag never reported back".to_string()))
    })
    .await
    .map_err(|e| format!("drag wait: {e}"))?;
    outcome
}

/// A drop of `sources` into `target` stays on one volume (a move there is a rename), by the
/// device the OS reports. False when anything cannot be read: the drop then copies.
#[tauri::command(async)]
pub fn same_volume(sources: Vec<String>, target: String) -> bool {
    crate::core::volume::same_volume(&sources, Path::new(&target))
}

/// The copy and move keys held right now, for a drop from another app: Tauri's drop event
/// carries no modifiers, and the window has no focus to see key events while the drag is over
/// it (src/lib/state/drag.svelte.ts `externalDrop`).
#[tauri::command]
pub fn drop_modifiers() -> crate::core::keys::Held {
    crate::core::keys::held()
}

/// The free space and mount root of the volume that really holds `path`, for the status bar;
/// `None` when it cannot be read, and always on Windows (the drive list answers there).
#[tauri::command(async)]
pub fn folder_space(path: String) -> Option<crate::core::volume::FolderSpace> {
    crate::core::volume::folder_space(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, parent: &str, name: &str, time_deleted: i64) -> trash::TrashItem {
        trash::TrashItem {
            id: id.into(),
            name: name.into(),
            original_parent: PathBuf::from(parent),
            time_deleted,
        }
    }

    /// A folder spelled the way this OS spells it. ⛔ The test was written with `C:\a`
    /// literals; on Linux `PathBuf::from(r"C:\a").join("x.txt")` is `C:\a/x.txt`, which no
    /// wanted `C:\a\x.txt` can ever equal — the test failed on the spelling, not the matching.
    fn dir(name: &str) -> String {
        if cfg!(windows) {
            format!(r"C:\{name}")
        } else {
            format!("/{name}")
        }
    }

    fn under(folder: &str, name: &str) -> String {
        PathBuf::from(folder)
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    /// ⛔ Was a failed undo: `C:\a\x.txt` deleted, recreated and deleted again sits in the bin
    /// twice; both matched, and `restore_all` refuses twins — nothing came back. The newest is
    /// the one the undo means.
    #[test]
    fn a_path_in_the_bin_twice_restores_its_newest_and_a_gone_one_is_named() {
        let a = dir("a");
        let bin = vec![
            item("old", &a, "x.txt", 100),
            item("new", &a, "x.txt", 200),
            item("other", &a, "y.txt", 150),
        ];
        // Windows names are case-blind, so the undo may spell the path in another case there
        let wanted_x = if cfg!(windows) {
            under(&dir("A"), "X.TXT")
        } else {
            under(&a, "x.txt")
        };
        let gone = under(&a, "gone.txt");
        let (items, missing) = pick_restorable(bin, &[wanted_x, gone.clone()]);
        let ids: Vec<_> = items.iter().map(|i| i.id.clone()).collect();
        assert_eq!(ids, vec![std::ffi::OsString::from("new")]);
        assert_eq!(missing, vec![gone]);
    }

    /// The bin, faked in memory over a scratch folder: `bin_all` moves a file into it and lists
    /// it with its original path, `restore_all` moves it back. ⛔ Never the real Recycle Bin.
    struct FakeBin {
        store: PathBuf,
        items: std::cell::RefCell<Vec<trash::TrashItem>>,
        clock: std::cell::Cell<i64>,
        /// how far the clock moves per item: 0 is a bin of whole seconds, all in one second
        tick: i64,
        /// how many items it has made; each one's id
        made: std::cell::Cell<i64>,
    }

    impl FakeBin {
        fn new(store: PathBuf) -> Self {
            std::fs::create_dir_all(&store).unwrap();
            FakeBin {
                store,
                items: Default::default(),
                clock: std::cell::Cell::new(0),
                tick: 1,
                made: std::cell::Cell::new(0),
            }
        }

        /// Bins each path; returns the mark of the last.
        fn bin_all(&self, paths: &[PathBuf]) -> std::io::Result<i64> {
            for path in paths {
                self.clock.set(self.clock.get() + self.tick);
                self.made.set(self.made.get() + 1);
                let id = self.made.get().to_string();
                std::fs::rename(path, self.store.join(&id))?;
                self.items.borrow_mut().push(trash::TrashItem {
                    id: id.into(),
                    name: path.file_name().unwrap().to_os_string(),
                    original_parent: path.parent().unwrap().to_path_buf(),
                    // each later than the last, as in a real bin: a copy binned by the undo is
                    // the NEWEST item of its path
                    time_deleted: self.clock.get(),
                });
            }
            Ok(self.clock.get())
        }

        fn list(&self) -> Result<Vec<trash::TrashItem>, trash::Error> {
            Ok(self.items.borrow().clone())
        }

        fn restore_all(&self, items: Vec<trash::TrashItem>) -> Result<(), trash::Error> {
            for item in items {
                let to = item.original_path();
                std::fs::rename(self.store.join(&item.id), &to).unwrap();
                self.items.borrow_mut().retain(|i| i.id != item.id);
            }
            Ok(())
        }

        fn undo(&self, files: &[ReplacedFile], bin_copies: bool) -> Result<(), String> {
            undo_replace_with(
                files,
                bin_copies,
                || self.list(),
                |p| self.bin_all(p).map(|_| ()),
                |i| self.restore_all(i),
            )
        }
    }

    impl transfer::Bin for FakeBin {
        fn bin(&self, path: &Path) -> std::io::Result<transfer::BinMark> {
            let at = self.bin_all(&[path.to_path_buf()])?;
            Ok(transfer::BinMark {
                at,
                id: Some(self.made.get().to_string()),
            })
        }

        fn unbin(&self, _: &Path, _: &transfer::BinMark) -> std::io::Result<()> {
            unreachable!("no replace fails in these tests")
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("trove-undo-replace-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A Replace of `dest/a.txt` by `root/a.txt` holding `bytes`, through `fake`.
    fn replace_with_bytes(
        fake: &FakeBin,
        root: &Path,
        dest: &Path,
        mode: TransferMode,
        bytes: &[u8],
    ) -> ReplacedFile {
        std::fs::write(root.join("a.txt"), bytes).unwrap();
        let cancel = AtomicBool::new(false);
        let done = transfer::run_job_binning(
            1,
            &[root.join("a.txt")],
            dest,
            None,
            mode,
            Resolution::Replace,
            &cancel,
            &|_| {},
            fake,
        );
        assert_eq!(done.outputs[0].replaced, Some(transfer::Replaced::Binned));
        ReplacedFile {
            path: done.outputs[0].to.clone(),
            binned_at: done.outputs[0].binned_at.unwrap(),
            binned_id: done.outputs[0].binned_id.clone(),
        }
    }

    /// G.2 end to end: a Copy with Replace bins the old file; Undo puts the old file back in its
    /// place and the copy in the bin. Both sit in the bin under ONE path for a moment, the copy
    /// the newer — the undo must still bring back the old one, not the copy.
    #[test]
    fn undo_of_a_replace_brings_the_old_file_back() {
        let root = scratch("roundtrip");
        let dest = root.join("dest");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("a.txt"), b"old").unwrap();
        let fake = FakeBin::new(root.join("bin"));
        let file = replace_with_bytes(&fake, &root, &dest, TransferMode::Copy, b"new");
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"new");

        fake.undo(&[file], true).unwrap();
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"old");
        let left = fake.items.borrow();
        assert_eq!(left.len(), 1, "the copy is in the bin");
        assert_eq!(
            std::fs::read(root.join("bin").join(&left[0].id)).unwrap(),
            b"new"
        );
        drop(left);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Was v3 back instead of v1: two Copy-Replaces of one file (v2 over v1, v3 over v2) and
    /// two Undos. The undo picked the NEWEST bin item of the path, and the newest by then was the
    /// copy the first undo had just binned. Each undo now brings back the item its Replace made.
    #[test]
    fn two_replaces_and_two_undos_bring_back_the_first_file() {
        let root = scratch("twice");
        let dest = root.join("dest");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("a.txt"), b"v1").unwrap();
        let fake = FakeBin::new(root.join("bin"));
        let first = replace_with_bytes(&fake, &root, &dest, TransferMode::Copy, b"v2");
        let second = replace_with_bytes(&fake, &root, &dest, TransferMode::Copy, b"v3");
        fake.undo(&[second], true).unwrap();
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"v2");
        fake.undo(&[first], true).unwrap();
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"v1");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Was the copy back instead of the old file (G.2 review 2, B): the Windows bin keeps whole
    /// seconds. Undo, Redo, Undo of one Copy-Replace inside one second: the copy binned by the
    /// first undo and the old file binned by the redo share a path and a time, and the mark
    /// picked the copy. The undo now restores the item its own Replace made, by id.
    #[test]
    fn undo_redo_undo_in_one_second_brings_back_the_old_file() {
        let root = scratch("same-second");
        let dest = root.join("dest");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("a.txt"), b"old").unwrap();
        let fake = FakeBin {
            tick: 0,
            ..FakeBin::new(root.join("bin"))
        };
        let first = replace_with_bytes(&fake, &root, &dest, TransferMode::Copy, b"new");
        fake.undo(&[first], true).unwrap();
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"old");
        // the redo: the same Replace again, in the same second
        let again = replace_with_bytes(&fake, &root, &dest, TransferMode::Copy, b"new");
        assert!(again.binned_id.is_some());
        fake.undo(&[again], true).unwrap();
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"old");
        let left = fake.items.borrow();
        assert_eq!(left.len(), 2, "both copies are in the bin");
        for item in left.iter() {
            assert_eq!(
                std::fs::read(root.join("bin").join(&item.id)).unwrap(),
                b"new"
            );
        }
        drop(left);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A Replace whose bin could not name the item (no id: the Mac, an old undo entry) is still
    /// undone by its mark.
    #[test]
    fn with_no_id_the_undo_falls_back_to_the_mark() {
        let root = scratch("no-id");
        let dest = root.join("dest");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("a.txt"), b"v1").unwrap();
        let fake = FakeBin::new(root.join("bin"));
        let no_id = |f: ReplacedFile| ReplacedFile {
            binned_id: None,
            ..f
        };
        let first = no_id(replace_with_bytes(
            &fake,
            &root,
            &dest,
            TransferMode::Copy,
            b"v2",
        ));
        let second = no_id(replace_with_bytes(
            &fake,
            &root,
            &dest,
            TransferMode::Copy,
            b"v3",
        ));
        fake.undo(&[second], true).unwrap();
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"v2");
        fake.undo(&[first], true).unwrap();
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"v1");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The undo of a Move: the moved file has already gone back, so nothing is binned; the old
    /// file comes back to its place.
    #[test]
    fn undo_of_a_move_replace_restores_without_binning() {
        let root = scratch("move");
        let dest = root.join("dest");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("a.txt"), b"old").unwrap();
        let fake = FakeBin::new(root.join("bin"));
        let file = replace_with_bytes(&fake, &root, &dest, TransferMode::Move, b"new");
        // the move back
        std::fs::rename(dest.join("a.txt"), root.join("a.txt")).unwrap();
        fake.undo(&[file], false).unwrap();
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"old");
        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), b"new");
        assert!(fake.items.borrow().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// An old file no longer in the bin (emptied since): its copy is NOT binned — that would
    /// leave neither — and the error names it.
    #[test]
    fn an_old_file_gone_from_the_bin_keeps_the_copy_and_says_so() {
        let root = scratch("gone");
        std::fs::write(root.join("a.txt"), b"new").unwrap();
        let fake = FakeBin::new(root.join("bin"));
        let target = root.join("a.txt").to_string_lossy().into_owned();
        let err = fake
            .undo(
                &[ReplacedFile {
                    path: target,
                    binned_at: 0,
                    binned_id: None,
                }],
                true,
            )
            .unwrap_err();
        assert!(err.contains("Not in the Recycle Bin any more"), "{err}");
        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), b"new");
        assert!(fake.items.borrow().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A bin that cannot be read (the Mac Trash) refuses before anything moves.
    #[test]
    fn a_bin_that_cannot_be_read_changes_nothing() {
        let root = scratch("unreadable");
        std::fs::write(root.join("a.txt"), b"new").unwrap();
        let target = root.join("a.txt").to_string_lossy().into_owned();
        let err = undo_replace_with(
            &[ReplacedFile {
                path: target,
                binned_at: 0,
                binned_id: None,
            }],
            true,
            || {
                Err(trash::Error::Unknown {
                    description: "Trove cannot put items back from the Trash on macOS.".into(),
                })
            },
            |_| panic!("nothing may be binned"),
            |_| panic!("nothing may be restored"),
        )
        .unwrap_err();
        assert!(err.starts_with("Trove cannot put items back"), "{err}");
        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), b"new");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// On a case-sensitive file system `X.txt` and `x.txt` are two files: undoing the delete of
    /// one must not restore the other, even when the other is the newer item in the bin.
    #[cfg(not(windows))]
    #[test]
    fn off_windows_a_name_in_another_case_is_another_file() {
        let a = dir("a");
        let bin = vec![
            item("mine", &a, "x.txt", 100),
            item("theirs", &a, "X.txt", 200),
        ];
        let (items, missing) = pick_restorable(bin, &[under(&a, "x.txt")]);
        let ids: Vec<_> = items.iter().map(|i| i.id.clone()).collect();
        assert_eq!(ids, vec![std::ffi::OsString::from("mine")]);
        assert!(missing.is_empty());
    }
}

//! The journal of moves parked beside their target (`transfer::park_beside`).
//!
//! A Replace by move first renames the source to a hidden `.<name>.<launch>-<job>.trove-parked` beside
//! the old file, then (once the old file is in the bin) renames it over the old one. A crash in
//! between left the moved file hidden in the target folder for good, gone from where it came
//! from, and nobody was told.
//!
//! So each park is written to `parked.json` in the app's data folder BEFORE the rename and taken
//! out once the parked file has landed or gone back. At the next start (`recover`), every entry
//! still there whose file still exists is renamed to a visible `name (recovered).ext` beside it
//! and logged. ⛔ Never deleted: it is the only copy of the moved file.
//!
//! Every rename here and in the park never writes over anything (`rename_no_replace`): jobs run
//! side by side, and a plain rename onto a name another job just took destroys that job's file.

use super::ops;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Error, ErrorKind, Result, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// The journal file name in the app's local data folder.
pub const FILE: &str = "parked.json";

/// How many free names a rename tries before it gives up (each one taken by someone else in the
/// instant between the pick and the rename).
const TRIES: usize = 16;

/// One park in flight: the hidden file, and the target it was on its way to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub parked: PathBuf,
    pub target: PathBuf,
}

/// The app's journal, set once at start (`recover_at_start`). Unset (no app data folder, or a
/// test), `add` says no — so nothing parks — and `remove` does nothing.
static JOURNAL: OnceLock<PathBuf> = OnceLock::new();
/// Jobs run side by side: one read-change-write of the journal at a time.
static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// At app start: set the journal in `data_dir` and recover what a crash left parked.
///
/// Only the entries there NOW are recovered, and on a thread of their own: a parked file on a
/// share that does not answer must not hold up the start, and a park a job begins meanwhile is
/// not a crash leftover and is never touched.
pub fn recover_at_start(data_dir: &Path) {
    let journal = data_dir.join(FILE);
    let _ = JOURNAL.set(journal.clone());
    let at_start = {
        let _held = lock();
        match read(&journal) {
            Ok(entries) => entries,
            Err(e) => {
                log::warn!("parked journal: could not read it: {e}");
                log::debug!("parked journal: could not read {}: {e}", journal.display());
                return;
            }
        }
    };
    if at_start.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        recover_entries(&journal, Some(&at_start), &|| {});
    });
}

/// Note a park about to happen. `false` when the journal could not be written: the caller must
/// then not park (a crash would leave the file hidden with nothing pointing at it).
///
/// ⛔ (G.2 review 6, 3) Said yes with no journal set (the app data folder could not be found):
/// parks went ahead that no start would ever recover. No journal is now a no.
pub fn add(entry: &Entry) -> bool {
    add_to(JOURNAL.get().map(PathBuf::as_path), entry)
}

/// `add` with the journal given: `None` (none set) is a no.
fn add_to(journal: Option<&Path>, entry: &Entry) -> bool {
    let Some(journal) = journal else {
        log::warn!("parked journal: none set, so a move is not parked");
        log::debug!("parked journal: not parked: {}", entry.parked.display());
        return false;
    };
    match add_in(journal, entry) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("parked journal: could not note a parked move: {e}");
            log::debug!(
                "parked journal: could not note {}: {e}",
                entry.parked.display()
            );
            false
        }
    }
}

/// The park of `parked` is over (landed, or moved back).
pub fn remove(parked: &Path) {
    if let Some(journal) = JOURNAL.get() {
        if let Err(e) = remove_in(journal, parked) {
            log::warn!("parked journal: could not clear an entry: {e}");
            log::debug!("parked journal: could not clear {}: {e}", parked.display());
        }
    }
}

/// Rename `from` to `to` only if nothing is at `to`: `AlreadyExists` if something is, and
/// `Unsupported` where the filesystem cannot promise it (the caller then takes another way).
///
/// ⛔ `fs::rename` writes over whatever is at `to`. Two Replace moves to one name picked the same
/// free park name, and the second rename destroyed the first one's file.
pub fn rename_no_replace(from: &Path, to: &Path) -> Result<()> {
    imp::rename_no_replace(from, to)
}

#[cfg(windows)]
mod imp {
    use std::io::{Error, Result};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    /// `MoveFileExW` with no flags: no `MOVEFILE_REPLACE_EXISTING` (an existing `to` fails with
    /// `ERROR_ALREADY_EXISTS`), no `MOVEFILE_COPY_ALLOWED` (another volume fails).
    pub fn rename_no_replace(from: &Path, to: &Path) -> Result<()> {
        let (from, to) = (wide(from), wide(to));
        // SAFETY: both are NUL-terminated UTF-16 strings that live across the call
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
            return Err(Error::last_os_error());
        }
        Ok(())
    }

    /// A path for a W call, NUL-terminated. A long one gets the `\\?\` prefix (`fs::rename`
    /// does the same), or a deep folder would fail where a plain rename works.
    fn wide(path: &Path) -> Vec<u16> {
        const SLASH: u16 = b'\\' as u16;
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.len() >= 248 && !wide.starts_with(&[SLASH, SLASH, b'?' as u16, SLASH]) {
            if let Ok(abs) = std::path::absolute(path) {
                let abs: Vec<u16> = abs.as_os_str().encode_wide().collect();
                wide = if let Some(unc) = abs.strip_prefix(&[SLASH, SLASH][..]) {
                    r"\\?\UNC\"
                        .encode_utf16()
                        .chain(unc.iter().copied())
                        .collect()
                } else {
                    r"\\?\".encode_utf16().chain(abs).collect()
                };
            }
        }
        wide.push(0);
        wide
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod imp {
    use std::ffi::CString;
    use std::io::{Error, ErrorKind, Result};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    fn c_path(path: &Path) -> Result<CString> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| Error::new(ErrorKind::InvalidInput, "a path with a NUL in it"))
    }

    /// Linux: `renameat2(RENAME_NOREPLACE)`, through `syscall` so an older libc without the
    /// wrapper still has it. macOS: `renamex_np(RENAME_EXCL)`.
    pub fn rename_no_replace(from: &Path, to: &Path) -> Result<()> {
        let (from, to) = (c_path(from)?, c_path(to)?);
        // SAFETY: both are NUL-terminated C strings that live across the call
        #[cfg(target_os = "linux")]
        let done = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        } == 0;
        // SAFETY: both are NUL-terminated C strings that live across the call
        #[cfg(target_os = "macos")]
        let done = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } == 0;
        if done {
            return Ok(());
        }
        let e = Error::last_os_error();
        // a kernel or filesystem without the flag (old kernel, some FUSE / network mounts)
        match e.raw_os_error() {
            Some(libc::EINVAL | libc::ENOSYS | libc::ENOTSUP) => {
                Err(Error::new(ErrorKind::Unsupported, e))
            }
            _ => Err(e),
        }
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod imp {
    use std::io::{Error, ErrorKind, Result};
    use std::path::Path;

    pub fn rename_no_replace(_: &Path, _: &Path) -> Result<()> {
        Err(Error::new(
            ErrorKind::Unsupported,
            "no rename that refuses to replace here",
        ))
    }
}

/// Rename `from` into `dir` as `name`, or the next free name after it (`name (2).ext`…), never
/// over anything. Returns where it went.
///
/// Where the filesystem has no such rename (`Unsupported`), a plain rename onto a name that was
/// free a moment ago — the best there is there.
pub fn rename_to_free(from: &Path, dir: &Path, name: &str) -> Result<PathBuf> {
    for _ in 0..TRIES {
        let to = dir.join(ops::unique_name(dir, name, false));
        match rename_no_replace(from, &to) {
            Ok(()) => return Ok(to),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) if e.kind() == ErrorKind::Unsupported => {
                return fs::rename(from, &to).map(|()| to);
            }
            Err(e) => return Err(e),
        }
    }
    Err(Error::new(
        ErrorKind::AlreadyExists,
        format!("no free name for {name} in {}", dir.display()),
    ))
}

/// The entries of the journal; none when there is no journal.
///
/// A file that cannot be READ is an error, never an empty journal: the caller would write its
/// own entries over the ones it could not see. A file that is there but cannot be understood is
/// kept aside as `parked.json.<time>.bad` (the entries in it may be the only trace of a hidden
/// file; its text goes to the log) and the journal starts fresh — unless it cannot be kept
/// aside, which is an error too.
fn read(journal: &Path) -> Result<Vec<Entry>> {
    let bytes = match fs::read(journal) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    match serde_json::from_slice(&bytes) {
        Ok(entries) => Ok(entries),
        Err(e) => {
            let bad = bad_name(journal);
            log::warn!("parked journal: damaged ({e}); kept a copy beside it");
            log::debug!(
                "parked journal: {} is damaged ({e}); kept as {}. It said: {}",
                journal.display(),
                bad.display(),
                said(&bytes)
            );
            fs::rename(journal, &bad).map_err(|e| {
                Error::new(
                    e.kind(),
                    format!("a damaged journal could not be kept aside: {e}"),
                )
            })?;
            Ok(Vec::new())
        }
    }
}

/// The text of a damaged journal for the log: the paths in it are what matters, so as JSON when
/// it is any, else as text, cut short.
fn said(bytes: &[u8]) -> String {
    const MAX: usize = 4096;
    let text = match serde_json::from_slice::<serde_json::Value>(bytes) {
        Ok(value) => value.to_string(),
        Err(_) => String::from_utf8_lossy(bytes).into_owned(),
    };
    match text.char_indices().nth(MAX) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text,
    }
}

/// `parked.json` -> `parked.json.<unix seconds>.bad`, a free name: an earlier one is never
/// written over.
fn bad_name(journal: &Path) -> PathBuf {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = journal
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| FILE.into());
    let dir = journal.parent().unwrap_or(Path::new(""));
    dir.join(ops::unique_name(dir, &format!("{name}.{secs}.bad"), false))
}

/// `parked.json` -> `parked.json.tmp`.
fn tmp_name(journal: &Path) -> PathBuf {
    let mut name = journal.as_os_str().to_owned();
    name.push(".tmp");
    PathBuf::from(name)
}

fn write(journal: &Path, entries: &[Entry]) -> Result<()> {
    if entries.is_empty() {
        return match fs::remove_file(journal) {
            Err(e) if e.kind() != ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    if let Some(dir) = journal.parent() {
        fs::create_dir_all(dir)?;
    }
    // written beside, on disk, then renamed over: a crash mid-write (or a power cut before the
    // bytes reach the disk) leaves the old journal whole
    let tmp = tmp_name(journal);
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(&serde_json::to_vec_pretty(entries)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, journal)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// `add` on a given journal file.
pub fn add_in(journal: &Path, entry: &Entry) -> Result<()> {
    let _held = lock();
    let mut entries = read(journal)?;
    entries.retain(|e| e.parked != entry.parked);
    entries.push(entry.clone());
    write(journal, &entries)
}

/// `remove` on a given journal file.
pub fn remove_in(journal: &Path, parked: &Path) -> Result<()> {
    let _held = lock();
    let mut entries = read(journal)?;
    let before = entries.len();
    entries.retain(|e| e.parked != parked);
    if entries.len() == before {
        return Ok(());
    }
    write(journal, &entries)
}

/// Each parked file still on disk is renamed to `name (recovered).ext` beside its target (a
/// free name: `name (recovered) (2).ext`…). Returns the new paths. An entry whose file is gone is
/// dropped; one whose rename fails stays for the next start.
#[cfg(test)]
pub fn recover_in(journal: &Path) -> Vec<PathBuf> {
    recover_entries(journal, None, &|| {})
}

/// `recover_in`, limited to `only` when given (entries added since stay as they are).
///
/// A parked file that cannot be reached (its folder is gone: an unplugged stick, an offline
/// share) is NOT gone: its entry stays. It is dropped only when the folder is there and the
/// file is not.
///
/// The journal is locked only to read it and to write it back: the renames between can take
/// long (a share that is slow to answer) and must not stop every job from parking meanwhile
/// (`between` runs there, for the tests). The write-back re-reads it and takes out only the
/// entries handled here, so a park noted meanwhile stays.
fn recover_entries(journal: &Path, only: Option<&[Entry]>, between: &dyn Fn()) -> Vec<PathBuf> {
    let read_now = {
        let _held = lock();
        read(journal)
    };
    let snapshot = match read_now {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!("parked journal: could not read it: {e}");
            log::debug!("parked journal: could not read {}: {e}", journal.display());
            return Vec::new();
        }
    };
    let mut recovered = Vec::new();
    let mut handled = Vec::new();
    for entry in snapshot {
        if only.is_some_and(|only| !only.contains(&entry)) {
            continue;
        }
        if let Err(e) = fs::symlink_metadata(&entry.parked) {
            let folder_there = entry.parked.parent().is_some_and(Path::exists);
            if e.kind() == ErrorKind::NotFound && folder_there {
                handled.push(entry);
            }
            continue;
        }
        let Some(dir) = entry.parked.parent() else {
            handled.push(entry);
            continue;
        };
        match rename_to_free(&entry.parked, dir, &recovered_name(&entry.target)) {
            Ok(to) => {
                log::warn!("recovered a move a crash left hidden");
                log::debug!(
                    "recovered a move a crash left hidden: {} is now {}",
                    entry.parked.display(),
                    to.display()
                );
                recovered.push(to);
                handled.push(entry);
            }
            Err(e) => {
                log::warn!("could not recover a move a crash left hidden: {e}");
                log::debug!("could not recover {}: {e}", entry.parked.display());
            }
        }
    }
    between();
    if handled.is_empty() {
        return recovered;
    }
    let _held = lock();
    let result = read(journal).and_then(|mut entries| {
        entries.retain(|e| !handled.contains(e));
        write(journal, &entries)
    });
    if let Err(e) = result {
        log::warn!("parked journal: could not rewrite it: {e}");
        log::debug!(
            "parked journal: could not rewrite {}: {e}",
            journal.display()
        );
    }
    recovered
}

/// `a.txt` → `a (recovered).txt`; `.env` and `notes` → `.env (recovered)`, `notes (recovered)`.
pub fn recovered_name(target: &Path) -> String {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "moved file".into());
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} (recovered).{ext}"),
        _ => format!("{name} (recovered)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trove-parked-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(dir: &Path, name: &str) -> Entry {
        Entry {
            parked: dir.join(format!(".{name}.1.trove-parked")),
            target: dir.join(name),
        }
    }

    /// A park that finished leaves nothing in the journal, and the journal file goes.
    #[test]
    fn a_finished_park_leaves_no_entry() {
        let root = scratch("finished");
        let journal = root.join("data").join(FILE);
        let a = entry(&root, "a.txt");
        let b = entry(&root, "b.txt");
        add_in(&journal, &a).unwrap();
        add_in(&journal, &b).unwrap();
        assert_eq!(read(&journal).unwrap(), [a.clone(), b.clone()]);
        remove_in(&journal, &a.parked).unwrap();
        assert_eq!(read(&journal).unwrap(), std::slice::from_ref(&b));
        remove_in(&journal, &b.parked).unwrap();
        assert!(!journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Was a file hidden for good (G.2 review 2, C): a crash between park and land left
    /// the parked file in the target folder and nothing ever looked. The next start
    /// renames it to a name the person sees, beside the old file, and deletes nothing.
    #[test]
    fn a_park_left_by_a_crash_is_renamed_to_be_seen() {
        let root = scratch("crash");
        let journal = root.join(FILE);
        let a = entry(&root, "a.txt");
        fs::write(&a.parked, b"moved").unwrap();
        fs::write(&a.target, b"old").unwrap();
        // a name already taken: the recovered file takes the next free one
        fs::write(root.join("a (recovered).txt"), b"earlier").unwrap();
        let gone = entry(&root, "gone.txt");
        add_in(&journal, &a).unwrap();
        add_in(&journal, &gone).unwrap();

        let got = recover_in(&journal);
        assert_eq!(got, [root.join("a (recovered) (2).txt")]);
        assert_eq!(fs::read(&got[0]).unwrap(), b"moved");
        assert!(!a.parked.exists());
        assert_eq!(
            fs::read(&a.target).unwrap(),
            b"old",
            "the old file is untouched"
        );
        assert_eq!(
            fs::read(root.join("a (recovered).txt")).unwrap(),
            b"earlier"
        );
        assert!(!journal.exists(), "every entry handled");
        assert!(
            recover_in(&journal).is_empty(),
            "a second start finds nothing"
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// A parked file whose folder cannot be reached (unplugged stick) stays in the journal.
    #[test]
    fn an_unreachable_park_stays_in_the_journal() {
        let root = scratch("unreachable");
        let journal = root.join(FILE);
        let away = entry(&root.join("unplugged"), "a.txt");
        add_in(&journal, &away).unwrap();
        assert!(recover_in(&journal).is_empty());
        assert_eq!(read(&journal).unwrap(), [away]);
        fs::remove_dir_all(root).unwrap();
    }

    /// Entries added after the start snapshot are not crash leftovers and are left alone.
    #[test]
    fn recovery_leaves_entries_added_since_start() {
        let root = scratch("since");
        let journal = root.join(FILE);
        let old = entry(&root, "old.txt");
        let live = entry(&root, "live.txt");
        fs::write(&old.parked, b"x").unwrap();
        fs::write(&live.parked, b"y").unwrap();
        add_in(&journal, &old).unwrap();
        add_in(&journal, &live).unwrap();
        let got = recover_entries(&journal, Some(std::slice::from_ref(&old)), &|| {});
        assert_eq!(got.len(), 1);
        assert!(live.parked.exists());
        assert_eq!(read(&journal).unwrap(), [live]);
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ (G.2 review 4, 5) Recovery held the journal lock across every rename, so a slow share
    /// stopped every job from parking. Now a park noted while recovery renames (here: the
    /// `between` step, which would hang if the lock were still held) gets in, and survives the
    /// write-back.
    #[test]
    fn a_park_noted_during_recovery_gets_in_and_stays() {
        let root = scratch("during");
        let journal = root.join(FILE);
        let old = entry(&root, "old.txt");
        fs::write(&old.parked, b"x").unwrap();
        add_in(&journal, &old).unwrap();
        let meanwhile = entry(&root, "meanwhile.txt");
        let got = recover_entries(&journal, None, &|| add_in(&journal, &meanwhile).unwrap());
        assert_eq!(got, [root.join("old (recovered).txt")]);
        assert_eq!(read(&journal).unwrap(), [meanwhile]);
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ (G.2 review 6, 2) A park this run makes for the same target and job as a crash
    /// leftover differs only by its launch token. Recovery, running while jobs do, handles the
    /// leftover only: the new park keeps its file and its journal entry.
    #[test]
    fn a_park_like_a_leftover_but_of_this_launch_stays() {
        let root = scratch("launch");
        let journal = root.join(FILE);
        let at = |launch: &str| Entry {
            parked: root.join(format!(".a.txt.{launch}-1.trove-parked")),
            target: root.join("a.txt"),
        };
        let old = at("aa01");
        let now = at("bb02");
        assert_ne!(old, now);
        fs::write(&old.parked, b"left").unwrap();
        add_in(&journal, &old).unwrap();
        let got = recover_entries(&journal, Some(std::slice::from_ref(&old)), &|| {
            fs::write(&now.parked, b"in flight").unwrap();
            add_in(&journal, &now).unwrap();
        });
        assert_eq!(got, [root.join("a (recovered).txt")]);
        assert_eq!(fs::read(&now.parked).unwrap(), b"in flight");
        assert_eq!(read(&journal).unwrap(), [now]);
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ (G.2 review 6, 3) With no journal set a park was allowed, and a crash then left it
    /// hidden with nothing pointing at it. No journal is a no; a journal that writes is a yes.
    #[test]
    fn no_journal_means_no_park() {
        let root = scratch("nojournal");
        let a = entry(&root, "a.txt");
        assert!(!add_to(None, &a));
        let journal = root.join(FILE);
        assert!(add_to(Some(&journal), &a));
        assert_eq!(read(&journal).unwrap(), [a]);
        fs::remove_dir_all(root).unwrap();
    }

    /// A write goes through a temp file (none left behind); a damaged journal is kept aside as
    /// `.bad`, not silently emptied — and a second one does not write over the first.
    #[test]
    fn a_damaged_journal_is_kept_aside() {
        let root = scratch("bad");
        let journal = root.join(FILE);
        let a = entry(&root, "a.txt");
        add_in(&journal, &a).unwrap();
        assert!(!tmp_name(&journal).exists());
        fs::write(&journal, b"{ \"parked\": [").unwrap();
        assert!(read(&journal).unwrap().is_empty());
        assert!(!journal.exists());
        fs::write(&journal, b"second").unwrap();
        assert!(read(&journal).unwrap().is_empty());
        let mut kept: Vec<Vec<u8>> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().ends_with(".bad"))
            .map(|p| fs::read(p).unwrap())
            .collect();
        kept.sort();
        assert_eq!(kept, [b"second".to_vec(), b"{ \"parked\": [".to_vec()]);
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ (G.2 review 4, 2) A journal that could not be read was taken for an empty one: the next
    /// park wrote only its own entry, and recovery wrote an empty list — every entry that pointed
    /// at a hidden file was gone. Now nothing is written over a journal that cannot be read.
    #[test]
    fn a_journal_that_cannot_be_read_is_never_written_over() {
        let root = scratch("unreadable");
        // a folder where the journal should be: reading it fails, and not with NotFound
        let journal = root.join(FILE);
        fs::create_dir(&journal).unwrap();
        fs::write(journal.join("keep"), b"entries").unwrap();
        assert!(read(&journal).is_err());
        assert!(add_in(&journal, &entry(&root, "a.txt")).is_err());
        assert!(remove_in(&journal, &entry(&root, "a.txt").parked).is_err());
        let parked = entry(&root, "b.txt");
        fs::write(&parked.parked, b"b").unwrap();
        assert!(recover_entries(&journal, Some(std::slice::from_ref(&parked)), &|| {}).is_empty());
        assert!(journal.is_dir());
        assert_eq!(fs::read(journal.join("keep")).unwrap(), b"entries");
        assert!(
            parked.parked.exists(),
            "nothing recovered from an unread journal"
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ (G.2 review 4, 1) The rename under every park never writes over a file that is there.
    #[test]
    fn rename_no_replace_refuses_an_existing_target() {
        let root = scratch("noreplace");
        let (a, b, c) = (root.join("a"), root.join("b"), root.join("c"));
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        let e = rename_no_replace(&a, &b).unwrap_err();
        if e.kind() == ErrorKind::Unsupported {
            eprintln!("skipped: this filesystem cannot rename without replacing: {e}");
            fs::remove_dir_all(root).unwrap();
            return;
        }
        assert_eq!(e.kind(), ErrorKind::AlreadyExists, "{e}");
        assert_eq!(fs::read(&a).unwrap(), b"a");
        assert_eq!(fs::read(&b).unwrap(), b"b");
        rename_no_replace(&a, &c).unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read(&c).unwrap(), b"a");
        // to a free name: the next one after a taken one
        let to = rename_to_free(&c, &root, "b").unwrap();
        assert_eq!(to, root.join("b (2)"));
        assert_eq!(fs::read(&b).unwrap(), b"b");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovered_names_keep_the_extension() {
        assert_eq!(recovered_name(Path::new("d/a.txt")), "a (recovered).txt");
        assert_eq!(
            recovered_name(Path::new("d/a.tar.gz")),
            "a.tar (recovered).gz"
        );
        assert_eq!(recovered_name(Path::new("d/.env")), ".env (recovered)");
        assert_eq!(recovered_name(Path::new("d/notes")), "notes (recovered)");
    }
}

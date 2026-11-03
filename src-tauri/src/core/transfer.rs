//! Copy and move jobs. A job is a list of sources, a destination folder and a mode; it sizes
//! everything first so progress is bytes, copies with a 1 MB buffer, preserves the modified
//! time and the read-only bit, moves by `rename` on the same volume and by copy + delete
//! across volumes, and stops at a cancel flag between files and between buffers. The loop
//! is ours on purpose: `SHFileOperationW` brings Explorer's own progress window.
//!
//! Three rules keep a job from destroying what it was asked to carry:
//! - nothing is ever copied or moved onto itself (refused before any byte moves);
//! - a file is written under a partial name and renamed over its target only once whole, so
//!   a failed Replace leaves the old file exactly as it was;
//! - a file that a Replace writes over goes to the Recycle Bin / Trash first, so Undo can bring
//!   it back (`Replaced`); where there is no bin it is overwritten as before, and said so;
//! - a link (junction, symlink) is copied as a link, and a move whose source holds a link
//!   that could not be recreated keeps that source rather than delete it;
//! - a move that copies deletes only what it saw arrive (`remove_arrived`): each file or link
//!   whose copy completed, then each folder whose whole subtree arrived, and only once it is
//!   empty. It never deletes a source tree wholesale, so a file that failed, that appeared
//!   mid-job, or whose name cannot be spelled as text is never taken with it.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Error, ErrorKind, Read, Result, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::ops;
use super::parked;

const BUFFER: usize = 1024 * 1024;
pub(crate) const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// A folder listing that fails this many entries in a row is given up on: a listing that keeps
/// returning the same error would otherwise never end.
const LISTING_ERRORS_MAX: u32 = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransferMode {
    Copy,
    Move,
}

/// What to do with a top-level source whose target already exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Resolution {
    Replace,
    Skip,
    KeepBoth,
}

/// One top-level source that landed, and where. Skipped sources are not listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOutput {
    pub from: String,
    pub to: String,
    /// A file that landed by Replace over an older file at `to`: what became of that old file.
    /// Absent for everything else (a new name, a folder merge, a skip).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaced: Option<Replaced>,
    /// With `Replaced::Binned`: the old file's mark in the bin (`Bin::bin`), so the Undo brings
    /// back THAT item, not merely the newest one from this path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binned_at: Option<i64>,
    /// With `Replaced::Binned`, when the bin could tell: the id of the very bin item the old
    /// file became (`BinMark::id`). The Undo restores by it; `binned_at` is the fallback.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binned_id: Option<String>,
}

/// What a Replace did with the file it wrote over.
///
/// ⛔ Was data loss with no warning (plan 15 G.2): the old file was simply overwritten, and the
/// Undo only binned the new copy — the old one was gone for good.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Replaced {
    /// It went to the Recycle Bin / Trash just before the new file took its place: the Undo
    /// brings it back from there, the same way the Undo of a Delete does.
    Binned,
    /// The bin would not take it (a share, a USB stick, WSL, a bin turned off…): it was
    /// overwritten as before, and nothing can bring it back. The frontend says so.
    Lost,
}

/// Where `Bin::bin` put a file: the unix second taken just BEFORE it went (`at`) and, when the
/// bin could tell, the id of the item it became (`id`, the `trash` crate's `TrashItem::id`).
///
/// ⛔ The mark alone was not enough: the Windows bin keeps whole seconds, so an Undo, Redo, Undo
/// of one Copy-Replace inside one second left two items of the path with the same time — the
/// copy the first undo binned and the old file the redo binned — and the oldest-at-or-after
/// pick could take the copy. The id names the item itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BinMark {
    pub at: i64,
    pub id: Option<String>,
}

/// Where a Replace sends the file it writes over. The app's is the Recycle Bin / Trash
/// (`TrashBin`); tests pass a fake, so no test ever touches the real bin.
pub trait Bin {
    /// Send one file to the bin. Returns its mark (`BinMark`): the item's id when the bin can
    /// tell, and the unix second taken just BEFORE it went, so without an id the item made is
    /// the oldest one of that path deleted at or after it (`pick_replaced`).
    /// A bin that refuses the place says so with an `ops::NoRecycleBin` inside the error.
    fn bin(&self, path: &Path) -> Result<BinMark>;
    /// Put back the item `bin` made of `path` (its mark is `mark`).
    fn unbin(&self, path: &Path, mark: &BinMark) -> Result<()>;
}

pub type BinFn<'a> = &'a dyn Bin;

/// The Recycle Bin / Trash itself. One per job: it remembers the ids the bin held after the
/// last file it sent, so the next file needs no read of the bin before it (N files = N+1 reads,
/// not 2N).
#[derive(Default)]
pub struct TrashBin {
    seen: std::cell::RefCell<Option<std::collections::HashSet<std::ffi::OsString>>>,
}

impl Bin for TrashBin {
    fn bin(&self, path: &Path) -> Result<BinMark> {
        bin_listed(
            &self.seen,
            &|| super::os_limited::list().ok(),
            &|| ops::trash_replaced(&[path.to_path_buf()]),
            path,
        )
    }

    fn unbin(&self, path: &Path, mark: &BinMark) -> Result<()> {
        use super::os_limited::{describe, list, restore_all};
        let items = list().map_err(|e| Error::other(describe(&e)))?;
        let item = pick_for_unbin(&items, path, mark)
            .ok_or_else(|| Error::new(ErrorKind::NotFound, "it is not in the bin"))?;
        restore_all(vec![item]).map_err(|e| Error::other(describe(&e)))
    }
}

/// The item `TrashBin::unbin` restores. With an id, the item of that id alone: the path forms
/// are worked out again at Undo time, and a linked folder deleted or retargeted since the
/// Replace has lost its real form, though the item is still in the bin. Without an id, the
/// path forms and the time mark decide (`pick_replaced`).
fn pick_for_unbin(
    items: &[trash::TrashItem],
    path: &Path,
    mark: &BinMark,
) -> Option<trash::TrashItem> {
    match &mark.id {
        Some(id) => items
            .iter()
            .find(|i| i.id.to_string_lossy() == id.as_str())
            .cloned(),
        None => pick_replaced(items, path, mark, &[]),
    }
}

/// `TrashBin::bin` with the bin's reading (`list`) and sending (`send`) given, so a test can
/// count the reads. `seen` holds the ids after the last send of this job: when it is there it
/// is the "before" list, otherwise the bin is read once. An own-path item that appeared
/// meanwhile (another program) makes two new items, so `new_item_id` says `None` and the time
/// mark is the guide. A bin that cannot be read (the Mac Trash) leaves only the mark.
fn bin_listed(
    seen: &std::cell::RefCell<Option<std::collections::HashSet<std::ffi::OsString>>>,
    list: &dyn Fn() -> Option<Vec<trash::TrashItem>>,
    send: &dyn Fn() -> Result<()>,
    path: &Path,
) -> Result<BinMark> {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut before = seen.borrow_mut().take();
    if before.is_none() {
        before = list().map(|items| items.into_iter().map(|i| i.id).collect());
    }
    // the keys are taken while the file is still there to resolve
    let keys = PathKeys::of(path);
    send()?;
    let after = list();
    let (id, none_new) = match (&before, &after) {
        (Some(before), Some(after)) => (
            new_item_id_of(before, after, &keys),
            !after
                .iter()
                .any(|i| !before.contains(&i.id) && keys.holds(i)),
        ),
        _ => (None, false),
    };
    *seen.borrow_mut() = after.map(|items| items.into_iter().map(|i| i.id).collect());
    if none_new {
        // ⛔ (G.2 review 4, 6) Was `Binned`: the bin was read before and after, the send said
        // yes, and no item of the path appeared — the file went for good (a bin over its size
        // deletes outright). The frontend must warn it cannot come back, so it is `Lost`.
        return Err(Error::new(
            ErrorKind::Unsupported,
            ops::NoRecycleBin {
                place: BIN_WORD.to_string(),
                path: path.to_path_buf(),
                why: ops::Why::NoBin,
                paths: vec![path.to_path_buf()],
            },
        ));
    }
    Ok(BinMark { at, id })
}

/// The bin item a Replace made of the old file at `path`, marked `mark` (`Bin::bin`). With an id,
/// the item of that id and path, or none (restored or emptied since: never a guess). With no id,
/// of the items deleted from `path` at or after `mark.at`, the OLDEST — anything newer came
/// later (a later Replace, or the undo binning the copy). `taken` lists ids already picked by
/// this undo.
///
/// ⛔ Was "the newest item of the path": two Replaces of one file (v2 over v1, v3 over v2) and two
/// Undos brought back v3 — the copy the second undo had just binned — instead of v1.
pub fn pick_replaced(
    items: &[trash::TrashItem],
    path: &Path,
    mark: &BinMark,
    taken: &[std::ffi::OsString],
) -> Option<trash::TrashItem> {
    let keys = PathKeys::of(path);
    let of_path = items
        .iter()
        .filter(|i| !taken.contains(&i.id))
        .filter(|i| keys.holds(i));
    if let Some(id) = &mark.id {
        return of_path
            .filter(|i| i.id.to_string_lossy() == id.as_str())
            .min_by_key(|i| i.time_deleted)
            .cloned();
    }
    of_path
        .filter(|i| i.time_deleted >= mark.at)
        .min_by_key(|i| i.time_deleted)
        .cloned()
}

/// The id of the one item of `path` in the bin `after` that was not there `before`. `None` when
/// there is none, or more than one (something else binned that path at the same moment): the
/// mark is then the only guide. The job takes the keys before the send (`new_item_id_of`).
#[cfg(test)]
fn new_item_id(
    before: &std::collections::HashSet<std::ffi::OsString>,
    after: &[trash::TrashItem],
    path: &Path,
) -> Option<String> {
    new_item_id_of(before, after, &PathKeys::of(path))
}

/// `new_item_id` with the path's keys already taken.
fn new_item_id_of(
    before: &std::collections::HashSet<std::ffi::OsString>,
    after: &[trash::TrashItem],
    keys: &PathKeys,
) -> Option<String> {
    let mut new = after
        .iter()
        .filter(|i| !before.contains(&i.id))
        .filter(|i| keys.holds(i));
    let item = new.next()?;
    if new.next().is_some() {
        return None;
    }
    Some(item.id.to_string_lossy().into_owned())
}

/// The forms a bin item's original path can take for one file: the path as Trove holds it, and
/// the path through its real folder. The `trash` crate resolves the path before it deletes, so
/// on Linux the `.trashinfo` holds the REAL folder, and the Windows Recycle Bin does the same (a
/// live probe: a junction's target, a `subst` drive's real `C:\` path). The path as Trove holds
/// it is kept too, for a bin that stores it as given. An item is of the file when it matches
/// EITHER form.
///
/// ⛔ (G.2 review 6, 1) Only the given form was compared: a folder reached through a symlink
/// (Fedora Silverblue's `/home` -> `/var/home`, a linked `~/Documents`) made a real bin send
/// look like no item appeared — reported `Lost`, and Undo could not find the old file. Only
/// the real form would make every Windows Replace `Lost` the other way round.
struct PathKeys(Vec<String>);

impl PathKeys {
    fn of(path: &Path) -> PathKeys {
        let mut keys = vec![fold_path(path)];
        if let Some(real) = real_path(path) {
            let real = fold_path(&real);
            if !keys.contains(&real) {
                keys.push(real);
            }
        }
        PathKeys(keys)
    }

    fn holds(&self, item: &trash::TrashItem) -> bool {
        self.0.contains(&fold_path(&item.original_path()))
    }
}

/// `path` with its folder resolved (links followed, `..` gone) and its own name kept, without
/// the Windows verbatim prefix, so it reads like a path the bin would store. `None` when the
/// folder cannot be resolved.
fn real_path(path: &Path) -> Option<PathBuf> {
    let parent = path.parent().filter(|d| !d.as_os_str().is_empty())?;
    let real = fs::canonicalize(parent).ok()?.join(path.file_name()?);
    Some(plain_path(real))
}

/// A path without the Windows verbatim prefix: `\\?\C:\x` is `C:\x`, `\\?\UNC\s\x` is
/// `\\s\x`. Any other path is returned as it is, a `\\?\Volume{GUID}\x` path too (stripped, it
/// would name nothing).
fn plain_path(path: PathBuf) -> PathBuf {
    let plain = {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            Some(format!(r"\\{rest}"))
        } else {
            // only `\\?\X:` (a drive letter); `\\?\Volume{GUID}\` would be left naming nothing
            text.strip_prefix(r"\\?\")
                .filter(|rest| {
                    let mut chars = rest.chars();
                    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                        && chars.next() == Some(':')
                })
                .map(str::to_string)
        }
    };
    plain.map(PathBuf::from).unwrap_or(path)
}

/// A path as compared with a bin item's: case folded where names are case-blind (Windows).
fn fold_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.into_owned()
    }
}

/// What the bin is called in a sentence about a file left in it.
#[cfg(windows)]
const BIN_WORD: &str = "Recycle Bin";
#[cfg(not(windows))]
const BIN_WORD: &str = "Trash";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub job_id: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// The file being copied right now.
    pub current: String,
}

/// What a failure is, which decides what Retry does with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureKind {
    /// A file or link that did not arrive. Retry sends it again with the job's own answer.
    File,
    /// A folder that did not arrive whole, on its way to `destination\name`. Retry merges it
    /// there (Replace): a Skip would skip the half-copied folder and do nothing, a Keep both
    /// would start a second one beside it.
    Folder,
    /// A top-level folder whose copy took a new name (Keep both, a copy into its own folder) and
    /// did not arrive whole. Merging into `destination\name` would write into ANOTHER folder —
    /// the one the person kept — so Retry makes a fresh copy with the job's answer instead.
    NewFolder,
    /// It arrived, but the move could not delete the original. Retry deletes only the original.
    NotRemoved,
}

/// One file or folder the job could not carry. The job went on past it; Retry sends `path`
/// into `destination` again — the folder it was on its way to, which for an item deep in a
/// tree is that tree's copy (`dest\src\sub`), not the job's destination. For `NotRemoved`,
/// `destination` is the folder its copy arrived in, and `copy` the copy itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferFailure {
    pub path: String,
    pub destination: String,
    pub error: String,
    pub kind: FailureKind,
    /// `NotRemoved` only: the full path of the copy that arrived. A Keep-both copy is NOT
    /// `destination\<original name>` — that is the other file, the one the person kept — so
    /// the retry checks this path and never guesses it from the name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<String>,
}

/// The top-level source a cancel stopped partway, and exactly what the job had created for it
/// at the destination by then — what an undo removes. A move that is cancelled partway never
/// deletes any of that source (it deletes only after a whole item arrived), so removing these
/// copies puts everything back as it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialOutput {
    /// The top-level source it was carrying.
    pub from: String,
    /// Where that source was going.
    pub to: String,
    /// The topmost entries this job created there, in the order it created them: a folder that
    /// is new stands for everything in it, so only entries placed in folders that were already
    /// there are listed on their own. Nothing that existed before the job is ever listed; a
    /// file that a Replace wrote over is not either (it is not new).
    pub created: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferDone {
    pub job_id: u64,
    pub outputs: Vec<TransferOutput>,
    /// Everything that did not arrive, in the order it was met. Empty on a clean finish.
    pub failed: Vec<TransferFailure>,
    /// A refusal that stopped the job before it began, or a summary of `failed` and of links
    /// that could not be recreated ("2 of 30 items could not be copied").
    pub error: Option<String>,
    pub cancelled: bool,
    /// A cancel only: the item it stopped in the middle of, with what had landed of it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial: Option<PartialOutput>,
}

/// How two names in one folder compare. Lower-cased everywhere, even on a case-sensitive WSL
/// share: there it can only call two different names "the same", which costs a Keep-both
/// rename — never a lost file.
///
/// A name that is not Unicode (bytes that are not UTF-8 on Linux, a lone surrogate on NTFS) is
/// keyed by its escaped form, not its lossy text: `b\xFF.txt` and `b\xFE.txt` both read
/// `b�.txt`, and were refused as "the same name in another case" though they are two files.
/// The escape keeps each bad byte distinct and still lower-cases the letters around it; the
/// leading NUL, which no real name holds, keeps it from matching a name that spells it out.
fn name_key(name: &std::ffi::OsStr) -> String {
    match name.to_str() {
        Some(text) => text.to_lowercase(),
        None => format!("\0{name:?}").to_lowercase(),
    }
}

/// The destination paths these sources would collide on — what the conflict dialog asks about
/// before a job starts. That is a target that already exists, and also a name two sources of
/// this one job share (`A\x.txt` and `B\x.txt`): nothing is there yet, but the second would
/// land on the first. Each path is listed once.
///
/// A source pasted back into its own folder is never a conflict: a copy becomes a new copy
/// beside it and a move (cut) of it does nothing — Explorer and Finder ask nothing either.
pub fn conflicts(sources: &[PathBuf], destination: &Path) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut listed = HashSet::new();
    let mut found = Vec::new();
    let elsewhere = sources.iter().filter(|s| !in_place(s, destination));
    for name in elsewhere.filter_map(|s| s.file_name()) {
        let target = destination.join(name);
        let duplicate = !seen.insert(name_key(name));
        if (duplicate || target.exists()) && listed.insert(name_key(name)) {
            found.push(target.to_string_lossy().into_owned());
        }
    }
    found
}

/// Progress accounting shared by the whole job; emits at most every 100 ms.
struct Progress<'a> {
    job_id: u64,
    done: u64,
    total: u64,
    current: String,
    last: Option<Instant>,
    sink: &'a dyn Fn(TransferProgress),
    cancel: &'a AtomicBool,
    /// Where a replaced file goes (`BinFn`).
    bin: BinFn<'a>,
    /// The existing file the current top-level item replaces, until it has been binned: set by
    /// `transfer_one`, taken by `bin_old` just before the new file is renamed over it.
    replacing: Option<PathBuf>,
    /// What `bin_old` did with it, for this item's `TransferOutput::replaced`.
    replaced: Option<Replaced>,
    /// The bin's mark for it, when binned (`TransferOutput::binned_at`, `binned_id`).
    binned: Option<BinMark>,
    /// How a move puts its source into place in one step; `fs::rename`, a failing one in tests
    /// (a move across drives).
    rename: fn(&Path, &Path) -> Result<()>,
    /// How a Replace by move parks its source beside the target (`park_beside`): a rename that
    /// never writes over anything (`parked::rename_no_replace`); a racing one in tests.
    park: fn(&Path, &Path) -> Result<()>,
    /// Notes a park in the journal before it happens (`parked::add`); `false` (it could not)
    /// means no park. A failing one in tests.
    note_park: fn(&parked::Entry) -> bool,
    /// Links met inside a tree that could not be recreated at the target (a symlink needs
    /// Developer Mode or admin). The job reports them, and a move keeps any source holding one.
    links_left: Vec<String>,
    /// What could not be carried; the job records it and goes on (see `TransferFailure`).
    failed: Vec<TransferFailure>,
    /// The real path of each entry in `failed`, same order. The text in `failed` is for the
    /// person: a name that is not valid Unicode (an unpaired UTF-16 surrogate on Windows, a
    /// non-UTF-8 byte on Unix) changes on the way to text, so text is never compared with a path.
    failed_paths: Vec<PathBuf>,
    /// A move's source entries that arrived whole, in the order they did: each file or link
    /// after its copy completed, each folder after its whole subtree did (children first).
    /// Kept only for a move (`track_arrived`); it is all that `remove_arrived` may delete.
    arrived: Vec<PathBuf>,
    track_arrived: bool,
    /// Files, links and unreadable entries counted while sizing — the "of M" in the summary.
    items: u64,
    /// The topmost entries the current top-level item has created at the destination, in
    /// order (see `PartialOutput::created`); `created_set` is the same, for lookups.
    created: Vec<PathBuf>,
    created_set: HashSet<PathBuf>,
    /// Set when a cancel stops a top-level item partway (see `PartialOutput`).
    partial: Option<PartialOutput>,
}

impl Progress<'_> {
    /// Record that `path` could not be carried into `destination`. Once per path — compared
    /// as a path, never as text: a folder that cannot be listed is met by the walk and again
    /// by the caller.
    fn fail(&mut self, path: &Path, destination: &Path, e: &Error, kind: FailureKind) {
        self.record(path, destination, e, kind, None);
    }

    /// `path` arrived as `copy`, but the original could not be deleted.
    fn not_removed(&mut self, path: &Path, copy: &Path, e: &Error) {
        let into = copy.parent().unwrap_or(copy).to_path_buf();
        self.record(path, &into, e, FailureKind::NotRemoved, Some(copy));
    }

    fn record(
        &mut self,
        path: &Path,
        destination: &Path,
        e: &Error,
        kind: FailureKind,
        copy: Option<&Path>,
    ) {
        if self.failed_paths.iter().any(|f| f == path) {
            return;
        }
        self.failed_paths.push(path.to_path_buf());
        self.failed.push(TransferFailure {
            path: path.to_string_lossy().into_owned(),
            destination: destination.to_string_lossy().into_owned(),
            error: e.to_string(),
            kind,
            copy: copy.map(|c| c.to_string_lossy().into_owned()),
        });
    }

    /// `path` (a file, a link, or a folder with everything in it) arrived whole.
    fn arrive(&mut self, path: &Path) {
        if self.track_arrived {
            self.arrived.push(path.to_path_buf());
        }
    }

    /// `path` did not exist before and this job made it. Listed only when no folder above it
    /// is itself new — that folder already stands for it.
    fn created(&mut self, path: &Path) {
        if !path
            .ancestors()
            .skip(1)
            .any(|a| self.created_set.contains(a))
        {
            self.created_set.insert(path.to_path_buf());
            self.created.push(path.to_path_buf());
        }
    }

    /// Whether `e` is the cancel flag talking (stop everything) rather than one bad entry.
    fn is_cancel(&self, e: &Error) -> bool {
        e.kind() == ErrorKind::Interrupted && self.cancel.load(Ordering::Relaxed)
    }

    fn snapshot(&self) -> TransferProgress {
        TransferProgress {
            job_id: self.job_id,
            bytes_done: self.done,
            bytes_total: self.total,
            current: self.current.clone(),
        }
    }

    fn emit(&mut self) {
        self.last = Some(Instant::now());
        (self.sink)(self.snapshot());
    }

    fn add(&mut self, bytes: u64) {
        self.done += bytes;
        if self.last.is_none_or(|t| t.elapsed() >= PROGRESS_EVERY) {
            self.emit();
        }
    }

    fn check_cancel(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(Error::new(ErrorKind::Interrupted, "cancelled"))
        } else {
            Ok(())
        }
    }
}

/// Run one job to completion or cancellation. A file or folder that cannot be carried is
/// recorded in `failed` and the job goes on with the rest; only a cancel, or a refusal before
/// any byte moves, stops it. Never panics on I/O. The app starts jobs with `run_job_as`; this
/// is its every-source-keeps-its-name form, for the tests.
#[cfg(test)]
pub fn run_job(
    job_id: u64,
    sources: &[PathBuf],
    destination: &Path,
    mode: TransferMode,
    resolution: Resolution,
    cancel: &AtomicBool,
    sink: &dyn Fn(TransferProgress),
) -> TransferDone {
    // never the real bin in a test: a bin that refuses, so a Replace overwrites (`Lost`)
    run_job_binning(
        job_id,
        sources,
        destination,
        None,
        mode,
        resolution,
        cancel,
        sink,
        &NoBin,
    )
}

/// A place with no bin: every Replace overwrites (`Lost`). The default bin of the tests.
#[cfg(test)]
struct NoBin;

#[cfg(test)]
impl Bin for NoBin {
    fn bin(&self, path: &Path) -> Result<BinMark> {
        Err(Error::new(
            ErrorKind::Unsupported,
            ops::NoRecycleBin {
                place: "tests".into(),
                path: path.to_path_buf(),
                why: ops::Why::NoBin,
                paths: vec![path.to_path_buf()],
            },
        ))
    }

    fn unbin(&self, _: &Path, _: &BinMark) -> Result<()> {
        Err(Error::other("no bin in tests"))
    }
}

/// `run_job`, with each source landing under the name `names` gives it instead of its own
/// (same order, one per source). Undo of a Keep-both move uses it: `a (2).txt` goes back to
/// its folder as `a.txt`, and with Skip, so a new `a.txt` there is never overwritten.
/// Each name must be one plain file name (no folder, no `..`); otherwise nothing moves.
#[allow(clippy::too_many_arguments)]
pub fn run_job_as(
    job_id: u64,
    sources: &[PathBuf],
    destination: &Path,
    names: Option<&[String]>,
    mode: TransferMode,
    resolution: Resolution,
    cancel: &AtomicBool,
    sink: &dyn Fn(TransferProgress),
) -> TransferDone {
    run_job_binning(
        job_id,
        sources,
        destination,
        names,
        mode,
        resolution,
        cancel,
        sink,
        &TrashBin::default(),
    )
}

/// `run_job_as` with the bin a Replace sends the old file to given (`BinFn`).
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_job_binning(
    job_id: u64,
    sources: &[PathBuf],
    destination: &Path,
    names: Option<&[String]>,
    mode: TransferMode,
    resolution: Resolution,
    cancel: &AtomicBool,
    sink: &dyn Fn(TransferProgress),
    bin: BinFn,
) -> TransferDone {
    let mut progress = Progress {
        job_id,
        done: 0,
        total: 0,
        current: String::new(),
        last: None,
        sink,
        cancel,
        bin,
        replacing: None,
        replaced: None,
        binned: None,
        rename: |from, to| fs::rename(from, to),
        park: parked::rename_no_replace,
        note_park: parked::add,
        links_left: Vec::new(),
        failed: Vec::new(),
        failed_paths: Vec::new(),
        arrived: Vec::new(),
        track_arrived: mode == TransferMode::Move,
        items: 0,
        created: Vec::new(),
        created_set: HashSet::new(),
        partial: None,
    };
    let mut outputs = Vec::new();
    let result = landing_names(sources, names).and_then(|names| {
        run(
            sources,
            &names,
            destination,
            mode,
            resolution,
            &mut progress,
            &mut outputs,
        )
    });
    let (refused, cancelled) = match result {
        Ok(()) => (None, false),
        Err(e) if e.kind() == ErrorKind::Interrupted => (None, true),
        Err(e) => (Some(e.to_string()), false),
    };
    // the job ran, but not everything arrived: say so rather than report a clean finish over
    // a folder that is missing files or links
    let mut problems: Vec<String> = refused.into_iter().collect();
    let not_removed = progress
        .failed
        .iter()
        .filter(|f| f.kind == FailureKind::NotRemoved)
        .count() as u64;
    let n = progress.failed.len() as u64 - not_removed;
    if n > 0 {
        let verb = match mode {
            TransferMode::Copy => "copied",
            TransferMode::Move => "moved",
        };
        problems.push(format!(
            "{n} of {} items could not be {verb}",
            progress.items.max(n)
        ));
    }
    if not_removed > 0 {
        problems.push(format!(
            "{not_removed} item(s) arrived, but the original could not be deleted"
        ));
    }
    if !progress.links_left.is_empty() {
        let kept = match mode {
            TransferMode::Move => "; the folders holding them were left where they were",
            TransferMode::Copy => "",
        };
        problems.push(format!(
            "{} link(s) could not be copied{kept}: {}",
            progress.links_left.len(),
            progress.links_left.join(", ")
        ));
    }
    TransferDone {
        job_id,
        outputs,
        failed: progress.failed,
        error: (!problems.is_empty()).then(|| problems.join(". ")),
        cancelled,
        partial: progress.partial,
    }
}

/// The name each source lands under: its own, or the one `names` gives it (see `run_job_as`).
fn landing_names(sources: &[PathBuf], names: Option<&[String]>) -> Result<Vec<std::ffi::OsString>> {
    let invalid = |why: String| Error::new(ErrorKind::InvalidInput, why);
    match names {
        None => sources
            .iter()
            .map(|s| {
                s.file_name()
                    .map(|n| n.to_os_string())
                    .ok_or_else(|| invalid("Cannot transfer a drive root".into()))
            })
            .collect(),
        Some(names) if names.len() != sources.len() => Err(invalid(format!(
            "{} names for {} items",
            names.len(),
            sources.len()
        ))),
        Some(names) => names
            .iter()
            .map(|n| {
                let mut parts = Path::new(n).components();
                match (parts.next(), parts.next()) {
                    (Some(std::path::Component::Normal(one)), None) if one == n.as_str() => {
                        Ok(one.to_os_string())
                    }
                    _ => Err(invalid(format!("{n:?} is not a plain file name"))),
                }
            })
            .collect(),
    }
}

fn run(
    sources: &[PathBuf],
    names: &[std::ffi::OsString],
    destination: &Path,
    mode: TransferMode,
    resolution: Resolution,
    progress: &mut Progress,
    outputs: &mut Vec<TransferOutput>,
) -> Result<()> {
    for source in sources {
        refuse_own_subtree(source, destination)?;
    }
    if resolution == Resolution::Replace {
        refuse_replacing_a_path_link(sources, destination)?;
    }
    let mut items = 0;
    let sizes: Vec<u64> = sources.iter().map(|s| size_of(s, &mut items)).collect();
    progress.total = sizes.iter().sum();
    progress.items = items;
    progress.emit();

    // Names this job has already landed in `destination`. A later source with the same name
    // never Skips or Replaces one of these — it was not there when the person chose, and
    // replacing it would destroy the earlier source's data (gone already, on a move).
    // A source pasted into its own folder counts as landed from the start: another source of
    // the job with its name must not Replace it before (or after) it is copied.
    let mut landed: HashSet<String> = sources
        .iter()
        .zip(names)
        .filter(|(s, name)| in_place_as(s, destination, name))
        .map(|(_, name)| name_key(name))
        .collect();
    for ((source, name), size) in sources.iter().zip(names).zip(sizes) {
        progress.check_cancel()?;
        match transfer_one(
            source,
            name,
            size,
            destination,
            mode,
            resolution,
            &mut landed,
            progress,
        ) {
            Ok(Some(output)) => outputs.push(output),
            Ok(None) => {}
            Err(e) if progress.is_cancel(&e) => return Err(e),
            Err(e) => {
                // whatever part of it reached the destination keeps its name taken: a later
                // source of the same name goes beside it, never onto it
                landed.insert(name_key(name));
                let kind = kind_of(source, &destination.join(name));
                progress.fail(source, destination, &e, kind);
            }
        }
    }
    progress.emit();
    Ok(())
}

/// One top-level source: pick its target, carry it, and say where it landed — `None` when it
/// was skipped or is already where it was asked to go. An error means it did not land.
#[allow(clippy::too_many_arguments)]
fn transfer_one(
    source: &Path,
    name: &std::ffi::OsStr,
    size: u64,
    destination: &Path,
    mode: TransferMode,
    resolution: Resolution,
    landed: &mut HashSet<String>,
    progress: &mut Progress,
) -> Result<Option<TransferOutput>> {
    let is_dir = source.is_dir();
    let keep_both = || {
        destination.join(ops::unique_name(
            destination,
            &name.to_string_lossy(),
            is_dir,
        ))
    };
    let mut onto_old = false;
    let target = if in_place_as(source, destination, name) {
        match mode {
            // pasted where it already is: a new copy beside it, the platform's way
            TransferMode::Copy => destination.join(ops::copy_name(
                destination,
                &name.to_string_lossy(),
                is_dir,
                ops::CopyStyle::HOST,
            )),
            // cut and pasted where it already is: it is there; nothing to do
            TransferMode::Move => {
                progress.add(size);
                return Ok(None);
            }
        }
    } else if landed.contains(&name_key(name)) {
        keep_both()
    } else {
        match (destination.join(name).exists(), resolution) {
            (false, _) => destination.join(name),
            (true, Resolution::Replace) => {
                onto_old = true;
                destination.join(name)
            }
            (true, Resolution::Skip) => {
                progress.add(size);
                return Ok(None);
            }
            (true, Resolution::KeepBoth) => keep_both(),
        }
    };
    progress.current = source.to_string_lossy().into_owned();
    if resolution == Resolution::Replace {
        clear_folder_link(source, &target)?;
    }
    progress.created.clear();
    progress.created_set.clear();
    // a file onto a file: the old one goes to the bin just before the new one takes its place
    // (`bin_old`). A folder Replace merges and overwrites nothing whole, so it is not binned.
    // ⛔ Nor is a target that IS the source reached by another path (`\\localhost\C$\x\a.txt`
    // onto `C:\x`, a hard link): `in_place_as` compares paths and misses it, and binning the
    // "old" file would bin the very file being moved.
    let is_file = |p: &Path| fs::symlink_metadata(p).is_ok_and(|m| m.is_file());
    let is_itself = || fs::symlink_metadata(source).is_ok_and(|m| is_same(source, &m, &target));
    progress.replacing =
        (onto_old && is_file(source) && is_file(&target) && !is_itself()).then(|| target.clone());
    progress.replaced = None;
    progress.binned = None;
    let carried = match mode {
        TransferMode::Copy => copy_any(source, &target, progress),
        TransferMode::Move => move_any(source, &target, size, progress),
    };
    if let Some(landed_as) = target.file_name() {
        landed.insert(name_key(landed_as));
    }
    landed.insert(name_key(name));
    if let Err(e) = carried {
        if progress.is_cancel(&e) {
            // ⛔ a cancel in the middle of a tree used to leave the part that landed with no
            // undo at all: say exactly what this job made, so an undo can take that away
            if !progress.created.is_empty() {
                progress.partial = Some(PartialOutput {
                    from: source.to_string_lossy().into_owned(),
                    to: target.to_string_lossy().into_owned(),
                    created: progress
                        .created
                        .iter()
                        .map(|c| c.to_string_lossy().into_owned())
                        .collect(),
                });
            }
            return Err(e);
        }
        // recorded against the target it was given, so a renamed folder is told apart
        progress.fail(source, destination, &e, kind_of(source, &target));
        return Ok(None);
    }
    progress.replacing = None;
    Ok(Some(TransferOutput {
        from: source.to_string_lossy().into_owned(),
        to: target.to_string_lossy().into_owned(),
        replaced: progress.replaced.take(),
        binned_at: progress.binned.as_ref().map(|m| m.at),
        binned_id: progress.binned.take().and_then(|m| m.id),
    }))
}

/// Just before a Replace renames the new file over `target`: send the old file to the bin, so
/// the Undo can bring it back. Only the file `transfer_one` marked (`Progress::replacing`), once.
///
/// Done at the last moment, after the new bytes are whole: a copy that fails or is cancelled
/// midway still leaves the old file where it was. A place with no bin (a share, USB, WSL, a bin
/// turned off or too small: `ops::NoRecycleBin`) does not stop the Replace: the old file is
/// overwritten as it always was, and `Lost` tells the frontend to say it cannot come back.
///
/// ⛔ Any OTHER bin error (the file is open elsewhere, access denied…) fails the item and keeps
/// the old file: it used to count as "no bin" too, and the old file was overwritten for good.
fn bin_old(target: &Path, progress: &mut Progress) -> Result<()> {
    if progress.replacing.as_deref() != Some(target) {
        return Ok(());
    }
    progress.replacing = None;
    match progress.bin.bin(target) {
        Ok(mark) => {
            progress.replaced = Some(Replaced::Binned);
            progress.binned = Some(mark);
        }
        Err(e) if is_bin_less(&e) => progress.replaced = Some(Replaced::Lost),
        Err(e) => {
            return Err(Error::new(
                e.kind(),
                format!("the file it would replace could not go to the {BIN_WORD}, so nothing was replaced: {e}"),
            ))
        }
    }
    Ok(())
}

/// Whether a bin error means the place has no bin at all, so overwriting with no undo is the
/// promised outcome (`Replaced::Lost`).
///
/// ⛔ Was every `NoRecycleBin`, including the Mac's `Why::Denied` (Finder automation refused
/// Trove): the conflict dialog had just promised the Trash, and the old file was overwritten
/// for good. Denied is a bin that exists but said no, so it fails the item like any other.
fn is_bin_less(e: &Error) -> bool {
    ops::no_recycle_bin(e).is_some_and(|n| n.why != ops::Why::Denied)
}

/// The new file could not take the old one's place (`e`) after the old one went to the bin:
/// bring the old one back. If the bin will not give it back, the error says where it is.
///
/// ⛔ Was silent loss: the old file sat in the bin, the new one never arrived, and the item
/// error said nothing about either.
fn put_old_back(target: &Path, progress: &mut Progress, e: Error) -> Error {
    if progress.replaced != Some(Replaced::Binned) {
        return e;
    }
    progress.replaced = None;
    let mark = progress.binned.take().unwrap_or_default();
    match progress.bin.unbin(target, &mark) {
        Ok(()) => e,
        Err(_) => Error::new(
            e.kind(),
            format!("{e}. The file it was replacing is in the {BIN_WORD}: put it back from there"),
        ),
    }
}

/// Replace onto a link that leads to a folder replaces the LINK. Left in place, the folder
/// merge would write through it into its target, and a move would then delete the source.
/// Only the link is removed (`remove_entry`), never what it points at. A link to a file needs
/// no help: the file replace renames over the link itself.
fn clear_folder_link(source: &Path, target: &Path) -> Result<()> {
    let Ok(meta) = fs::symlink_metadata(target) else {
        return Ok(());
    };
    let source_is_tree = fs::symlink_metadata(source).is_ok_and(|m| m.is_dir());
    if meta.file_type().is_symlink() && (source_is_tree || ops::is_dir_link(&meta)) {
        ops::remove_entry(target)?;
    }
    Ok(())
}

/// Replace removes a link standing at `destination\name` (`clear_folder_link`). If some source's
/// own path runs through that link (`dest\L\x` where `dest\L` is a junction), removing it would
/// cut the source off mid-job and lose the link. Refused before anything is touched. Compared
/// with `same_entry` on each source's ancestors, not by resolving the link: a source that lives
/// in the link's target by another route (`X\L` while `dest\L` leads to `X`) is fine.
fn refuse_replacing_a_path_link(sources: &[PathBuf], destination: &Path) -> Result<()> {
    for name in sources.iter().filter_map(|s| s.file_name()) {
        let t = destination.join(name);
        if !fs::symlink_metadata(&t).is_ok_and(|m| m.file_type().is_symlink()) {
            continue;
        }
        for source in sources {
            if source.ancestors().skip(1).any(|a| same_entry(a, &t)) {
                return Err(Error::new(
                    ErrorKind::InvalidInput,
                    format!(
                        "Cannot replace {}: it is a link, and {} is reached through it",
                        t.display(),
                        source.display()
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// `C:\a` into `C:\a` or `C:\a\b` can never finish; Explorer refuses it before starting.
fn refuse_own_subtree(source: &Path, destination: &Path) -> Result<()> {
    // a real folder only: a link is copied or moved as the link, so it cannot contain its own
    // destination, and `is_dir` would follow it to its target
    if !fs::symlink_metadata(source).is_ok_and(|m| m.is_dir()) {
        return Ok(());
    }
    let src = fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    let dst = fs::canonicalize(destination).unwrap_or_else(|_| destination.to_path_buf());
    if dst.starts_with(&src) {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "The destination folder is a subfolder of the source folder",
        ));
    }
    Ok(())
}

/// Whether `source` is being pasted into the folder it is already in (`destination\name` IS
/// it — case folded on Windows, see `same_entry`). `run` never writes onto such a source,
/// whatever was answered: a copy takes a new copy name, a move is skipped.
///
/// ⛔ Replace onto the source itself used to be data loss: a copy truncated the target, which
/// was the source, before reading it (a 0-byte file), and a folder took the merge path whose
/// last step is `remove_dir_all(source)`. It was then refused with an error; now it never
/// reaches a write at all.
fn in_place(source: &Path, destination: &Path) -> bool {
    source
        .file_name()
        .is_some_and(|name| in_place_as(source, destination, name))
}

/// `in_place` for a source landing under `name` (see `run_job_as`).
fn in_place_as(source: &Path, destination: &Path, name: &std::ffi::OsStr) -> bool {
    same_entry(source, &destination.join(name))
}

/// Whether two paths name one entry: same canonical folder (which resolves `..`, junctions on
/// the way and, on NTFS, the on-disk letter case) and same name, compared without case on
/// Windows. The entry itself is not followed if it is a link — only its folder is resolved —
/// so a link and its target do not count as one.
fn same_entry(a: &Path, b: &Path) -> bool {
    fn resolved(p: &Path) -> Option<PathBuf> {
        let parent = p.parent().filter(|d| !d.as_os_str().is_empty())?;
        Some(fs::canonicalize(parent).ok()?.join(p.file_name()?))
    }
    let (Some(a), Some(b)) = (resolved(a), resolved(b)) else {
        return false;
    };
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// Bytes under `path`: a file's length, or every file in a tree; `items` counts the files,
/// links and unreadable entries met. Links are not followed — a junction to a parent cannot
/// loop, and a link is copied as a link, so its target's bytes never move and are not counted.
///
/// Something that cannot be read counts 0 bytes and one item, and the job goes on. It is not
/// recorded as failed here: the copy meets it again and records it then — and a move by
/// `rename` carries an unlistable folder whole, so it never fails at all.
fn size_of(path: &Path, items: &mut u64) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        *items += 1;
        return 0;
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        *items += 1;
        return if meta.file_type().is_symlink() {
            0
        } else {
            meta.len()
        };
    }
    let Ok(entries) = fs::read_dir(path) else {
        *items += 1;
        return 0;
    };
    capped(entries)
        .map(|entry| match entry {
            Ok(entry) => size_of(&entry.path(), items),
            Err(_) => {
                *items += 1;
                0
            }
        })
        .sum()
}

/// A folder listing that ends after `LISTING_ERRORS_MAX` errors in a row. A walk goes on past
/// an entry it cannot read, so a listing that returns the same error forever would never end.
struct Capped<I> {
    inner: I,
    errors_in_a_row: u32,
}

impl<T, I: Iterator<Item = Result<T>>> Iterator for Capped<I> {
    type Item = Result<T>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.errors_in_a_row >= LISTING_ERRORS_MAX {
            return None;
        }
        let item = self.inner.next()?;
        self.errors_in_a_row = if item.is_err() {
            self.errors_in_a_row + 1
        } else {
            0
        };
        Some(item)
    }
}

fn capped<I>(inner: I) -> Capped<I> {
    Capped {
        inner,
        errors_in_a_row: 0,
    }
}

/// What a failure of `source` on its way to `target` is (see `FailureKind`). A real folder is
/// a `Folder` when it was going to its own name, a `NewFolder` when it took another.
fn kind_of(source: &Path, target: &Path) -> FailureKind {
    if !fs::symlink_metadata(source).is_ok_and(|m| m.is_dir()) {
        FailureKind::File
    } else if source.file_name() == target.file_name() {
        FailureKind::Folder
    } else {
        FailureKind::NewFolder
    }
}

fn copy_any(source: &Path, target: &Path, progress: &mut Progress) -> Result<()> {
    let meta = fs::symlink_metadata(source)?;
    if meta.file_type().is_symlink() {
        copy_link(source, target, &meta)?;
        progress.created(target);
    } else if meta.is_dir() {
        return copy_dir(source, target, progress);
    } else {
        copy_file(source, target, progress)?;
    }
    progress.arrive(source);
    Ok(())
}

/// A tree, entry by entry. Nothing inside it fails the copy: a file or folder that cannot be
/// carried is recorded in `failed` and the walk goes on, and a link that cannot be recreated
/// is recorded in `links_left` — so everything else still arrives, the job says what did not,
/// and a move keeps the sources that still hold it. Only a cancel stops the walk.
///
/// The folder counts as arrived (`Progress::arrive`) only when everything in it did.
///
/// ⛔ Two refusals that were data loss on a move:
/// - a link (junction, symlink) standing at `target` is never merged into: `create_dir_all`
///   accepts it, the files were "copied" through it onto themselves (a junction back into the
///   source), and the delete half then removed the only copy. The folder fails and stays.
/// - two entries whose names fold to one (`a.txt` and `A.txt` from a case-sensitive folder)
///   would land on one file in a case-blind destination: the second overwrote the first, both
///   counted as arrived, both were deleted. The second fails and stays in the source.
fn copy_dir(source: &Path, target: &Path, progress: &mut Progress) -> Result<()> {
    if fs::symlink_metadata(target).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(Error::new(
            ErrorKind::AlreadyExists,
            format!(
                "{} is a link; a folder is not merged through it",
                target.display()
            ),
        ));
    }
    let fresh = is_free(target);
    fs::create_dir_all(target)?;
    if fresh {
        progress.created(target);
    }
    let failed_before = progress.failed.len();
    let left_before = progress.links_left.len();
    let mut names = HashSet::new();
    for entry in capped(fs::read_dir(source)?) {
        progress.check_cancel()?;
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                // the listing broke off partway: the folder as a whole did not arrive
                let into = target.parent().unwrap_or(target);
                progress.fail(source, into, &e, kind_of(source, target));
                continue;
            }
        };
        let from = entry.path();
        let to = target.join(entry.file_name());
        if !names.insert(name_key(&entry.file_name())) {
            let e = Error::new(
                ErrorKind::AlreadyExists,
                "another item in its folder has the same name in another case",
            );
            progress.fail(&from, target, &e, kind_of(&from, &to));
            continue;
        }
        let result = match fs::symlink_metadata(&from) {
            Err(e) => Err(e),
            Ok(meta) if meta.file_type().is_symlink() => {
                match copy_link(&from, &to, &meta) {
                    Ok(()) => {
                        progress.created(&to);
                        progress.arrive(&from);
                    }
                    Err(e) => progress
                        .links_left
                        .push(format!("{} ({e})", from.display())),
                }
                Ok(())
            }
            Ok(meta) if meta.is_dir() => copy_dir(&from, &to, progress),
            Ok(_) => {
                progress.current = from.to_string_lossy().into_owned();
                copy_file(&from, &to, progress).map(|()| progress.arrive(&from))
            }
        };
        match result {
            Err(e) if progress.is_cancel(&e) => return Err(e),
            Err(e) => progress.fail(&from, target, &e, kind_of(&from, &to)),
            Ok(()) => {}
        }
    }
    if progress.failed.len() == failed_before && progress.links_left.len() == left_before {
        progress.arrive(source);
    }
    Ok(())
}

/// Whether nothing at all stands at `path` - checked before the job makes something there, to
/// know the job made it. Only "not found" counts: an entry that merely cannot be read is
/// treated as there, so it can never be listed as new and removed by an undo.
fn is_free(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path), Err(e) if e.kind() == ErrorKind::NotFound)
}

/// Recreate the link `source` at `target`, pointing where it points (a relative symlink stays
/// relative). A junction is remade as a junction — no privilege needed. A symlink needs
/// Developer Mode or admin; without it this fails and the caller records the link as left.
fn copy_link(source: &Path, target: &Path, meta: &fs::Metadata) -> Result<()> {
    let points_at = fs::read_link(source)?;
    #[cfg(windows)]
    {
        if ops::is_dir_link(meta) {
            if is_junction(source) {
                make_junction(target, &points_at)
            } else {
                std::os::windows::fs::symlink_dir(&points_at, target)
            }
        } else {
            std::os::windows::fs::symlink_file(&points_at, target)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        std::os::unix::fs::symlink(&points_at, target)
    }
}

/// A junction (`IO_REPARSE_TAG_MOUNT_POINT`) rather than a directory symlink. std calls both
/// `is_symlink`; only the reparse tag tells them apart, and `FindFirstFileW` reports it.
#[cfg(windows)]
fn is_junction(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{FindClose, FindFirstFileW, WIN32_FIND_DATAW};
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call; `data` is plain old data the call
    // fills; the handle is closed before returning.
    unsafe {
        let mut data: WIN32_FIND_DATAW = std::mem::zeroed();
        let handle = FindFirstFileW(wide.as_ptr(), &mut data);
        if handle == INVALID_HANDLE_VALUE {
            return false;
        }
        FindClose(handle);
        data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            && data.dwReserved0 == IO_REPARSE_TAG_MOUNT_POINT
    }
}

/// `mklink /J`: Win32 has no call that makes a junction short of hand-building a reparse
/// buffer for `DeviceIoControl`, and cmd's built-in does exactly that. No console flashes.
#[cfg(windows)]
fn make_junction(link: &Path, points_at: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // `read_link` hands a junction's target back verbatim (`\\?\C:\…`); mklink wants it plain
    let text = points_at.to_string_lossy();
    let plain = text.strip_prefix(r"\\?\").unwrap_or(&text);
    let out = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(plain)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(Error::other(format!(
            "could not make the junction: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

/// Clear or set the read-only bit. `set_readonly(false)` is what Clippy warns about (on Unix it
/// makes a file world-writable); on Windows it clears exactly the one attribute we mean.
fn set_readonly(path: &Path, readonly: bool) -> Result<()> {
    let mut perm = fs::metadata(path)?.permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    perm.set_readonly(readonly);
    fs::set_permissions(path, perm)
}

/// The half-written copy beside its target. Dropped without `keep()` — any error, a cancel,
/// a panic — it deletes itself, so a failed Replace leaves the old file and nothing else.
pub(crate) struct Partial {
    pub(crate) path: PathBuf,
    pub(crate) armed: bool,
}

impl Partial {
    pub(crate) fn keep(mut self) {
        self.armed = false;
    }
}

impl Drop for Partial {
    fn drop(&mut self) {
        if self.armed {
            // it may already carry the source's read-only bit, which `remove_file` refuses
            let _ = set_readonly(&self.path, false);
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// 1 MB buffered copy that counts bytes, honours the cancel flag between buffers, and carries
/// the modified time and the read-only bit over.
///
/// ⛔ Never written in place. The bytes go to `.<name>.trove-partial` beside the target and
/// replace it in one `rename` only when whole, so a cancel, a full disk or a read error midway
/// leaves the old target exactly as it was (bytes and read-only bit) and the partial deleted.
/// Writing straight into the target used to truncate it first and lose it on any failure.
fn copy_file(source: &Path, target: &Path, progress: &mut Progress) -> Result<()> {
    let fresh = is_free(target);
    let mut from = File::open(source)?;
    let meta = from.metadata()?;
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let partial = Partial {
        path: dir.join(ops::unique_name(
            dir,
            &format!(".{name}.trove-partial"),
            false,
        )),
        armed: true,
    };
    let mut to = File::options()
        .write(true)
        .create_new(true)
        .open(&partial.path)?;
    let mut buf = vec![0u8; BUFFER];
    loop {
        progress.check_cancel()?;
        let n = from.read(&mut buf)?;
        if n == 0 {
            break;
        }
        to.write_all(&buf[..n])?;
        progress.add(n as u64);
    }
    to.flush()?;
    if let Ok(modified) = meta.modified() {
        let _ = to.set_modified(modified);
    }
    drop(to);
    if meta.permissions().readonly() {
        // a read-only file can still be renamed; only the target's bit is in the way
        set_readonly(&partial.path, true)?;
    }
    bin_old(target, progress)?;
    replace_with(&partial.path, target).map_err(|e| put_old_back(target, progress, e))?;
    partial.keep();
    if fresh {
        progress.created(target);
    }
    Ok(())
}

/// Rename `from` over `target`. A read-only target refuses to be replaced (Explorer replaces
/// it all the same), so its bit is cleared for the rename — and put back if the rename fails,
/// so a failure leaves the target as it found it.
pub(crate) fn replace_with(from: &Path, target: &Path) -> Result<()> {
    let was_readonly = fs::symlink_metadata(target)
        .map(|m| m.is_file() && m.permissions().readonly())
        .unwrap_or(false);
    if was_readonly {
        set_readonly(target, false)?;
    }
    fs::rename(from, target).inspect_err(|_| {
        if was_readonly {
            let _ = set_readonly(target, true);
        }
    })
}

/// Same volume → one `rename` (counts the whole size at once). Otherwise, or when the target
/// is an existing folder to merge into, copy then delete from the source only what arrived
/// (`remove_arrived`) — unless a link in it could not be copied: then the source stays, since
/// deleting it would delete the link. Each file that failed stays, with every folder on the
/// way down to it.
///
/// ⛔ Was data loss: the delete used to remove everything in the source EXCEPT the failures,
/// matched by their text. A name that changes on the way to text never matched, so the failed
/// file was deleted; a source folder whose listing broke was "kept" while every child of it
/// was deleted, copied or not. Deleting only what positively arrived cannot make either mistake.
fn move_any(source: &Path, target: &Path, size: u64, progress: &mut Progress) -> Result<()> {
    // a real folder only: a junction onto a folder is not merged into it, and `is_dir` would
    // follow the link and say it was
    let source_is_tree = fs::symlink_metadata(source)
        .map(|m| m.is_dir())
        .unwrap_or(false);
    // likewise the target: a link there is not a folder to merge into
    let merging_dirs = source_is_tree && fs::symlink_metadata(target).is_ok_and(|m| m.is_dir());
    if !merging_dirs && progress.replacing.as_deref() == Some(target) {
        // ⛔ The old file went to the bin BEFORE the rename: across drives the rename fails, and
        // a copy then cancelled (or out of space) left neither file and no undo. Now the source
        // is first renamed beside the target; only once that worked (same volume) is the old
        // file binned. Otherwise the copy below bins it at its own last moment (`copy_file`).
        if let Some(parked) = park_beside(source, target, progress) {
            if let Err(e) = bin_old(target, progress) {
                return Err(unpark(&parked, source, e));
            }
            if let Err(e) = replace_with(&parked, target) {
                let e = put_old_back(target, progress, e);
                return Err(unpark(&parked, source, e));
            }
            parked::remove(&parked);
            progress.add(size);
            return Ok(());
        }
    } else if !merging_dirs && (progress.rename)(source, target).is_ok() {
        progress.add(size);
        return Ok(());
    }
    let left_before = progress.links_left.len();
    let failed_before = progress.failed.len();
    let arrived_before = progress.arrived.len();
    let copied = copy_any(source, target, progress);
    let arrived = progress.arrived.split_off(arrived_before);
    copied?;
    if progress.links_left.len() > left_before {
        return Ok(());
    }
    remove_arrived(source, target, &arrived, failed_before, progress);
    Ok(())
}

/// A Replace by move: rename `source` to a hidden `.<name>.<launch>-<job>.trove-parked` beside
/// `target` (`park_name`),
/// so it can take the old file's place in one more rename. `None` when it cannot (another
/// volume, a filesystem with no rename that refuses to replace, a journal that cannot be
/// written): the move then copies, which is safe without any of these.
///
/// ⛔ A crash between this rename and the next left the moved file hidden for good. The park is
/// noted in the journal first (`parked`), and the next start renames what is left to be seen.
///
/// ⛔ Was a plain rename onto a name picked a moment before: two Replace moves to one name (jobs
/// run side by side) both picked the same park name, and the second rename destroyed the first
/// one's file. The park rename never writes over anything (`Progress::park`); a name taken in
/// between is passed over for the next free one. The launch and job in the name keep parks
/// apart from each other, from an earlier run's, and from a copy's `.trove-partial`.
fn park_beside(source: &Path, target: &Path, progress: &Progress) -> Option<PathBuf> {
    let dir = target.parent()?;
    let name = target.file_name()?.to_string_lossy();
    let park_name = park_name(&name, progress.job_id);
    for _ in 0..PARK_TRIES {
        let parked = dir.join(ops::unique_name(dir, &park_name, false));
        let entry = parked::Entry {
            parked: parked.clone(),
            target: target.to_path_buf(),
        };
        if !(progress.note_park)(&entry) {
            return None;
        }
        match (progress.park)(source, &parked) {
            Ok(()) => return Some(parked),
            Err(e) => {
                parked::remove(&parked);
                if e.kind() != ErrorKind::AlreadyExists {
                    return None;
                }
            }
        }
    }
    None
}

/// The hidden name a move parks under: `.<name>.<launch>-<job>.trove-parked`.
///
/// ⛔ (G.2 review 6, 2) Was `.<name>.<job>.trove-parked`: job ids start at 1 every launch, so a
/// park could take the very name, and the very journal entry, a crash left from an earlier run.
/// Recovery (on its own thread, while jobs run) then took the new park for the leftover —
/// renamed it mid-job or dropped its entry. The launch token (`LAUNCH`) keeps them apart.
fn park_name(name: &str, job: u64) -> String {
    park_name_in(name, launch_token(), job)
}

fn park_name_in(name: &str, launch: &str, job: u64) -> String {
    format!(".{name}.{launch}-{job}.trove-parked")
}

/// This run of the app, told from every other: the process id and the start second, in hex.
fn launch_token() -> &'static str {
    static LAUNCH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    LAUNCH.get_or_init(|| {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("{:x}{:x}", std::process::id(), secs)
    })
}

/// How many park names `park_beside` tries, each taken by someone else between pick and rename.
const PARK_TRIES: usize = 16;

/// A parked move that could not finish: the file goes back where it came from. If something now
/// stands there (made meanwhile), it is never written over: the file goes back beside it as
/// `name (recovered).ext`, and the error says where. If it cannot go back at all, it stays noted
/// in the journal (`parked`), so a later start makes it visible.
fn unpark(parked: &Path, source: &Path, e: Error) -> Error {
    let back = match parked::rename_no_replace(parked, source) {
        Err(taken) if taken.kind() == ErrorKind::AlreadyExists => match source.parent() {
            Some(dir) => parked::rename_to_free(parked, dir, &parked::recovered_name(source)),
            None => Err(taken),
        },
        Err(no) if no.kind() == ErrorKind::Unsupported && !source.exists() => {
            fs::rename(parked, source).map(|()| source.to_path_buf())
        }
        other => other.map(|()| source.to_path_buf()),
    };
    match back {
        Ok(to) => {
            parked::remove(parked);
            if to == source {
                e
            } else {
                Error::new(
                    e.kind(),
                    format!(
                        "{e}. Something new is at {}, so the file being moved is back as {}",
                        source.display(),
                        to.display()
                    ),
                )
            }
        }
        Err(_) => Error::new(
            e.kind(),
            format!("{e}. The file being moved is at {}", parked.display()),
        ),
    }
}

/// The delete half of a move that copied: remove each source entry in `arrived` (children
/// before their folder), and nothing else. A file or link is removed itself — a link never
/// followed; a folder only with `remove_dir`, so only once it is empty: something that failed,
/// or that appeared in it mid-job, keeps it. A removal that fails is recorded as `NotRemoved`
/// (it arrived, but the original is still there) — once: the folders above a kept original
/// stay without saying so again.
///
/// If `source` itself is among the failures since `failed_before` (its listing broke off
/// partway), nothing in it is deleted at all.
fn remove_arrived(
    source: &Path,
    target: &Path,
    arrived: &[PathBuf],
    failed_before: usize,
    progress: &mut Progress,
) {
    if progress.failed_paths[failed_before..]
        .iter()
        .any(|p| p == source)
    {
        return;
    }
    for path in arrived {
        let Ok(meta) = fs::symlink_metadata(path) else {
            continue; // gone already
        };
        let kept_below = meta.is_dir()
            && progress.failed_paths[failed_before..]
                .iter()
                .any(|f| f != path && f.starts_with(path));
        if kept_below {
            continue;
        }
        // where it arrived: the same place under `target` as it had under `source`
        let landed = match path.strip_prefix(source) {
            Ok(rest) if !rest.as_os_str().is_empty() => target.join(rest),
            _ => target.to_path_buf(),
        };
        // ⛔ the copy must be there and must not be the original reached another way (a
        // junction in the destination back into the source): deleting it would delete the
        // only copy
        let result = match fs::symlink_metadata(&landed) {
            Err(_) => Err(Error::new(
                ErrorKind::NotFound,
                "its copy is not at the destination, so it was kept",
            )),
            Ok(_) if is_same(path, &meta, &landed) => Err(Error::new(
                ErrorKind::AlreadyExists,
                "its copy is the original itself, reached through a link; it was kept",
            )),
            Ok(_) => remove_one(path, &meta),
        };
        if let Err(e) = result {
            progress.not_removed(path, &landed, &e);
        }
    }
}

/// Whether `a` (whose `symlink_metadata` is `meta_a`) and `b` are one entry: the same path by
/// `same_entry`, or — for anything but a link — one file on disk (volume + file id, device +
/// inode), which catches a route through a link `same_entry` cannot see. A link is compared
/// by path only: a link and its copy both lead to one target, yet are two entries.
fn is_same(a: &Path, meta_a: &fs::Metadata, b: &Path) -> bool {
    same_entry(a, b)
        || (!meta_a.file_type().is_symlink() && file_id(a).is_some_and(|id| file_id(b) == Some(id)))
}

/// A file's identity on disk, not following a link at the leaf. `None` when it cannot be read.
#[cfg(windows)]
fn file_id(path: &Path) -> Option<(u32, u64)> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    // no access asked for, every share mode allowed: only attributes are read, so a file held
    // open by another program (or by this job) can still be asked who it is
    let file = File::options()
        .access_mode(0)
        .share_mode(7)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .ok()?;
    // SAFETY: the handle is valid while `file` lives; `info` is plain old data the call fills.
    unsafe {
        let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        if GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) == 0 {
            return None;
        }
        let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        Some((info.dwVolumeSerialNumber, index))
    }
}

#[cfg(unix)]
fn file_id(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::symlink_metadata(path).ok()?;
    Some((meta.dev(), meta.ino()))
}

/// Delete one entry and never what is under or behind it: a link is removed as the link, a
/// folder only if empty, a file with its read-only bit cleared first (Explorer deletes those
/// too, and the `remove_dir_all` this replaced did) — and put back if the delete still fails.
fn remove_one(path: &Path, meta: &fs::Metadata) -> Result<()> {
    if meta.is_dir() || ops::is_dir_link(meta) {
        return fs::remove_dir(path);
    }
    let readonly = meta.is_file() && meta.permissions().readonly();
    if readonly {
        set_readonly(path, false)?;
    }
    fs::remove_file(path).inspect_err(|_| {
        if readonly {
            let _ = set_readonly(path, true);
        }
    })
}

/// Allowed clock drift between an original and its copy: FAT keeps modified times to 2 s.
const MTIME_SLACK: Duration = Duration::from_secs(2);

/// Whether `copy` is still a copy of the original `path` (whose `symlink_metadata` is `meta`),
/// in `destination`, so deleting the original loses nothing. The failure came back from the
/// webview, so nothing in it is trusted: the copy must sit in `destination`, must not be the
/// original itself (by path or by file id), must be the same kind of entry, and a file must
/// still have the original's length and modified time.
///
/// ⛔ Was data loss: the check looked at `destination\<original name>`. After a Keep-both move
/// that is the OTHER file, the one the person kept — so with the real copy deleted, the
/// original was deleted too.
fn copy_still_there(
    path: &Path,
    meta: &fs::Metadata,
    copy: &Path,
    destination: &Path,
) -> Result<()> {
    let refuse = |kind: ErrorKind, why: &str| Err(Error::new(kind, why.to_string()));
    let in_destination = copy
        .file_name()
        .is_some_and(|name| same_entry(copy, &destination.join(name)));
    if !in_destination {
        return refuse(
            ErrorKind::InvalidInput,
            "its copy is not in the destination; it was kept",
        );
    }
    if path
        .file_name()
        .is_some_and(|name| same_entry(path, &destination.join(name)))
        || is_same(path, meta, copy)
    {
        return refuse(
            ErrorKind::InvalidInput,
            "its copy is the original itself; it was kept",
        );
    }
    let Ok(copy_meta) = fs::symlink_metadata(copy) else {
        return refuse(
            ErrorKind::NotFound,
            "its copy is not at the destination any more, so it was kept",
        );
    };
    let same_kind = meta.file_type().is_symlink() == copy_meta.file_type().is_symlink()
        && meta.is_dir() == copy_meta.is_dir();
    let changed = meta.is_file()
        && (meta.len() != copy_meta.len()
            || match (meta.modified(), copy_meta.modified()) {
                (Ok(a), Ok(b)) => {
                    a.max(b).duration_since(a.min(b)).unwrap_or_default() > MTIME_SLACK
                }
                _ => true,
            });
    if !same_kind || changed {
        return refuse(
            ErrorKind::InvalidData,
            "its copy has changed since it arrived, so the original was kept",
        );
    }
    Ok(())
}

/// Retry of `NotRemoved` failures: delete each original whose move already carried it, with
/// `remove_one` (a folder only if empty). One whose copy is no longer at its destination, or
/// is no longer a copy of it (`copy_still_there`), is kept — it would be the only copy left.
/// Returns the ones still there, with the new reason.
pub fn remove_originals(failed: &[TransferFailure]) -> Vec<TransferFailure> {
    let mut left = Vec::new();
    for f in failed {
        let path = Path::new(&f.path);
        let result = match (path.file_name(), fs::symlink_metadata(path)) {
            // a name that is not valid Unicode came here as text with U+FFFD in it: "not found"
            // is then the spelling, not the file being gone
            (_, Err(_)) if f.path.contains('\u{FFFD}') => Err(Error::new(
                ErrorKind::InvalidData,
                "its name cannot be spelled here; delete the original by hand",
            )),
            (_, Err(e)) if e.kind() == ErrorKind::NotFound => Ok(()),
            (_, Err(e)) => Err(e),
            (None, _) => Err(Error::new(ErrorKind::InvalidInput, "not a file or folder")),
            (Some(name), Ok(meta)) => {
                let copy = f
                    .copy
                    .as_ref()
                    .map_or_else(|| Path::new(&f.destination).join(name), PathBuf::from);
                match copy_still_there(path, &meta, &copy, Path::new(&f.destination)) {
                    Ok(()) => remove_one(path, &meta),
                    Err(e) => Err(e),
                }
            }
        };
        if let Err(e) = result {
            left.push(TransferFailure {
                error: e.to_string(),
                ..f.clone()
            });
        }
    }
    left
}

/// After a Retry of a move: the source folders it may have emptied (the folders above each
/// retried item, up to its top-level source). The first pass removes a moved folder once it is
/// empty (`remove_arrived`); a retry moved only the items deep inside, so the folders above them
/// were left behind. Deepest first, each is removed with `remove_dir` only — so only when empty:
/// a folder with anything still in it stays, and a link is never removed or followed. Returns
/// how many were removed.
pub fn remove_emptied_folders(dirs: &[PathBuf]) -> usize {
    let mut dirs: Vec<&PathBuf> = dirs.iter().collect();
    // children before their folder, whatever order they came in
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    dirs.dedup();
    dirs.into_iter()
        .filter(|d| fs::symlink_metadata(d).is_ok_and(|m| m.is_dir() && !ops::is_dir_link(&m)))
        .filter(|d| fs::remove_dir(d).is_ok())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, SystemTime};

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("trove-transfer-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `src/a.txt` (3 B), `src/sub/b.txt` (4 B), `src/sub/deep/c.txt` (5 B) → 12 bytes.
    fn tree(root: &Path) -> PathBuf {
        let src = root.join("src");
        fs::create_dir_all(src.join("sub").join("deep")).unwrap();
        fs::write(src.join("a.txt"), b"aaa").unwrap();
        fs::write(src.join("sub").join("b.txt"), b"bbbb").unwrap();
        fs::write(src.join("sub").join("deep").join("c.txt"), b"ccccc").unwrap();
        src
    }

    fn run_quiet(
        sources: &[PathBuf],
        dest: &Path,
        mode: TransferMode,
        res: Resolution,
    ) -> (TransferDone, Vec<TransferProgress>) {
        let seen = RefCell::new(Vec::new());
        let cancel = AtomicBool::new(false);
        let done = run_job(7, sources, dest, mode, res, &cancel, &|p| {
            seen.borrow_mut().push(p)
        });
        (done, seen.into_inner())
    }

    #[test]
    fn copies_a_tree_and_counts_every_byte() {
        let root = scratch("copy");
        let src = tree(&root);
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        let old = SystemTime::now() - Duration::from_secs(3600);
        File::options()
            .write(true)
            .open(src.join("a.txt"))
            .unwrap()
            .set_modified(old)
            .unwrap();

        let (done, seen) = run_quiet(
            std::slice::from_ref(&src),
            &dest,
            TransferMode::Copy,
            Resolution::Skip,
        );
        assert_eq!(done.error, None);
        assert!(!done.cancelled);
        assert_eq!(
            done.outputs,
            vec![TransferOutput {
                from: src.to_string_lossy().into_owned(),
                to: dest.join("src").to_string_lossy().into_owned(),
                replaced: None,
                binned_at: None,
                binned_id: None,
            }]
        );
        assert_eq!(
            fs::read(dest.join("src").join("sub").join("deep").join("c.txt")).unwrap(),
            b"ccccc"
        );
        let last = seen.last().unwrap();
        assert_eq!(last.bytes_total, 12);
        assert_eq!(last.bytes_done, 12);
        assert_eq!(seen[0].bytes_done, 0, "the first event is the sizing");
        let copied_mtime = fs::metadata(dest.join("src").join("a.txt"))
            .unwrap()
            .modified()
            .unwrap();
        let delta = copied_mtime
            .duration_since(old)
            .unwrap_or_else(|e| e.duration());
        assert!(delta < Duration::from_secs(2), "mtime preserved: {delta:?}");
        assert!(src.exists(), "copy leaves the source");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn moves_on_the_same_volume() {
        let root = scratch("move");
        let src = tree(&root);
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        let (done, seen) = run_quiet(
            std::slice::from_ref(&src),
            &dest,
            TransferMode::Move,
            Resolution::Skip,
        );
        assert_eq!(done.error, None);
        assert!(!src.exists());
        assert_eq!(fs::read(dest.join("src").join("a.txt")).unwrap(), b"aaa");
        assert_eq!(seen.last().unwrap().bytes_done, 12);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keep_both_numbers_before_the_extension() {
        let root = scratch("keep");
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        fs::write(root.join("a.txt"), b"new").unwrap();
        fs::write(dest.join("a.txt"), b"old").unwrap();
        fs::write(dest.join("a (2).txt"), b"older").unwrap();
        let (done, _) = run_quiet(
            &[root.join("a.txt")],
            &dest,
            TransferMode::Copy,
            Resolution::KeepBoth,
        );
        assert_eq!(done.error, None);
        assert_eq!(done.outputs[0].to, dest.join("a (3).txt").to_string_lossy());
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"old");
        assert_eq!(fs::read(dest.join("a (3).txt")).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skip_leaves_the_target_and_lists_no_output() {
        let root = scratch("skip");
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        fs::write(root.join("a.txt"), b"new").unwrap();
        fs::write(dest.join("a.txt"), b"old").unwrap();
        let (done, seen) = run_quiet(
            &[root.join("a.txt")],
            &dest,
            TransferMode::Copy,
            Resolution::Skip,
        );
        assert_eq!(done.error, None);
        assert!(done.outputs.is_empty());
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"old");
        assert_eq!(
            seen.last().unwrap().bytes_done,
            3,
            "a skip still completes the bar"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replace_overwrites_even_a_read_only_target() {
        let root = scratch("replace");
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        fs::write(root.join("a.txt"), b"new").unwrap();
        fs::write(dest.join("a.txt"), b"old").unwrap();
        let mut perm = fs::metadata(dest.join("a.txt")).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(dest.join("a.txt"), perm).unwrap();
        let (done, _) = run_quiet(
            &[root.join("a.txt")],
            &dest,
            TransferMode::Copy,
            Resolution::Replace,
        );
        assert_eq!(done.error, None);
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"new");
        let mut perm = fs::metadata(dest.join("a.txt")).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        fs::set_permissions(dest.join("a.txt"), perm).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancel_stops_after_the_current_buffer() {
        let root = scratch("cancel");
        let src = tree(&root);
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        let cancel = AtomicBool::new(false);
        let events = RefCell::new(0);
        let done = run_job(
            1,
            std::slice::from_ref(&src),
            &dest,
            TransferMode::Move,
            Resolution::Skip,
            &cancel,
            &|_| {
                // the sizing event arrives first; cancel right after it
                *events.borrow_mut() += 1;
                cancel.store(true, Ordering::Relaxed);
            },
        );
        assert!(done.cancelled);
        assert_eq!(done.error, None);
        assert!(done.outputs.is_empty());
        assert!(src.exists(), "a cancelled move keeps the source");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_folder_into_its_own_subtree_is_refused() {
        let root = scratch("subtree");
        let src = tree(&root);
        let (done, _) = run_quiet(
            std::slice::from_ref(&src),
            &src.join("sub"),
            TransferMode::Copy,
            Resolution::Skip,
        );
        assert!(done.error.unwrap().contains("subfolder"));
        let (done, _) = run_quiet(
            std::slice::from_ref(&src),
            &src,
            TransferMode::Move,
            Resolution::Skip,
        );
        assert!(done.error.is_some());
        assert!(src.join("a.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conflicts_lists_only_what_exists() {
        let root = scratch("conflicts");
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        fs::write(dest.join("a.txt"), b"").unwrap();
        let found = conflicts(&[root.join("a.txt"), root.join("b.txt")], &dest);
        assert_eq!(
            found,
            vec![dest.join("a.txt").to_string_lossy().into_owned()]
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Was data loss: `copy_file` opened the target for writing — truncating it — before it
    /// read a byte of the source, and here the target IS the source. A file came out 0 bytes;
    /// a folder moved into its own parent went down the merge path and `remove_dir_all` took it.
    /// Whatever the answer, a paste onto itself now never writes there: a copy is a new copy
    /// beside it, a move does nothing.
    #[test]
    fn a_copy_or_move_onto_itself_never_touches_the_source() {
        for res in [Resolution::Replace, Resolution::Skip, Resolution::KeepBoth] {
            let root = scratch("self");
            fs::write(root.join("a.txt"), b"precious").unwrap();
            let src = tree(&root);
            for item in [root.join("a.txt"), src.clone()] {
                let (done, _) =
                    run_quiet(std::slice::from_ref(&item), &root, TransferMode::Move, res);
                assert_eq!(done.error, None, "{res:?}");
                assert!(done.outputs.is_empty(), "a move in place lands nothing");
                let (done, _) =
                    run_quiet(std::slice::from_ref(&item), &root, TransferMode::Copy, res);
                assert_eq!(done.error, None, "{res:?}");
                assert_eq!(done.outputs.len(), 1);
                assert_ne!(PathBuf::from(&done.outputs[0].to), item, "a new name");
            }
            assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"precious");
            assert_eq!(
                fs::read(src.join("sub").join("deep").join("c.txt")).unwrap(),
                b"ccccc"
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    /// Explorer and Finder paste a copy into the folder it came from without asking: no
    /// conflict, the platform's copy name, again and again. A file and a folder alike.
    #[test]
    fn a_copy_pasted_into_its_own_folder_is_named_as_the_platform_names_it() {
        let root = scratch("dup");
        fs::write(root.join("report.txt"), b"r").unwrap();
        let src = tree(&root);
        let file = root.join("report.txt");
        assert!(conflicts(&[file.clone(), src.clone()], &root).is_empty());
        let names = |n| {
            let (done, _) = run_quiet(
                &[file.clone(), src.clone()],
                &root,
                TransferMode::Copy,
                Resolution::Skip,
            );
            assert_eq!(done.error, None, "paste {n}");
            done.outputs
                .iter()
                .map(|o| {
                    PathBuf::from(&o.to)
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect::<Vec<_>>()
        };
        let (first, second) = match ops::CopyStyle::HOST {
            ops::CopyStyle::Windows => (
                ["report - Copy.txt", "src - Copy"],
                ["report - Copy (2).txt", "src - Copy (2)"],
            ),
            ops::CopyStyle::Mac => (
                ["report copy.txt", "src copy"],
                ["report copy 2.txt", "src copy 2"],
            ),
            ops::CopyStyle::Linux => (
                ["report (copy).txt", "src (copy)"],
                ["report (copy 2).txt", "src (copy 2)"],
            ),
        };
        assert_eq!(names(1), first);
        assert_eq!(names(2), second);
        assert_eq!(fs::read(root.join(first[0])).unwrap(), b"r");
        assert_eq!(
            fs::read(root.join(second[1]).join("sub").join("b.txt")).unwrap(),
            b"bbbb"
        );
        assert_eq!(fs::read(&file).unwrap(), b"r", "the original is untouched");
        fs::remove_dir_all(root).unwrap();
    }

    /// Only the in-place source skips the question: another source whose name is taken in the
    /// destination is still a conflict, and Replace for it never overwrites the in-place one.
    #[test]
    fn other_conflicts_still_ask_and_never_replace_the_in_place_source() {
        let root = scratch("mixed");
        let dest = root.join("dest");
        let other = root.join("other");
        fs::create_dir_all(&dest).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(dest.join("x.txt"), b"mine").unwrap();
        fs::write(dest.join("y.txt"), b"old y").unwrap();
        fs::write(other.join("y.txt"), b"new y").unwrap();
        fs::write(other.join("x.txt"), b"theirs").unwrap();
        // y.txt from elsewhere conflicts; x.txt in place does not
        assert_eq!(
            conflicts(&[dest.join("x.txt"), other.join("y.txt")], &dest),
            vec![dest.join("y.txt").to_string_lossy().into_owned()]
        );
        // a name shared with the in-place source is listed (it exists), but never replaces it
        let sources = [other.join("x.txt"), dest.join("x.txt"), other.join("y.txt")];
        let (done, _) = run_quiet(&sources, &dest, TransferMode::Copy, Resolution::Replace);
        assert_eq!(done.error, None);
        assert_eq!(fs::read(dest.join("x.txt")).unwrap(), b"mine");
        assert_eq!(fs::read(dest.join("y.txt")).unwrap(), b"new y");
        assert_eq!(done.outputs.len(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    /// Windows names are case-blind: the same folder spelled in another case is still "its own
    /// folder" — a copy, not a question and not a write over the original.
    #[cfg(windows)]
    #[test]
    fn on_windows_the_same_folder_in_another_case_is_its_own_folder() {
        let root = scratch("case");
        fs::write(root.join("a.txt"), b"precious").unwrap();
        let upper = PathBuf::from(root.to_string_lossy().to_uppercase());
        assert!(conflicts(&[upper.join("A.TXT")], &root).is_empty());
        let (done, _) = run_quiet(
            &[upper.join("A.TXT")],
            &root,
            TransferMode::Copy,
            Resolution::Replace,
        );
        assert_eq!(done.error, None);
        assert_eq!(fs::read(root.join("A - Copy.TXT")).unwrap(), b"precious");
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"precious");
        fs::remove_dir_all(root).unwrap();
    }

    fn quiet_progress(cancel: &AtomicBool) -> Progress<'_> {
        Progress {
            job_id: 0,
            done: 0,
            total: 0,
            current: String::new(),
            last: None,
            sink: &|_| {},
            cancel,
            bin: &NoBin,
            replacing: None,
            replaced: None,
            binned: None,
            rename: |from, to| fs::rename(from, to),
            park: parked::rename_no_replace,
            note_park: |_| true,
            links_left: Vec::new(),
            failed: Vec::new(),
            failed_paths: Vec::new(),
            arrived: Vec::new(),
            track_arrived: false,
            items: 0,
            created: Vec::new(),
            created_set: HashSet::new(),
            partial: None,
        }
    }

    /// ⛔ Was data loss: Replace truncated the old file first and wrote the new one over it, so
    /// a cancel, a full disk or a read error midway left neither. The old file must survive
    /// any failure, keep its read-only bit, and no partial copy may be left beside it.
    #[test]
    fn a_replace_that_fails_midway_keeps_the_old_file_whole() {
        let root = scratch("replace-fail");
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        fs::write(root.join("a.txt"), b"new").unwrap();
        fs::write(dest.join("a.txt"), b"old").unwrap();
        let mut perm = fs::metadata(dest.join("a.txt")).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(dest.join("a.txt"), perm).unwrap();

        let cancel = AtomicBool::new(true);
        let err = copy_file(
            &root.join("a.txt"),
            &dest.join("a.txt"),
            &mut quiet_progress(&cancel),
        )
        .unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Interrupted);
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"old");
        let meta = fs::metadata(dest.join("a.txt")).unwrap();
        assert!(
            meta.permissions().readonly(),
            "the read-only bit is put back"
        );
        let names: Vec<_> = fs::read_dir(&dest)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(
            names,
            vec![std::ffi::OsString::from("a.txt")],
            "no partial left"
        );

        let mut perm = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        fs::set_permissions(dest.join("a.txt"), perm).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "mklink /J {}", link.display());
    }

    #[cfg(windows)]
    fn is_link_to(link: &Path, target: &Path) -> bool {
        let meta = fs::symlink_metadata(link).unwrap();
        ops::is_dir_link(&meta)
            && fs::canonicalize(link).unwrap() == fs::canonicalize(target).unwrap()
    }

    /// ⛔ Was data loss: `copy_dir` skipped links, then a move deleted the source tree, links
    /// and all. A link is copied as a link (its target is not duplicated or walked).
    #[cfg(windows)]
    #[test]
    fn a_junction_inside_a_tree_is_copied_as_a_junction() {
        let root = scratch("junction-copy");
        let src = tree(&root);
        let elsewhere = root.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        fs::write(elsewhere.join("big.bin"), vec![7u8; 1000]).unwrap();
        junction(&src.join("link"), &elsewhere);
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();

        let (done, seen) = run_quiet(
            std::slice::from_ref(&src),
            &dest,
            TransferMode::Copy,
            Resolution::Skip,
        );
        assert_eq!(done.error, None);
        assert!(is_link_to(&dest.join("src").join("link"), &elsewhere));
        assert_eq!(
            seen.last().unwrap().bytes_total,
            12,
            "a link's target is not counted"
        );

        // a selected junction on its own is copied as the link too
        let (done, _) = run_quiet(
            &[src.join("link")],
            &root.join("dest"),
            TransferMode::Copy,
            Resolution::Skip,
        );
        assert_eq!(done.error, None);
        assert!(is_link_to(&dest.join("link"), &elsewhere));
        fs::remove_dir_all(root).unwrap();
    }

    /// A folder moved onto a namesake with Replace merges by copy + delete — the path that used
    /// to drop the junction and then delete the source that still held it.
    #[cfg(windows)]
    #[test]
    fn a_merging_move_keeps_the_junction_and_its_target() {
        let root = scratch("junction-move");
        let src = tree(&root);
        let elsewhere = root.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        fs::write(elsewhere.join("keep.txt"), b"k").unwrap();
        junction(&src.join("link"), &elsewhere);
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("src")).unwrap();

        let (done, _) = run_quiet(
            std::slice::from_ref(&src),
            &dest,
            TransferMode::Move,
            Resolution::Replace,
        );
        assert_eq!(done.error, None);
        assert!(!src.exists());
        assert!(is_link_to(&dest.join("src").join("link"), &elsewhere));
        assert_eq!(fs::read(elsewhere.join("keep.txt")).unwrap(), b"k");
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Replace of a folder onto a same-name junction replaces the junction; it used to merge
    /// through it, writing into the junction's target (and a move then deleted the source).
    #[cfg(windows)]
    #[test]
    fn replace_onto_a_same_name_junction_leaves_its_target_alone() {
        for mode in [TransferMode::Copy, TransferMode::Move] {
            let root = scratch("junction-replace");
            let src = tree(&root);
            let elsewhere = root.join("elsewhere");
            fs::create_dir(&elsewhere).unwrap();
            fs::write(elsewhere.join("keep.txt"), b"k").unwrap();
            let dest = root.join("dest");
            fs::create_dir(&dest).unwrap();
            junction(&dest.join("src"), &elsewhere);

            let (done, _) = run_quiet(std::slice::from_ref(&src), &dest, mode, Resolution::Replace);
            assert_eq!(done.error, None, "{mode:?}");
            let landed = fs::symlink_metadata(dest.join("src")).unwrap();
            assert!(landed.is_dir() && !ops::is_dir_link(&landed), "{mode:?}");
            assert_eq!(fs::read(dest.join("src").join("a.txt")).unwrap(), b"aaa");
            let mut left: Vec<_> = fs::read_dir(&elsewhere)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            left.sort();
            assert_eq!(left, ["keep.txt"], "{mode:?}: the target was written into");
            assert_eq!(src.exists(), mode == TransferMode::Copy, "{mode:?}");
            fs::remove_dir_all(root).unwrap();
        }
    }

    /// ⛔ Replace removes the junction at `dest\src`; a source reached through that very junction
    /// would be cut off mid-job, so the job is refused up front and nothing is touched.
    #[cfg(windows)]
    #[test]
    fn replace_refuses_when_the_source_path_runs_through_the_link_it_would_remove() {
        let root = scratch("junction-through");
        let t = root.join("T");
        fs::create_dir_all(t.join("src")).unwrap();
        fs::write(t.join("src").join("a.txt"), b"a").unwrap();
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        junction(&dest.join("src"), &t);

        let (done, _) = run_quiet(
            &[dest.join("src").join("src")],
            &dest,
            TransferMode::Move,
            Resolution::Replace,
        );
        assert!(done.error.is_some());
        assert!(is_link_to(&dest.join("src"), &t));
        assert_eq!(fs::read(t.join("src").join("a.txt")).unwrap(), b"a");
        fs::remove_dir_all(root).unwrap();
    }

    /// The guard above must not fire when the source reaches the link's target by another route.
    #[cfg(windows)]
    #[test]
    fn replace_allows_a_source_in_the_links_target_reached_directly() {
        let root = scratch("junction-direct");
        let x = root.join("X");
        fs::create_dir_all(x.join("src")).unwrap();
        fs::write(x.join("src").join("a.txt"), b"a").unwrap();
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        junction(&dest.join("src"), &x);

        let (done, _) = run_quiet(
            &[x.join("src")],
            &dest,
            TransferMode::Copy,
            Resolution::Replace,
        );
        assert_eq!(done.error, None);
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Was data loss: `A\x.txt` and `B\x.txt` in one job both aimed at `dest\x.txt`; the
    /// second skipped (or, under Replace, overwrote the first — and a move had already
    /// deleted the first's source). The second now takes a Keep-both name whatever was chosen.
    #[test]
    fn two_sources_with_one_name_never_land_on_each_other() {
        for (mode, res) in [
            (TransferMode::Copy, Resolution::Skip),
            (TransferMode::Copy, Resolution::Replace),
            (TransferMode::Move, Resolution::Replace),
            (TransferMode::Move, Resolution::KeepBoth),
        ] {
            let root = scratch("dupes");
            for (dir, body) in [("A", "a"), ("B", "b")] {
                fs::create_dir(root.join(dir)).unwrap();
                fs::write(root.join(dir).join("x.txt"), body).unwrap();
            }
            let dest = root.join("dest");
            fs::create_dir(&dest).unwrap();
            let sources = [root.join("A").join("x.txt"), root.join("B").join("x.txt")];
            assert_eq!(
                conflicts(&sources, &dest),
                vec![dest.join("x.txt").to_string_lossy().into_owned()],
                "flagged though nothing is there yet"
            );
            let (done, _) = run_quiet(&sources, &dest, mode, res);
            assert_eq!(done.error, None, "{mode:?} {res:?}");
            assert_eq!(done.outputs.len(), 2, "{mode:?} {res:?}");
            assert_eq!(
                fs::read(dest.join("x.txt")).unwrap(),
                b"a",
                "{mode:?} {res:?}"
            );
            assert_eq!(
                fs::read(dest.join("x (2).txt")).unwrap(),
                b"b",
                "{mode:?} {res:?}"
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    /// Makes `path` unreadable while the guard lives: on Windows it is held open with no
    /// sharing (another reader gets a sharing violation, as with a file Word has open); on
    /// Unix its mode is 000. `None` where that does not stop a read (Unix as root).
    #[cfg(windows)]
    fn unreadable(path: &Path) -> Option<File> {
        use std::os::windows::fs::OpenOptionsExt;
        let held = File::options().read(true).share_mode(0).open(path).unwrap();
        assert!(
            File::open(path).is_err(),
            "the held file must refuse a reader"
        );
        Some(held)
    }

    /// What keeps a file unreadable on Unix: dropped, it makes the file readable again. Not
    /// `()`: `drop` of a `Copy` value does nothing, and newer Clippy (`dropping_copy_types`)
    /// rejects the `drop(guard)` the tests share with Windows, where the guard is a `File`.
    #[cfg(unix)]
    struct Unreadable(PathBuf);

    #[cfg(unix)]
    impl Drop for Unreadable {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o644));
        }
    }

    #[cfg(unix)]
    fn unreadable(path: &Path) -> Option<Unreadable> {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o000)).unwrap();
        let guard = Unreadable(path.to_path_buf());
        File::open(path).is_err().then_some(guard)
    }

    /// `name/a.txt`, `name/sub/b.txt` (the one made unreadable), `name/c.txt`.
    fn three_files(root: &Path, name: &str) -> (PathBuf, PathBuf) {
        let src = root.join(name);
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), b"aaa").unwrap();
        fs::write(src.join("sub").join("b.txt"), b"bbbb").unwrap();
        fs::write(src.join("c.txt"), b"ccccc").unwrap();
        let bad = src.join("sub").join("b.txt");
        (src, bad)
    }

    /// ⛔ Was a job that stopped dead: one file another program held open ended the whole copy
    /// at that file, and everything after it never arrived. Now the rest arrives and the one
    /// file is named, with where it was going, so Retry can send it there.
    #[test]
    fn an_unreadable_file_is_recorded_and_the_rest_still_arrives() {
        let root = scratch("unreadable-copy");
        let (src, bad) = three_files(&root, "src");
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        let Some(guard) = unreadable(&bad) else {
            return; // running as root: nothing can be made unreadable
        };
        let (done, _) = run_quiet(
            std::slice::from_ref(&src),
            &dest,
            TransferMode::Copy,
            Resolution::Skip,
        );
        drop(guard);
        assert!(!done.cancelled);
        let landed = dest.join("src");
        assert_eq!(fs::read(landed.join("a.txt")).unwrap(), b"aaa");
        assert_eq!(fs::read(landed.join("c.txt")).unwrap(), b"ccccc");
        assert!(!landed.join("sub").join("b.txt").exists());
        assert_eq!(done.outputs.len(), 1, "the folder itself landed");
        assert_eq!(done.failed.len(), 1);
        assert_eq!(done.failed[0].path, bad.to_string_lossy());
        assert_eq!(
            done.failed[0].destination,
            landed.join("sub").to_string_lossy()
        );
        assert_eq!(
            done.error.as_deref(),
            Some("1 of 3 items could not be copied")
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// Three loose files, the middle one unreadable: two land, one is recorded.
    #[test]
    fn of_three_loose_files_two_land_and_one_is_recorded() {
        let root = scratch("unreadable-loose");
        let (src, bad) = three_files(&root, "src");
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        let sources = [src.join("a.txt"), bad.clone(), src.join("c.txt")];
        let Some(guard) = unreadable(&bad) else {
            return;
        };
        let (done, _) = run_quiet(&sources, &dest, TransferMode::Copy, Resolution::Skip);
        drop(guard);
        let tos: Vec<_> = done.outputs.iter().map(|o| o.to.clone()).collect();
        assert_eq!(
            tos,
            vec![
                dest.join("a.txt").to_string_lossy().into_owned(),
                dest.join("c.txt").to_string_lossy().into_owned(),
            ]
        );
        assert_eq!(done.failed.len(), 1);
        assert_eq!(done.failed[0].path, bad.to_string_lossy());
        assert_eq!(done.failed[0].destination, dest.to_string_lossy());
        assert!(!dest.join("b.txt").exists(), "no partial left");
        fs::remove_dir_all(root).unwrap();
    }

    /// A move that copies (here: a merge into an existing folder) deletes what arrived and
    /// keeps the file that did not — in its own folder, under the source folder it came from.
    #[test]
    fn a_move_keeps_the_failed_file_and_its_folders() {
        let root = scratch("unreadable-move");
        let (src, bad) = three_files(&root, "src");
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("src")).unwrap();
        let Some(guard) = unreadable(&bad) else {
            return;
        };
        let (done, _) = run_quiet(
            std::slice::from_ref(&src),
            &dest,
            TransferMode::Move,
            Resolution::Replace,
        );
        drop(guard);
        assert_eq!(done.failed.len(), 1);
        assert_eq!(
            done.error.as_deref(),
            Some("1 of 3 items could not be moved")
        );
        assert_eq!(fs::read(dest.join("src").join("a.txt")).unwrap(), b"aaa");
        assert_eq!(fs::read(dest.join("src").join("c.txt")).unwrap(), b"ccccc");
        assert!(!src.join("a.txt").exists(), "what arrived left the source");
        assert!(!src.join("c.txt").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bad, fs::Permissions::from_mode(0o644)).unwrap();
        }
        assert_eq!(
            fs::read(&bad).unwrap(),
            b"bbbb",
            "the failed file stays, whole"
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// the Ubuntu run: Retry of a move's failed deep file moved it, and left `src\sub\deep`,
    /// `src\sub` and `src` behind, empty. The retry's folders above it go once empty; one that
    /// still holds something stays.
    #[test]
    fn a_retried_move_removes_the_source_folders_it_emptied_and_keeps_the_rest() {
        let root = scratch("retry-prune");
        let src = tree(&root);
        let dest = root.join("dest");
        // the first pass carried everything but `deep\c.txt`: the folders above it stayed
        fs::create_dir_all(dest.join("src").join("sub").join("deep")).unwrap();
        fs::remove_file(src.join("a.txt")).unwrap();
        fs::remove_file(src.join("sub").join("b.txt")).unwrap();
        // something put in `src` meanwhile keeps it; `src\sub` holds nothing else
        fs::write(src.join("new.txt"), b"n").unwrap();
        let deep = src.join("sub").join("deep");
        // the retry: the one file, into the folder it was on its way to
        let (done, _) = run_quiet(
            &[deep.join("c.txt")],
            &dest.join("src").join("sub").join("deep"),
            TransferMode::Move,
            Resolution::Skip,
        );
        assert!(done.failed.is_empty(), "{:?}", done.failed);
        assert!(
            deep.is_dir(),
            "a move of a file alone never removes its folder"
        );
        let removed = remove_emptied_folders(&[src.clone(), src.join("sub"), deep.clone()]);
        assert_eq!(removed, 2);
        assert!(
            !deep.exists() && !src.join("sub").exists(),
            "the emptied folders are gone"
        );
        assert_eq!(
            fs::read(src.join("new.txt")).unwrap(),
            b"n",
            "a folder with something in it stays"
        );
        assert_eq!(
            fs::read(dest.join("src").join("sub").join("deep").join("c.txt")).unwrap(),
            b"ccccc"
        );
        // nothing to do a second time, and a folder that is not there is no error
        assert_eq!(remove_emptied_folders(&[src.join("sub")]), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failure_serializes_in_camel_case() {
        let f = TransferFailure {
            path: "a".into(),
            destination: "b".into(),
            error: "c".into(),
            kind: FailureKind::NotRemoved,
            copy: None,
        };
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"path": "a", "destination": "b", "error": "c", "kind": "not-removed"})
        );
        // a failure the webview sends back without `copy` still reads
        let back: TransferFailure = serde_json::from_value(v).unwrap();
        assert_eq!(back, f);
        let with_copy = TransferFailure {
            copy: Some("b\\a (2)".into()),
            ..f
        };
        assert_eq!(
            serde_json::to_value(&with_copy).unwrap()["copy"],
            serde_json::json!("b\\a (2)")
        );
        assert_eq!(
            serde_json::to_string(&FailureKind::NewFolder).unwrap(),
            "\"new-folder\""
        );
    }

    /// Unreadable (no read sharing) yet deletable (`FILE_SHARE_DELETE`): what an OneDrive
    /// online-only file is while offline, or a file whose ACL denies reading but not deleting.
    /// The delete half of a move could remove it — so only what it chooses keeps it alive.
    #[cfg(windows)]
    fn unreadable_deletable(path: &Path) -> File {
        use std::os::windows::fs::OpenOptionsExt;
        let held = File::options().read(true).share_mode(4).open(path).unwrap();
        assert!(
            File::open(path).is_err(),
            "the held file must refuse a reader"
        );
        held
    }

    /// Every name under `dir`, sorted, for a readable assert.
    fn names(dir: &Path) -> Vec<String> {
        let mut found: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        found.sort();
        found
    }

    fn move_merge(src: &Path, dest: &Path) -> TransferDone {
        run_quiet(
            &[src.to_path_buf()],
            dest,
            TransferMode::Move,
            Resolution::Replace,
        )
        .0
    }

    /// The same move as `a_move_keeps_the_failed_file_and_its_folders`, with a file the delete
    /// half COULD remove: it stays because it never arrived, not because the delete failed.
    #[cfg(windows)]
    #[test]
    fn a_move_keeps_an_unreadable_file_it_could_have_deleted() {
        let root = scratch("unreadable-deletable");
        let (src, bad) = three_files(&root, "src");
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("src")).unwrap();
        let guard = unreadable_deletable(&bad);
        let done = move_merge(&src, &dest);
        drop(guard);
        assert_eq!(done.failed.len(), 1);
        assert_eq!(done.failed[0].kind, FailureKind::File);
        assert_eq!(
            fs::read(&bad).unwrap(),
            b"bbbb",
            "the failed file stays, whole"
        );
        assert_eq!(names(&src), ["sub"], "what arrived left the source");
        assert_eq!(names(&dest.join("src")), ["a.txt", "c.txt", "sub"]);
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Was data loss (probe `probe_lossy_name_failed_file_survives`): the failed path was
    /// kept as text, a name with an unpaired UTF-16 surrogate changed on the way (U+FFFD), never
    /// matched the real path, and the delete half of the move removed the file it had failed on.
    #[cfg(windows)]
    #[test]
    fn a_failed_file_whose_name_is_not_unicode_survives_the_move() {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        let root = scratch("lossy-name");
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.txt"), b"aaa").unwrap();
        // "b\u{D800}.txt": a lone high surrogate, legal in NTFS, not in Unicode
        let odd = OsString::from_wide(&[0x62, 0xD800, 0x2E, 0x74, 0x78, 0x74]);
        let bad = src.join(&odd);
        fs::write(&bad, b"precious").unwrap();
        // a second broken name: both used to collapse into one failure by their text
        let odd2 = OsString::from_wide(&[0x63, 0xDC00, 0x2E, 0x74, 0x78, 0x74]);
        let bad2 = src.join(&odd2);
        fs::write(&bad2, b"also precious").unwrap();
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("src")).unwrap();
        let guards = (unreadable_deletable(&bad), unreadable_deletable(&bad2));
        let done = move_merge(&src, &dest);
        drop(guards);
        assert_eq!(
            fs::read(&bad).unwrap(),
            b"precious",
            "the failed file was deleted"
        );
        assert_eq!(fs::read(&bad2).unwrap(), b"also precious");
        assert_eq!(done.failed.len(), 2, "two broken names are two failures");
        assert!(!src.join("a.txt").exists(), "what arrived left the source");
        assert_eq!(fs::read(dest.join("src").join("a.txt")).unwrap(), b"aaa");
        fs::remove_dir_all(root).unwrap();
    }

    /// The same on Unix, where a name is bytes and need not be UTF-8 at all.
    #[cfg(unix)]
    #[test]
    fn a_failed_file_whose_name_is_not_utf8_survives_the_move() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let root = scratch("non-utf8-name");
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.txt"), b"aaa").unwrap();
        let bad = src.join(OsStr::from_bytes(b"b\xff.txt"));
        let bad2 = src.join(OsStr::from_bytes(b"b\xfe.txt"));
        // APFS refuses a name that is not UTF-8 (EILSEQ), so on a Mac there is nothing to test
        if fs::write(&bad, b"precious").is_err() {
            fs::remove_dir_all(root).unwrap();
            return;
        }
        fs::write(&bad2, b"also precious").unwrap();
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("src")).unwrap();
        // named guards: `Some(_)` binds nothing, so the guards were dropped (mode 644 again)
        // before the move, both files were readable, and the test never met an unreadable one
        let (Some(guard), Some(guard2)) = (unreadable(&bad), unreadable(&bad2)) else {
            fs::remove_dir_all(root).unwrap();
            return; // running as root
        };
        let done = move_merge(&src, &dest);
        drop((guard, guard2));
        assert_eq!(
            fs::read(&bad).unwrap(),
            b"precious",
            "the failed file was deleted"
        );
        assert_eq!(fs::read(&bad2).unwrap(), b"also precious");
        assert_eq!(done.failed.len(), 2, "two broken names are two failures");
        assert!(!src.join("a.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// Two readable names that differ only in bytes that are not UTF-8 are two files: both
    /// move, each with its own bytes. Was refused: their lossy text is one (`b�.txt`), so the
    /// second was failed as "the same name in another case" and left behind.
    #[cfg(unix)]
    #[test]
    fn two_names_that_differ_only_in_non_utf8_bytes_both_move() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let root = scratch("non-utf8-twins");
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        let ff = OsStr::from_bytes(b"b\xff.txt");
        let fe = OsStr::from_bytes(b"b\xfe.txt");
        if fs::write(src.join(ff), b"ff").is_err() {
            fs::remove_dir_all(root).unwrap(); // APFS: not a legal name
            return;
        }
        fs::write(src.join(fe), b"fe").unwrap();
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("src")).unwrap();
        let done = move_merge(&src, &dest);
        assert!(done.failed.is_empty(), "{:?}", done.failed);
        assert_eq!(fs::read(dest.join("src").join(ff)).unwrap(), b"ff");
        assert_eq!(fs::read(dest.join("src").join(fe)).unwrap(), b"fe");
        assert!(!src.exists(), "everything arrived, so the source is gone");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_name_that_is_not_unicode_keys_by_its_bytes_and_still_folds_case() {
        #[cfg(unix)]
        let (a, b, upper) = {
            use std::ffi::OsStr;
            use std::os::unix::ffi::OsStrExt;
            (
                OsStr::from_bytes(b"b\xff.txt").to_os_string(),
                OsStr::from_bytes(b"b\xfe.txt").to_os_string(),
                OsStr::from_bytes(b"B\xff.TXT").to_os_string(),
            )
        };
        #[cfg(windows)]
        let (a, b, upper) = {
            use std::ffi::OsString;
            use std::os::windows::ffi::OsStringExt;
            (
                OsString::from_wide(&[0x62, 0xD800, 0x2E, 0x74, 0x78, 0x74]),
                OsString::from_wide(&[0x62, 0xD801, 0x2E, 0x74, 0x78, 0x74]),
                OsString::from_wide(&[0x42, 0xD800, 0x2E, 0x54, 0x58, 0x54]),
            )
        };
        assert_ne!(name_key(&a), name_key(&b), "two names, two keys");
        assert_eq!(name_key(&a), name_key(&upper), "case still folds");
        assert_ne!(
            name_key(&a),
            name_key(std::ffi::OsStr::new("b\u{FFFD}.txt"))
        );
    }

    /// ⛔ Was data loss (probe `probe_prune_with_source_itself_in_keep`): a top-level folder
    /// whose listing broke off partway was recorded as failed, and the delete then removed
    /// every child of it — including ones the copy never reached. Now nothing in it goes.
    #[test]
    fn a_source_folder_that_could_not_be_listed_whole_loses_nothing() {
        let root = scratch("listing-broke");
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("copied.txt"), b"1").unwrap();
        fs::write(src.join("never_copied.txt"), b"2").unwrap();
        let target = root.join("dest").join("src");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("copied.txt"), b"1").unwrap();
        let cancel = AtomicBool::new(false);
        let mut p = quiet_progress(&cancel);
        p.track_arrived = true;
        // what `copy_dir` records when the source's own listing breaks
        let broke = Error::other("the listing broke");
        p.fail(&src, &root.join("dest"), &broke, FailureKind::Folder);
        remove_arrived(&src, &target, &[src.join("copied.txt")], 0, &mut p);
        assert!(
            src.join("never_copied.txt").exists(),
            "deleted a file that never arrived"
        );
        assert!(src.join("copied.txt").exists(), "nothing in it is deleted");
    }

    /// The delete half removes only what arrived: a file that appeared in the source after the
    /// copy walked past it is not in `arrived`, so it and its folder stay.
    #[test]
    fn only_what_arrived_is_deleted() {
        let root = scratch("only-arrived");
        let src = tree(&root);
        let target = root.join("dest").join("src");
        fs::create_dir_all(&target).unwrap();
        let cancel = AtomicBool::new(false);
        let mut p = quiet_progress(&cancel);
        p.track_arrived = true;
        copy_any(&src, &target, &mut p).unwrap();
        let arrived = std::mem::take(&mut p.arrived);
        assert_eq!(
            arrived.last(),
            Some(&src),
            "the folder arrives after its children"
        );
        fs::write(src.join("sub").join("late.txt"), b"new").unwrap();
        remove_arrived(&src, &target, &arrived, 0, &mut p);
        assert_eq!(fs::read(src.join("sub").join("late.txt")).unwrap(), b"new");
        assert_eq!(names(&src), ["sub"]);
        assert_eq!(
            names(&src.join("sub")),
            ["late.txt"],
            "deep/ arrived and went"
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// A merge onto a folder that already holds an older file of the same name: the new one
    /// replaces it, the moved original leaves, the unreadable one stays.
    #[cfg(windows)]
    #[test]
    fn a_merge_replaces_an_older_same_name_file_and_keeps_the_failed_one() {
        let root = scratch("merge-older");
        let (src, bad) = three_files(&root, "src");
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("src").join("sub")).unwrap();
        fs::write(dest.join("src").join("a.txt"), b"old a").unwrap();
        fs::write(dest.join("src").join("sub").join("b.txt"), b"old b").unwrap();
        fs::write(dest.join("src").join("theirs.txt"), b"t").unwrap();
        let guard = unreadable_deletable(&bad);
        let done = move_merge(&src, &dest);
        drop(guard);
        assert_eq!(fs::read(dest.join("src").join("a.txt")).unwrap(), b"aaa");
        assert_eq!(
            fs::read(dest.join("src").join("sub").join("b.txt")).unwrap(),
            b"old b",
            "a file that failed leaves the older one in place"
        );
        assert_eq!(fs::read(dest.join("src").join("theirs.txt")).unwrap(), b"t");
        assert_eq!(fs::read(&bad).unwrap(), b"bbbb");
        assert!(!src.join("a.txt").exists() && !src.join("c.txt").exists());
        assert_eq!(done.failed.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    /// A clean merging move empties the source — read-only files and empty folders too, which
    /// the `remove_dir_all` it replaced also took.
    #[test]
    fn a_clean_merging_move_leaves_no_source_behind() {
        let root = scratch("merge-clean");
        let src = tree(&root);
        fs::create_dir(src.join("empty")).unwrap();
        set_readonly(&src.join("a.txt"), true).unwrap();
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("src")).unwrap();
        let done = move_merge(&src, &dest);
        assert_eq!(done.error, None);
        assert!(done.failed.is_empty());
        assert!(!src.exists(), "the source is gone");
        assert!(dest.join("src").join("empty").is_dir());
        let landed = dest.join("src").join("a.txt");
        assert_eq!(fs::read(&landed).unwrap(), b"aaa");
        set_readonly(&landed, false).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    /// Port of `probe_prefix_sibling_and_junction`: a failure in `a` must not keep `ab` (paths
    /// compare by component, not by text prefix), and a junction leaves as a link — its target
    /// untouched.
    #[cfg(windows)]
    #[test]
    fn a_failure_in_a_keeps_neither_ab_nor_the_junctions_target_back() {
        let root = scratch("prefix");
        let src = root.join("src");
        fs::create_dir_all(src.join("a")).unwrap();
        fs::create_dir_all(src.join("ab")).unwrap();
        fs::write(src.join("a").join("x.txt"), b"x").unwrap();
        fs::write(src.join("ab").join("y.txt"), b"y").unwrap();
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keepme.txt"), b"k").unwrap();
        make_junction(&src.join("j"), &outside).unwrap();
        let bad = src.join("a").join("x.txt");
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("src")).unwrap();
        let guard = unreadable_deletable(&bad);
        let done = move_merge(&src, &dest);
        drop(guard);
        assert_eq!(done.failed.len(), 1);
        assert_eq!(fs::read(&bad).unwrap(), b"x", "the failed x is kept");
        assert_eq!(fs::read(outside.join("keepme.txt")).unwrap(), b"k");
        assert!(is_link_to(&dest.join("src").join("j"), &outside));
        assert_eq!(
            fs::read(dest.join("src").join("ab").join("y.txt")).unwrap(),
            b"y"
        );
        assert_eq!(names(&src), ["a"], "ab and the junction left the source");
        fs::remove_dir_all(root).unwrap();
    }

    /// A merge whose original could not be deleted reports `NotRemoved`, and retrying just the
    /// delete then takes it — but never one whose copy is gone from the destination.
    #[cfg(windows)]
    #[test]
    fn an_original_that_could_not_be_deleted_is_reported_and_retried_alone() {
        let root = scratch("not-removed");
        let (src, held) = three_files(&root, "src");
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("src")).unwrap();
        // readable, so it copies; no delete sharing, so it cannot be removed while held
        use std::os::windows::fs::OpenOptionsExt;
        let guard = File::options()
            .read(true)
            .share_mode(1)
            .open(&held)
            .unwrap();
        let done = move_merge(&src, &dest);
        drop(guard);
        assert_eq!(done.failed.len(), 1, "{:?}", done.failed);
        let f = &done.failed[0];
        assert_eq!(f.kind, FailureKind::NotRemoved);
        assert_eq!(f.path, held.to_string_lossy());
        assert_eq!(
            f.destination,
            dest.join("src").join("sub").to_string_lossy()
        );
        assert_eq!(
            done.error.as_deref(),
            Some("1 item(s) arrived, but the original could not be deleted")
        );
        assert_eq!(
            names(&src),
            ["sub"],
            "the folder above it stays, unreported"
        );

        // its copy gone from the destination: the retry keeps the only one left
        let copy = dest.join("src").join("sub").join("b.txt");
        fs::rename(&copy, root.join("aside.txt")).unwrap();
        let left = remove_originals(&done.failed);
        assert_eq!(left.len(), 1);
        assert!(held.exists());
        fs::rename(root.join("aside.txt"), &copy).unwrap();
        assert!(remove_originals(&done.failed).is_empty());
        assert!(!held.exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// A folder that failed on its own name is a `Folder` (Retry merges); one whose copy took a
    /// new name is a `NewFolder` (merging would write into the folder the person kept).
    #[test]
    fn a_failed_folder_says_whether_it_kept_its_name() {
        let root = scratch("kinds");
        let src = tree(&root);
        assert_eq!(
            kind_of(&src, &root.join("d").join("src")),
            FailureKind::Folder
        );
        assert_eq!(
            kind_of(&src, &root.join("d").join("src (2)")),
            FailureKind::NewFolder
        );
        assert_eq!(
            kind_of(&src.join("a.txt"), &root.join("x")),
            FailureKind::File
        );
        assert_eq!(
            kind_of(&root.join("missing"), &root.join("missing")),
            FailureKind::File
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Was a possible endless loop: the walk goes on past a listing error, so a listing that
    /// returns the same error forever never ended. It now stops after a run of them.
    #[test]
    fn a_listing_that_only_fails_ends() {
        let forever = std::iter::repeat_with(|| Err::<(), _>(Error::other("stuck")));
        assert_eq!(capped(forever).count(), LISTING_ERRORS_MAX as usize);
        // errors between good entries do not add up
        let mixed = (0..100).map(|i| {
            if i % 2 == 0 {
                Ok(i)
            } else {
                Err(Error::other("x"))
            }
        });
        assert_eq!(capped(mixed).count(), 100);
    }

    #[test]
    fn modes_and_resolutions_serialize_in_kebab_case() {
        assert_eq!(
            serde_json::to_string(&TransferMode::Move).unwrap(),
            "\"move\""
        );
        assert_eq!(
            serde_json::from_str::<Resolution>("\"keep-both\"").unwrap(),
            Resolution::KeepBoth
        );
    }

    /// Every file's contents under the given folders (not recursive), for a "nothing lost" check.
    fn contents(dirs: &[&Path]) -> Vec<String> {
        let mut found = Vec::new();
        for d in dirs {
            if let Ok(entries) = fs::read_dir(d) {
                for e in entries {
                    found.push(fs::read_to_string(e.unwrap().path()).unwrap_or_default());
                }
            }
        }
        found
    }

    /// A folder that may hold `a.txt` and `A.txt` side by side: always on Unix, on Windows only
    /// where `fsutil` can turn on per-folder case sensitivity (WSL feature; may need admin).
    fn case_sensitive_folder(dir: &Path) -> bool {
        fs::create_dir_all(dir).unwrap();
        if cfg!(windows) {
            let on = std::process::Command::new("fsutil")
                .args(["file", "setCaseSensitiveInfo"])
                .arg(dir)
                .arg("enable")
                .output()
                .is_ok_and(|o| o.status.success());
            if !on {
                return false;
            }
        }
        fs::write(dir.join("a.txt"), b"lower").unwrap();
        fs::write(dir.join("A.txt"), b"UPPER").unwrap();
        fs::read_dir(dir).unwrap().count() == 2
    }

    /// ⛔ Was data loss (refuter probe): `a.txt` and `A.txt` from a case-sensitive folder,
    /// merge-moved into a case-blind one — `A.txt` overwrote `a.txt`, both counted as arrived,
    /// both originals deleted. Now the second name is refused and stays in the source.
    #[test]
    fn two_names_that_differ_only_in_case_never_land_on_each_other() {
        let root = scratch("case-collision");
        let src = root.join("src");
        if !case_sensitive_folder(&src) {
            eprintln!("skipped: no case-sensitive folder available here");
            fs::remove_dir_all(root).unwrap();
            return;
        }
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("src")).unwrap();
        let done = move_merge(&src, &dest);
        let all = contents(&[&src, &dest.join("src")]);
        assert!(
            all.iter().any(|c| c == "lower") && all.iter().any(|c| c == "UPPER"),
            "both files survive somewhere: {all:?}"
        );
        assert_eq!(done.failed.len(), 1, "{:?}", done.failed);
        assert_eq!(done.failed[0].kind, FailureKind::File);
        assert_eq!(names(&src).len(), 1, "the refused one stays in the source");
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Was data loss (refuter probe): a junction in the destination leading back into the
    /// source. The merge "copied" each file onto itself through it, then deleted the only copy.
    /// The folder is not merged through a link, and stays.
    #[cfg(windows)]
    #[test]
    fn a_junction_in_the_destination_back_into_the_source_loses_nothing() {
        let root = scratch("junction-back");
        let src = root.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("sub").join("f.txt"), b"precious").unwrap();
        fs::write(src.join("other.txt"), b"o").unwrap();
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("src")).unwrap();
        junction(&dest.join("src").join("sub"), &src.join("sub"));
        let done = move_merge(&src, &dest);
        assert_eq!(
            fs::read(src.join("sub").join("f.txt")).unwrap(),
            b"precious"
        );
        assert_eq!(done.failed.len(), 1, "{:?}", done.failed);
        assert_eq!(done.failed[0].path, src.join("sub").to_string_lossy());
        assert_eq!(done.failed[0].kind, FailureKind::Folder);
        // the rest still moved, and the junction is untouched
        assert_eq!(fs::read(dest.join("src").join("other.txt")).unwrap(), b"o");
        assert!(!src.join("other.txt").exists());
        assert!(is_link_to(&dest.join("src").join("sub"), &src.join("sub")));
        ops::remove_entry(&dest.join("src").join("sub")).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    /// The delete half on its own: an "arrived" file whose copy is the original itself, reached
    /// through a junction, is never deleted — and one whose copy is missing is kept too.
    #[cfg(windows)]
    #[test]
    fn the_delete_half_refuses_an_original_that_is_its_own_copy() {
        let root = scratch("own-copy");
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("f.txt"), b"precious").unwrap();
        fs::write(src.join("g.txt"), b"g").unwrap();
        let link = root.join("link");
        junction(&link, &src);
        let cancel = AtomicBool::new(false);
        let mut progress = quiet_progress(&cancel);
        let arrived = vec![src.join("f.txt")];
        remove_arrived(&src, &link, &arrived, 0, &mut progress);
        assert_eq!(fs::read(src.join("f.txt")).unwrap(), b"precious");
        assert_eq!(progress.failed.len(), 1);
        assert_eq!(progress.failed[0].kind, FailureKind::NotRemoved);

        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let arrived = vec![src.join("g.txt")];
        remove_arrived(&src, &elsewhere, &arrived, 0, &mut progress);
        assert!(
            src.join("g.txt").exists(),
            "no copy at the destination: kept"
        );
        ops::remove_entry(&link).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Was data loss (refuter probe): after a Keep-both move whose original could not be
    /// deleted, the retry checked `dest\x.txt` — the OTHER file, the one the person kept. With
    /// the real copy (`x (2).txt`) gone, the original was deleted too.
    #[cfg(windows)]
    #[test]
    fn a_keep_both_retry_checks_the_copy_that_really_arrived() {
        let root = scratch("keep-both-retry");
        let from = root.join("from");
        let dest = root.join("dest");
        fs::create_dir_all(&from).unwrap();
        fs::create_dir_all(&dest).unwrap();
        let x = from.join("x.txt");
        fs::write(&x, b"mine").unwrap();
        fs::write(dest.join("x.txt"), b"theirs").unwrap();
        use std::os::windows::fs::OpenOptionsExt;
        let guard = File::options().read(true).share_mode(1).open(&x).unwrap();
        let (done, _) = run_quiet(
            std::slice::from_ref(&x),
            &dest,
            TransferMode::Move,
            Resolution::KeepBoth,
        );
        drop(guard);
        assert_eq!(done.failed.len(), 1, "{:?}", done.failed);
        let f = &done.failed[0];
        assert_eq!(f.kind, FailureKind::NotRemoved);
        let copy = PathBuf::from(f.copy.clone().expect("the copy is named"));
        assert_eq!(fs::read(&copy).unwrap(), b"mine");
        assert_ne!(copy, dest.join("x.txt"));

        // the copy changed since it arrived: kept
        fs::write(&copy, b"mine, edited").unwrap();
        assert_eq!(remove_originals(&done.failed).len(), 1);
        assert!(x.exists());
        // the only copy removed by the person: kept
        fs::remove_file(&copy).unwrap();
        assert_eq!(remove_originals(&done.failed).len(), 1);
        assert!(x.exists(), "the original is the only copy left");
        assert_eq!(fs::read(dest.join("x.txt")).unwrap(), b"theirs");
        fs::remove_dir_all(root).unwrap();
    }

    /// The failure comes back from the webview: one that names the original as its own copy,
    /// or a copy outside its destination, is refused whatever it says.
    #[test]
    fn a_forged_not_removed_failure_deletes_nothing() {
        let root = scratch("forged");
        let dir = root.join("dir");
        fs::create_dir_all(&dir).unwrap();
        let x = dir.join("x.txt");
        fs::write(&x, b"only").unwrap();
        let other = root.join("other");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("x.txt"), b"only").unwrap();
        let forge = |destination: &Path, copy: Option<PathBuf>| TransferFailure {
            path: x.to_string_lossy().into_owned(),
            destination: destination.to_string_lossy().into_owned(),
            error: String::new(),
            kind: FailureKind::NotRemoved,
            copy: copy.map(|c| c.to_string_lossy().into_owned()),
        };
        let cases = [
            forge(&dir, None),
            forge(&dir, Some(x.clone())),
            forge(&other, Some(x.clone())),
            // a real-looking copy, but not in the destination it names
            forge(&dir, Some(other.join("x.txt"))),
        ];
        for f in &cases {
            assert_eq!(remove_originals(std::slice::from_ref(f)).len(), 1, "{f:?}");
            assert!(x.exists(), "{f:?}");
        }
        // the honest one goes through
        let good = forge(&other, Some(other.join("x.txt")));
        let mtime = fs::metadata(&x).unwrap().modified().unwrap();
        File::options()
            .write(true)
            .open(other.join("x.txt"))
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        assert!(remove_originals(&[good]).is_empty());
        assert!(!x.exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Undo of a Keep-both move put `a (2).txt` back in its folder as `a (2).txt`: the move
    /// back landed under the copy's name. It must land under the original's name — and with
    /// Skip, never onto a new file that took that name meanwhile.
    #[test]
    fn a_move_back_lands_under_the_name_it_is_given_and_never_overwrites() {
        let root = scratch("named");
        let src = root.join("src");
        let dest = root.join("dest");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("a (2).txt"), b"moved").unwrap();
        let cancel = AtomicBool::new(false);
        let names = ["a.txt".to_string()];
        let back = |names: &[String]| {
            run_job_as(
                1,
                &[dest.join("a (2).txt")],
                &src,
                Some(names),
                TransferMode::Move,
                Resolution::Skip,
                &cancel,
                &|_| {},
            )
        };
        // the name is taken at the origin: skipped, both files untouched
        fs::write(src.join("a.txt"), b"new").unwrap();
        let done = back(&names);
        assert!(done.outputs.is_empty());
        assert_eq!(fs::read(src.join("a.txt")).unwrap(), b"new");
        assert_eq!(fs::read(dest.join("a (2).txt")).unwrap(), b"moved");
        // free: it goes back under its own name
        fs::remove_file(src.join("a.txt")).unwrap();
        let done = back(&names);
        assert_eq!(done.error, None);
        assert_eq!(done.outputs[0].to, src.join("a.txt").to_string_lossy());
        assert_eq!(fs::read(src.join("a.txt")).unwrap(), b"moved");
        assert!(!src.join("a (2).txt").exists());
        assert!(!dest.join("a (2).txt").exists());
        // a name that is not one plain file name moves nothing
        fs::write(dest.join("b.txt"), b"b").unwrap();
        for bad in ["../b.txt", "x/b.txt", "..", ""] {
            let done = run_job_as(
                1,
                &[dest.join("b.txt")],
                &src,
                Some(&[bad.to_string()]),
                TransferMode::Move,
                Resolution::Skip,
                &cancel,
                &|_| {},
            );
            assert!(done.error.is_some(), "{bad:?} was accepted");
            assert!(dest.join("b.txt").exists());
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// Copy `src` (see `tree`) into `dest` and cancel once two files' bytes have been counted:
    /// the sink sleeps past the progress throttle on every event, so each file's bytes emit
    /// one, and the cancel lands on the second file - the first has arrived, the second has not.
    fn cancel_on_the_second_file(src: &Path, dest: &Path, mode: TransferMode) -> TransferDone {
        let cancel = AtomicBool::new(false);
        let events = RefCell::new(0);
        run_job(
            1,
            &[src.to_path_buf()],
            dest,
            mode,
            Resolution::Replace,
            &cancel,
            &|_| {
                *events.borrow_mut() += 1;
                if *events.borrow() >= 3 {
                    cancel.store(true, Ordering::Relaxed);
                }
                std::thread::sleep(PROGRESS_EVERY + Duration::from_millis(50));
            },
        )
    }

    /// Every file under `dir`, relative to it, sorted.
    fn files_under(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.push(p.strip_prefix(dir).unwrap().to_path_buf());
                }
            }
        }
        out.sort();
        out
    }

    /// ⛔ A cancel in the middle of a tree left the part that landed with no undo: it was in
    /// neither `outputs` nor anywhere else. The job must name exactly what it created - for a
    /// new folder, that folder alone - and the source of a cancelled move must stay whole.
    #[test]
    fn a_cancel_inside_a_tree_names_the_new_folder_it_made() {
        for mode in [TransferMode::Copy, TransferMode::Move] {
            let root = scratch(&format!("cancel-tree-{mode:?}"));
            let src = tree(&root);
            // a move on one volume is one atomic rename (the merge test covers a move that
            // copies): there is no partway to stop at, so nothing partial may be reported
            let dest = root.join("dest");
            fs::create_dir(&dest).unwrap();
            let done = cancel_on_the_second_file(&src, &dest, mode);
            assert!(done.cancelled || mode == TransferMode::Move);
            if mode == TransferMode::Move {
                // one rename, nothing partial to undo
                assert!(done.partial.is_none());
                fs::remove_dir_all(root).unwrap();
                continue;
            }
            assert!(done.outputs.is_empty());
            let partial = done.partial.expect("the part that landed is named");
            assert_eq!(partial.from, src.to_string_lossy());
            assert_eq!(partial.to, dest.join("src").to_string_lossy());
            assert_eq!(partial.created, vec![dest.join("src").to_string_lossy()]);
            assert_eq!(files_under(&dest.join("src")).len(), 1, "one file arrived");
            fs::remove_dir_all(root).unwrap();
        }
    }

    /// The same cancel while merging into a folder that already holds the person's files: only
    /// what the job made is named, never the folder or anything that was there before - so an
    /// undo that removes the named entries leaves the folder exactly as it was. A move that
    /// merges copies too, and its cancelled source must stay whole.
    #[test]
    fn a_cancel_while_merging_names_only_what_it_made() {
        for mode in [TransferMode::Copy, TransferMode::Move] {
            let root = scratch(&format!("cancel-merge-{mode:?}"));
            let src = tree(&root);
            let dest = root.join("dest");
            let into = dest.join("src");
            fs::create_dir_all(into.join("sub")).unwrap();
            fs::write(into.join("theirs.txt"), b"t").unwrap();
            fs::write(into.join("sub").join("theirs.txt"), b"t").unwrap();
            let before = files_under(&into);
            let done = cancel_on_the_second_file(&src, &dest, mode);
            assert!(done.cancelled);
            assert!(done.outputs.is_empty());
            let partial = done.partial.expect("the part that landed is named");
            assert!(!partial.created.is_empty());
            for c in &partial.created {
                let c = Path::new(c);
                assert!(c.starts_with(&into) && c != into && c != into.join("sub"));
                assert!(!before.iter().any(|b| c.starts_with(into.join(b))));
                if c.is_dir() {
                    fs::remove_dir_all(c).unwrap();
                } else {
                    fs::remove_file(c).unwrap();
                }
            }
            assert_eq!(files_under(&into), before);
            // a cancelled move deleted nothing of its source: removing the copies is the undo
            assert_eq!(files_under(&src).len(), 3);
            fs::remove_dir_all(root).unwrap();
        }
    }

    // ── Replace keeps the old file (plan 15 G.2) ────────────────────────────────────────────

    /// A stand-in for the Recycle Bin: a folder in the scratch dir. ⛔ Never the real bin.
    fn fake_bin(bin: &Path) -> FakeBin {
        FakeBin {
            dir: bin.to_path_buf(),
            fail: None,
            refuse: None,
            block: false,
            unbin_fails: false,
        }
    }

    struct FakeBin {
        dir: PathBuf,
        /// a bin error that is NOT "no bin here" (a file held open, access denied)
        fail: Option<ErrorKind>,
        /// a bin that refuses with an `ops::NoRecycleBin` of this reason
        refuse: Option<ops::Why>,
        /// after binning, put an empty folder where the old file was, so the rename of the new
        /// file over it fails (a lock, a permission)
        block: bool,
        unbin_fails: bool,
    }

    impl Bin for FakeBin {
        fn bin(&self, path: &Path) -> Result<BinMark> {
            if let Some(kind) = self.fail {
                return Err(Error::new(kind, "the file is open in another program"));
            }
            if let Some(why) = self.refuse {
                return Err(Error::new(
                    ErrorKind::PermissionDenied,
                    ops::NoRecycleBin {
                        place: "the Trash".into(),
                        path: path.to_path_buf(),
                        why,
                        paths: vec![path.to_path_buf()],
                    },
                ));
            }
            fs::create_dir_all(&self.dir)?;
            fs::rename(path, self.dir.join(path.file_name().unwrap()))?;
            if self.block {
                fs::create_dir(path)?;
            }
            Ok(BinMark {
                at: 42,
                id: Some("item-42".into()),
            })
        }

        fn unbin(&self, path: &Path, mark: &BinMark) -> Result<()> {
            assert_eq!(mark.at, 42, "the mark `bin` gave");
            assert_eq!(mark.id.as_deref(), Some("item-42"));
            if self.unbin_fails {
                return Err(Error::other("the bin will not give it back"));
            }
            if self.block {
                fs::remove_dir(path)?;
            }
            fs::rename(self.dir.join(path.file_name().unwrap()), path)
        }
    }

    fn run_binning(
        sources: &[PathBuf],
        dest: &Path,
        mode: TransferMode,
        res: Resolution,
        bin: BinFn,
    ) -> TransferDone {
        let cancel = AtomicBool::new(false);
        run_job_binning(7, sources, dest, None, mode, res, &cancel, &|_| {}, bin)
    }

    /// ⛔ Was data loss (G.2): Replace overwrote the old file and Undo had nothing to bring back.
    #[test]
    fn replace_sends_the_old_file_to_the_bin_first() {
        for mode in [TransferMode::Copy, TransferMode::Move] {
            let root = scratch(&format!("replace-bin-{mode:?}"));
            let dest = root.join("dest");
            let bin = root.join("bin");
            fs::create_dir(&dest).unwrap();
            fs::write(root.join("a.txt"), b"new").unwrap();
            fs::write(dest.join("a.txt"), b"old").unwrap();
            let done = run_binning(
                &[root.join("a.txt")],
                &dest,
                mode,
                Resolution::Replace,
                &fake_bin(&bin),
            );
            assert_eq!(done.error, None);
            assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"new");
            assert_eq!(fs::read(bin.join("a.txt")).unwrap(), b"old", "{mode:?}");
            assert_eq!(done.outputs[0].replaced, Some(Replaced::Binned));
            assert_eq!(done.outputs[0].binned_at, Some(42));
            assert_eq!(done.outputs[0].binned_id.as_deref(), Some("item-42"));
            fs::remove_dir_all(root).unwrap();
        }
    }

    /// ⛔ Was data loss with a promise broken (G.2 review 2, A): every `NoRecycleBin` meant "no
    /// bin here, overwrite", so the Mac's Finder refusing Trove (`Why::Denied`) overwrote the old
    /// file for good right after the dialog promised the Trash. Denied now fails the item and
    /// the old file stays.
    #[test]
    fn a_trash_that_refuses_trove_keeps_the_old_file_and_fails_the_item() {
        for mode in [TransferMode::Copy, TransferMode::Move] {
            let root = scratch(&format!("replace-denied-{mode:?}"));
            let dest = root.join("dest");
            fs::create_dir(&dest).unwrap();
            fs::write(root.join("a.txt"), b"new").unwrap();
            fs::write(dest.join("a.txt"), b"old").unwrap();
            let bin = FakeBin {
                refuse: Some(ops::Why::Denied),
                ..fake_bin(&root.join("bin"))
            };
            let done = run_binning(
                &[root.join("a.txt")],
                &dest,
                mode,
                Resolution::Replace,
                &bin,
            );
            assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"old", "{mode:?}");
            assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"new", "{mode:?}");
            assert!(done.outputs.is_empty(), "{mode:?}");
            assert_eq!(done.failed.len(), 1, "{mode:?}");
            assert!(done.failed[0].error.contains("nothing was replaced"));
            assert_eq!(names(&dest), ["a.txt"], "no partial left: {mode:?}");
            fs::remove_dir_all(root).unwrap();
        }
    }

    /// The genuine no-bin reasons still overwrite with the warning (`Lost`).
    #[test]
    fn only_a_place_with_no_bin_counts_as_lost() {
        for why in [ops::Why::NoBin, ops::Why::TurnedOff, ops::Why::TooBig] {
            let root = scratch(&format!("replace-lost-{why:?}"));
            let dest = root.join("dest");
            fs::create_dir(&dest).unwrap();
            fs::write(root.join("a.txt"), b"new").unwrap();
            fs::write(dest.join("a.txt"), b"old").unwrap();
            let bin = FakeBin {
                refuse: Some(why),
                ..fake_bin(&root.join("bin"))
            };
            let done = run_binning(
                &[root.join("a.txt")],
                &dest,
                TransferMode::Copy,
                Resolution::Replace,
                &bin,
            );
            assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"new", "{why:?}");
            assert_eq!(done.outputs[0].replaced, Some(Replaced::Lost), "{why:?}");
            fs::remove_dir_all(root).unwrap();
        }
    }

    /// No bin (a share, USB, WSL): the Replace still happens, as before, and says the old file is
    /// gone for good so the frontend can warn.
    #[test]
    fn with_no_bin_replace_overwrites_and_says_the_old_file_is_lost() {
        let root = scratch("replace-no-bin");
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        fs::write(root.join("a.txt"), b"new").unwrap();
        fs::write(dest.join("a.txt"), b"old").unwrap();
        let done = run_binning(
            &[root.join("a.txt")],
            &dest,
            TransferMode::Copy,
            Resolution::Replace,
            &NoBin,
        );
        assert_eq!(done.error, None);
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"new");
        assert_eq!(done.outputs[0].replaced, Some(Replaced::Lost));
        assert_eq!(done.outputs[0].binned_at, None);
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Was data loss (G.2 review, 4): every bin error counted as "no bin", so a bin that
    /// merely failed (the old file open elsewhere) still had the old file overwritten for good.
    /// Only `NoRecycleBin` means that; any other error fails the item and keeps the old file.
    #[test]
    fn a_bin_that_fails_keeps_the_old_file_and_fails_the_item() {
        for mode in [TransferMode::Copy, TransferMode::Move] {
            let root = scratch(&format!("replace-bin-fails-{mode:?}"));
            let dest = root.join("dest");
            fs::create_dir(&dest).unwrap();
            fs::write(root.join("a.txt"), b"new").unwrap();
            fs::write(dest.join("a.txt"), b"old").unwrap();
            let bin = FakeBin {
                fail: Some(ErrorKind::PermissionDenied),
                ..fake_bin(&root.join("bin"))
            };
            let done = run_binning(
                &[root.join("a.txt")],
                &dest,
                mode,
                Resolution::Replace,
                &bin,
            );
            assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"old", "{mode:?}");
            assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"new", "{mode:?}");
            assert!(done.outputs.is_empty(), "{mode:?}");
            assert_eq!(done.failed.len(), 1, "{mode:?}");
            assert!(done.failed[0].error.contains("nothing was replaced"));
            assert_eq!(names(&dest), ["a.txt"], "no partial left: {mode:?}");
            fs::remove_dir_all(root).unwrap();
        }
    }

    /// ⛔ Was silent loss (G.2 review, 2): the old file went to the bin, then the new one could
    /// not take its place (a lock, a permission) — the place was left empty and the error said
    /// nothing. Now the old file is brought back from the bin.
    #[test]
    fn a_replace_that_cannot_land_brings_the_old_file_back() {
        for mode in [TransferMode::Copy, TransferMode::Move] {
            let root = scratch(&format!("replace-cannot-land-{mode:?}"));
            let dest = root.join("dest");
            fs::create_dir(&dest).unwrap();
            fs::write(root.join("a.txt"), b"new").unwrap();
            fs::write(dest.join("a.txt"), b"old").unwrap();
            let bin = FakeBin {
                block: true,
                ..fake_bin(&root.join("bin"))
            };
            let done = run_binning(
                &[root.join("a.txt")],
                &dest,
                mode,
                Resolution::Replace,
                &bin,
            );
            assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"old", "{mode:?}");
            assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"new", "{mode:?}");
            assert_eq!(done.failed.len(), 1, "{mode:?}");
            assert!(done.outputs.is_empty());
            assert_eq!(names(&dest), ["a.txt"], "no partial left: {mode:?}");
            fs::remove_dir_all(root).unwrap();
        }
    }

    /// The same, when the bin will not give the old file back: the item error says where it is.
    #[test]
    fn a_replace_that_cannot_land_says_the_old_file_is_in_the_bin() {
        let root = scratch("replace-cannot-land-unbin-fails");
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        fs::write(root.join("a.txt"), b"new").unwrap();
        fs::write(dest.join("a.txt"), b"old").unwrap();
        let bin = FakeBin {
            block: true,
            unbin_fails: true,
            ..fake_bin(&root.join("bin"))
        };
        let done = run_binning(
            &[root.join("a.txt")],
            &dest,
            TransferMode::Copy,
            Resolution::Replace,
            &bin,
        );
        assert_eq!(done.failed.len(), 1);
        let said = &done.failed[0].error;
        assert!(said.contains(&format!("is in the {BIN_WORD}")), "{said}");
        assert_eq!(fs::read(root.join("bin").join("a.txt")).unwrap(), b"old");
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Was data loss (G.2 review, 1): a move binned the old file BEFORE its rename. Across
    /// drives the rename fails and the move copies; a copy then cancelled (or out of space) left
    /// the destination with neither file and no undo. The old file is now binned only once the
    /// new one is ready to take its place.
    #[test]
    fn a_move_replace_across_drives_that_is_cancelled_keeps_the_old_file() {
        let root = scratch("replace-move-cross-drive");
        let dest = root.join("dest");
        let bin_dir = root.join("bin");
        fs::create_dir(&dest).unwrap();
        fs::write(root.join("a.txt"), b"new").unwrap();
        fs::write(dest.join("a.txt"), b"old").unwrap();
        let cancel = AtomicBool::new(true);
        let bin = fake_bin(&bin_dir);
        let mut progress = quiet_progress(&cancel);
        progress.bin = &bin;
        // another drive: no rename reaches the destination
        progress.rename = |_, _| Err(Error::new(ErrorKind::CrossesDevices, "another drive"));
        progress.park = progress.rename;
        progress.replacing = Some(dest.join("a.txt"));
        let err = move_any(&root.join("a.txt"), &dest.join("a.txt"), 3, &mut progress).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Interrupted);
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"old");
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"new");
        assert!(!bin_dir.exists(), "nothing went to the bin");
        assert_eq!(progress.replaced, None);
        fs::remove_dir_all(root).unwrap();
    }

    /// Across drives and not cancelled: the copy bins the old file at its last moment.
    #[test]
    fn a_move_replace_across_drives_bins_the_old_file_once_the_copy_is_whole() {
        let root = scratch("replace-move-cross-drive-ok");
        let dest = root.join("dest");
        let bin_dir = root.join("bin");
        fs::create_dir(&dest).unwrap();
        fs::write(root.join("a.txt"), b"new").unwrap();
        fs::write(dest.join("a.txt"), b"old").unwrap();
        let cancel = AtomicBool::new(false);
        let bin = fake_bin(&bin_dir);
        let mut progress = quiet_progress(&cancel);
        progress.bin = &bin;
        progress.track_arrived = true;
        progress.rename = |_, _| Err(Error::new(ErrorKind::CrossesDevices, "another drive"));
        progress.park = progress.rename;
        progress.replacing = Some(dest.join("a.txt"));
        move_any(&root.join("a.txt"), &dest.join("a.txt"), 3, &mut progress).unwrap();
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"new");
        assert_eq!(fs::read(bin_dir.join("a.txt")).unwrap(), b"old");
        assert!(!root.join("a.txt").exists());
        assert_eq!(progress.replaced, Some(Replaced::Binned));
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ (G.2 review, 6) A file moved onto itself by another path (`\\localhost\C$\x\a.txt` onto
    /// `C:\x`; here a hard link, the same file under two names) was "the old file" and went to
    /// the bin — the very file being moved. One file on disk is never binned as its own old copy.
    #[test]
    fn a_target_that_is_the_source_by_another_path_is_never_binned() {
        let root = scratch("replace-itself-other-path");
        let dest = root.join("dest");
        let bin_dir = root.join("bin");
        fs::create_dir(&dest).unwrap();
        fs::write(root.join("a.txt"), b"mine").unwrap();
        fs::hard_link(root.join("a.txt"), dest.join("a.txt")).unwrap();
        let done = run_binning(
            &[root.join("a.txt")],
            &dest,
            TransferMode::Move,
            Resolution::Replace,
            &fake_bin(&bin_dir),
        );
        assert!(!bin_dir.exists(), "nothing went to the bin");
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"mine");
        assert!(done.outputs.iter().all(|o| o.replaced.is_none()));
        fs::remove_dir_all(root).unwrap();
    }

    /// The bin item a Replace made is picked by its mark: the oldest of its path at or after it.
    #[test]
    fn pick_replaced_takes_the_oldest_item_at_or_after_the_mark() {
        let item = |id: &str, t: i64| trash::TrashItem {
            id: id.into(),
            name: "a.txt".into(),
            original_parent: PathBuf::from("dir"),
            time_deleted: t,
        };
        let items = [item("v1", 10), item("v2", 20), item("v3", 30)];
        let path = Path::new("dir").join("a.txt");
        let id = |at, taken: &[std::ffi::OsString]| {
            pick_replaced(&items, &path, &BinMark { at, id: None }, taken).map(|i| i.id)
        };
        assert_eq!(id(10, &[]), Some("v1".into()));
        assert_eq!(id(15, &[]), Some("v2".into()));
        assert_eq!(id(10, &["v1".into()]), Some("v2".into()));
        assert_eq!(id(31, &[]), None);
        let anywhere = BinMark::default();
        assert_eq!(
            pick_replaced(&items, Path::new("other"), &anywhere, &[]),
            None
        );
    }

    /// ⛔ Was the wrong file back (G.2 review 2, B): the Windows bin keeps whole seconds, so after
    /// Undo, Redo, Undo of a Copy-Replace in one second the copy (binned by the first undo) and
    /// the old file (binned by the redo) sit under one path with one time, and the mark could
    /// pick the copy. With an id the undo takes the item its own Replace made, whatever the time.
    #[test]
    fn pick_replaced_by_id_takes_its_own_item_in_the_same_second() {
        let item = |id: &str| trash::TrashItem {
            id: id.into(),
            name: "a.txt".into(),
            original_parent: PathBuf::from("dir"),
            time_deleted: 50,
        };
        let items = [item("copy-binned-by-undo"), item("old-binned-by-redo")];
        let path = Path::new("dir").join("a.txt");
        let mark = |id: &str| BinMark {
            at: 50,
            id: Some(id.into()),
        };
        let got = pick_replaced(&items, &path, &mark("old-binned-by-redo"), &[]).map(|i| i.id);
        assert_eq!(got, Some("old-binned-by-redo".into()));
        let got = pick_replaced(&items, &path, &mark("copy-binned-by-undo"), &[]).map(|i| i.id);
        assert_eq!(got, Some("copy-binned-by-undo".into()));
        // an id no longer in the bin is never replaced by a guess
        assert_eq!(pick_replaced(&items, &path, &mark("emptied"), &[]), None);
        // nor is the id of another path
        let other = Path::new("dir").join("b.txt");
        assert_eq!(
            pick_replaced(&items, &other, &mark("old-binned-by-redo"), &[]),
            None
        );
    }

    /// The id a bin gives is the one item of the path that appeared; none when several did.
    #[test]
    fn new_item_id_is_the_one_item_that_appeared() {
        let item = |id: &str, name: &str| trash::TrashItem {
            id: id.into(),
            name: name.into(),
            original_parent: PathBuf::from("dir"),
            time_deleted: 50,
        };
        let path = Path::new("dir").join("a.txt");
        let ids = |items: &[trash::TrashItem]| -> std::collections::HashSet<std::ffi::OsString> {
            items.iter().map(|i| i.id.clone()).collect()
        };
        let before = [item("1", "a.txt"), item("2", "b.txt")];
        let after = [
            item("1", "a.txt"),
            item("2", "b.txt"),
            item("3", "b.txt"),
            item("4", "a.txt"),
        ];
        assert_eq!(new_item_id(&ids(&before), &after, &path), Some("4".into()));
        assert_eq!(new_item_id(&ids(&before), &before, &path), None);
        let two = [item("1", "a.txt"), item("4", "a.txt"), item("5", "a.txt")];
        assert_eq!(new_item_id(&ids(&before), &two, &path), None);
    }

    /// One job reads the bin once more than it has files, not twice per file, and each file
    /// still gets the id of its own item.
    #[test]
    fn a_job_reads_the_bin_n_plus_one_times_for_n_files() {
        use std::cell::{Cell, RefCell};
        let item = |id: usize, name: &str| trash::TrashItem {
            id: id.to_string().into(),
            name: name.into(),
            original_parent: PathBuf::from("dir"),
            time_deleted: 50,
        };
        let bin_items: RefCell<Vec<trash::TrashItem>> = RefCell::new(vec![item(0, "old.txt")]);
        let reads = Cell::new(0usize);
        let sent = Cell::new(0usize);
        let names = ["a.txt", "b.txt", "c.txt"];
        let seen = RefCell::new(None);
        let mut ids = Vec::new();
        for name in names {
            let path = Path::new("dir").join(name);
            let mark = bin_listed(
                &seen,
                &|| {
                    reads.set(reads.get() + 1);
                    Some(bin_items.borrow().clone())
                },
                &|| {
                    sent.set(sent.get() + 1);
                    bin_items.borrow_mut().push(item(sent.get(), name));
                    Ok(())
                },
                &path,
            )
            .unwrap();
            ids.push(mark.id);
        }
        assert_eq!(reads.get(), names.len() + 1);
        assert_eq!(ids, [Some("1".into()), Some("2".into()), Some("3".into())]);
    }

    /// Only a file written over a file is binned: a new name, a Keep both, and a folder Replace
    /// (a merge — nothing whole is overwritten) never call the bin and carry no `replaced`.
    #[test]
    fn nothing_but_a_replaced_file_goes_to_the_bin() {
        let root = scratch("replace-bin-only-files");
        let dest = root.join("dest");
        let bin = root.join("bin");
        fs::create_dir(&dest).unwrap();
        let src = tree(&root);
        fs::create_dir_all(dest.join("src")).unwrap();
        fs::write(dest.join("src").join("a.txt"), b"old").unwrap();
        fs::write(root.join("b.txt"), b"b").unwrap();
        let done = run_binning(
            &[src, root.join("b.txt")],
            &dest,
            TransferMode::Copy,
            Resolution::Replace,
            &fake_bin(&bin),
        );
        assert_eq!(done.error, None);
        assert!(done.outputs.iter().all(|o| o.replaced.is_none()));
        assert!(!bin.exists(), "the bin was never called");

        fs::write(root.join("b.txt"), b"b2").unwrap();
        let done = run_binning(
            &[root.join("b.txt")],
            &dest,
            TransferMode::Copy,
            Resolution::KeepBoth,
            &fake_bin(&bin),
        );
        assert_eq!(done.outputs[0].replaced, None);
        assert!(!bin.exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// The old file is binned only once the new bytes are whole: a copy cancelled midway leaves
    /// it where it was and the bin untouched.
    #[test]
    fn a_cancelled_replace_never_bins_the_old_file() {
        let root = scratch("replace-bin-cancel");
        let dest = root.join("dest");
        let bin = root.join("bin");
        fs::create_dir(&dest).unwrap();
        fs::write(root.join("a.txt"), b"new").unwrap();
        fs::write(dest.join("a.txt"), b"old").unwrap();
        let cancel = AtomicBool::new(true);
        let binning = fake_bin(&bin);
        let mut progress = quiet_progress(&cancel);
        progress.bin = &binning;
        progress.replacing = Some(dest.join("a.txt"));
        let err = copy_file(&root.join("a.txt"), &dest.join("a.txt"), &mut progress).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Interrupted);
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"old");
        assert!(!bin.exists());
        assert_eq!(progress.replaced, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replaced_serializes_in_kebab_case_and_is_absent_otherwise() {
        let out = |replaced| TransferOutput {
            from: "a".into(),
            to: "b".into(),
            replaced,
            binned_at: None,
            binned_id: None,
        };
        let json = serde_json::to_value(out(Some(Replaced::Binned))).unwrap();
        assert_eq!(json["replaced"], "binned");
        let json = serde_json::to_value(out(Some(Replaced::Lost))).unwrap();
        assert_eq!(json["replaced"], "lost");
        let json = serde_json::to_value(out(None)).unwrap();
        assert!(json.get("replaced").is_none());
    }

    /// ⛔ (G.2 review 4, 1) Two Replace moves to one name picked the same park name, and the
    /// second rename wrote over the first one's parked file. Here another job takes the picked
    /// name in the instant between the pick and the rename: its file keeps its bytes, and the
    /// move parks under the next free name and lands.
    #[test]
    fn a_park_never_writes_over_a_name_taken_between_pick_and_rename() {
        static RACED: AtomicBool = AtomicBool::new(false);
        let root = scratch("replace-park-race");
        let dest = root.join("dest");
        let bin_dir = root.join("bin");
        fs::create_dir(&dest).unwrap();
        fs::write(root.join("a.txt"), b"new").unwrap();
        fs::write(dest.join("a.txt"), b"old").unwrap();
        let cancel = AtomicBool::new(false);
        let bin = fake_bin(&bin_dir);
        let mut progress = quiet_progress(&cancel);
        progress.bin = &bin;
        progress.job_id = 7;
        progress.park = |from, to| {
            if !RACED.swap(true, Ordering::SeqCst) {
                fs::write(to, b"theirs").unwrap();
            }
            parked::rename_no_replace(from, to)
        };
        progress.replacing = Some(dest.join("a.txt"));
        move_any(&root.join("a.txt"), &dest.join("a.txt"), 3, &mut progress).unwrap();
        assert!(RACED.load(Ordering::SeqCst));
        assert_eq!(
            fs::read(dest.join(park_name("a.txt", 7))).unwrap(),
            b"theirs",
            "the other job's file is whole"
        );
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"new");
        assert_eq!(fs::read(bin_dir.join("a.txt")).unwrap(), b"old");
        assert!(!root.join("a.txt").exists());
        let second = park_name("a.txt", 7).replace(".trove-parked", " (2).trove-parked");
        assert!(!dest.join(second).exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ (G.2 review 6, 2) Job ids start at 1 every launch: a park name without the launch in
    /// it repeated a crash leftover's from an earlier run. The same job in two runs parks under
    /// two names, and this run's name is the same for every call.
    #[test]
    fn park_names_differ_between_launches() {
        assert_ne!(
            park_name_in("a.txt", "1f2a", 1),
            park_name_in("a.txt", "3c4b", 1)
        );
        assert_ne!(
            park_name_in("a.txt", "1f2a", 1),
            park_name_in("a.txt", "1f2a", 2)
        );
        assert_eq!(park_name("a.txt", 1), park_name("a.txt", 1));
        let name = park_name("a.txt", 1);
        assert!(
            name.starts_with(".a.txt.") && name.ends_with("-1.trove-parked"),
            "{name}"
        );
        assert!(name.contains(launch_token()), "{name}");
    }

    /// ⛔ (G.2 review 4, 3) A park the journal could not note went ahead anyway: a crash then
    /// left the file hidden with nothing pointing at it. Now there is no park, and the move
    /// takes the copy way, which needs none.
    #[test]
    fn a_park_the_journal_cannot_note_is_not_made() {
        let root = scratch("replace-park-unnoted");
        let dest = root.join("dest");
        let bin_dir = root.join("bin");
        fs::create_dir(&dest).unwrap();
        fs::write(root.join("a.txt"), b"new").unwrap();
        fs::write(dest.join("a.txt"), b"old").unwrap();
        let cancel = AtomicBool::new(false);
        let bin = fake_bin(&bin_dir);
        let mut progress = quiet_progress(&cancel);
        progress.bin = &bin;
        progress.track_arrived = true;
        progress.note_park = |_| false;
        progress.park = |_, _| panic!("parked with no journal entry");
        assert_eq!(
            park_beside(&root.join("a.txt"), &dest.join("a.txt"), &progress),
            None
        );
        progress.replacing = Some(dest.join("a.txt"));
        move_any(&root.join("a.txt"), &dest.join("a.txt"), 3, &mut progress).unwrap();
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"new");
        assert_eq!(fs::read(bin_dir.join("a.txt")).unwrap(), b"old");
        assert!(!root.join("a.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ (G.2 review 4, 1) A parked file going back where it came from was renamed over whatever
    /// had appeared there meanwhile. Now that file stays, and the parked one comes back beside
    /// it as `name (recovered).ext`; the error says where.
    #[test]
    fn an_unpark_onto_a_taken_source_keeps_both() {
        let root = scratch("unpark-taken");
        let parked = root.join(".a.txt.1.trove-parked");
        let source = root.join("a.txt");
        fs::write(&parked, b"moved").unwrap();
        fs::write(&source, b"made meanwhile").unwrap();
        let e = unpark(&parked, &source, Error::other("the bin said no"));
        assert_eq!(fs::read(&source).unwrap(), b"made meanwhile");
        let back = root.join("a (recovered).txt");
        assert_eq!(fs::read(&back).unwrap(), b"moved");
        assert!(!parked.exists());
        assert!(e.to_string().contains(&back.display().to_string()), "{e}");
        // the usual case: the source is free, the file goes back under its own name
        fs::write(&parked, b"again").unwrap();
        fs::remove_file(&source).unwrap();
        let e = unpark(&parked, &source, Error::other("the bin said no"));
        assert_eq!(e.to_string(), "the bin said no");
        assert_eq!(fs::read(&source).unwrap(), b"again");
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ (G.2 review 4, 6) The bin was read before and after, the send said yes, and no item of
    /// the path appeared (a bin over its size deletes for good): that was `Binned`, and nobody
    /// was warned. It is a no-bin error now, which a Replace reports as `Lost`.
    #[test]
    fn a_send_that_left_no_bin_item_is_lost() {
        let item = |id: &str, name: &str| trash::TrashItem {
            id: id.into(),
            name: name.into(),
            original_parent: PathBuf::from("dir"),
            time_deleted: 50,
        };
        let seen = std::cell::RefCell::new(None);
        let path = Path::new("dir").join("a.txt");
        let e = bin_listed(
            &seen,
            &|| Some(vec![item("1", "a.txt"), item("2", "b.txt")]),
            &|| Ok(()),
            &path,
        )
        .unwrap_err();
        assert!(is_bin_less(&e), "{e}");
        assert!(
            seen.borrow().is_some(),
            "the read is kept for the next file"
        );
        // a bin that cannot be read (the Mac Trash) still trusts the send
        let seen = std::cell::RefCell::new(None);
        let mark = bin_listed(&seen, &|| None, &|| Ok(()), &path).unwrap();
        assert_eq!(mark.id, None);
    }

    /// A folder link to `target` at `link`: a junction on Windows, a symlink elsewhere.
    fn folder_link(link: &Path, target: &Path) {
        #[cfg(windows)]
        junction(link, target);
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// ⛔ (G.2 review 6, 1) Was `Lost`: the `trash` crate resolves the path before it deletes, so
    /// a file in a folder reached through a link (Silverblue's `/home` -> `/var/home`) lands in
    /// the bin under its REAL folder. The send is found under either form, and Undo finds it.
    #[test]
    fn a_bin_item_under_the_real_folder_is_the_files() {
        let root = scratch("bin-real-folder");
        let real = root.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = root.join("link");
        folder_link(&link, &real);
        let path = link.join("a.txt");
        fs::write(&path, b"old").unwrap();
        let real_parent = plain_path(fs::canonicalize(&real).unwrap());
        assert!(!real_parent.to_string_lossy().starts_with(r"\\?\"));
        let item = |id: &str, parent: &Path| trash::TrashItem {
            id: id.into(),
            name: "a.txt".into(),
            original_parent: parent.to_path_buf(),
            time_deleted: 50,
        };
        let bin = RefCell::new(vec![item("0", &root)]);
        let seen = RefCell::new(None);
        let mark = bin_listed(
            &seen,
            &|| Some(bin.borrow().clone()),
            &|| {
                fs::remove_file(&path)?;
                bin.borrow_mut().push(item("1", &real_parent));
                Ok(())
            },
            &path,
        )
        .expect("a send under the real folder is binned, not lost");
        assert_eq!(mark.id.as_deref(), Some("1"));
        let got = pick_replaced(&bin.borrow(), &path, &mark, &[]).map(|i| i.id);
        assert_eq!(got, Some("1".into()));
        // the path as given still matches (the Windows bin keeps it so)
        let given = [item("2", &link)];
        let none = std::collections::HashSet::new();
        assert_eq!(new_item_id(&none, &given, &path), Some("2".into()));
        // another folder's item is not the file's
        let other = [item("3", &root)];
        assert_eq!(new_item_id(&none, &other, &path), None);
        fs::remove_dir_all(root).unwrap();
    }

    /// ⛔ Undo worked the path forms out again: with the linked folder deleted since the Replace,
    /// the real form was gone and the item "was not in the bin". With an id it is found by id.
    #[test]
    fn unbin_finds_the_item_by_id_after_the_link_is_gone() {
        let root = scratch("unbin-link-gone");
        let real = root.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = root.join("link");
        folder_link(&link, &real);
        let path = link.join("a.txt");
        fs::write(&path, b"old").unwrap();
        let real_parent = plain_path(fs::canonicalize(&real).unwrap());
        let item = |id: &str| trash::TrashItem {
            id: id.into(),
            name: "a.txt".into(),
            original_parent: real_parent.clone(),
            time_deleted: 50,
        };
        let items = [item("other"), item("mine")];
        let mark = |id: Option<&str>| BinMark {
            at: 50,
            id: id.map(str::to_string),
        };
        // the link and the real folder go; the item stays in the bin
        #[cfg(windows)]
        fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        fs::remove_file(&link).unwrap();
        fs::remove_dir_all(&real).unwrap();
        let got = pick_for_unbin(&items, &path, &mark(Some("mine"))).map(|i| i.id);
        assert_eq!(got, Some("mine".into()));
        // an id no longer in the bin is never replaced by a guess
        assert_eq!(pick_for_unbin(&items, &path, &mark(Some("gone"))), None);
        // without an id the path forms still decide: the real form is gone, so nothing matches
        assert_eq!(pick_for_unbin(&items, &path, &mark(None)), None);
        fs::remove_dir_all(root).unwrap();
    }

    /// The verbatim prefix `canonicalize` puts on Windows paths is taken off; others are kept.
    #[test]
    fn plain_path_drops_the_verbatim_prefix() {
        let plain = |s: &str| plain_path(PathBuf::from(s)).to_string_lossy().into_owned();
        assert_eq!(plain(r"\\?\C:\x\a.txt"), r"C:\x\a.txt");
        assert_eq!(
            plain(r"\\?\UNC\server\share\a.txt"),
            r"\\server\share\a.txt"
        );
        assert_eq!(plain("/var/home/a.txt"), "/var/home/a.txt");
        // a volume path is not a drive or a share: left as it is
        assert_eq!(
            plain(r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\x\a.txt"),
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\x\a.txt"
        );
    }
}

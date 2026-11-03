//! An archive job: the same progress / done events as a copy (`core/transfer.rs`), so the
//! progress panel, Cancel and Undo need no fork — plus the extract engine every format feeds.
//!
//! The engine's rules (plan 16, "Design in one screen"):
//! - every entry name goes through `safe_path` first; a refused one is a failure row, never
//!   renamed into something "safe";
//! - every file is written as a partial beside its target and renamed into place only when
//!   whole: a cancel or a failure leaves no half file that looks finished, and a failed Replace
//!   leaves the old file whole;
//! - only an explicit Replace may replace; every other final rename is `rename_no_replace`;
//! - a folder Replace is a merge: the archive's files go into the existing folder, the person's
//!   other files there stay, and no folder is ever removed to make room;
//! - Cancel removes only the partial being written; what already landed stays and is listed in
//!   `outputs`, so Undo can put it in the bin.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Error, ErrorKind, Read, Result, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

use super::{
    apply_origin_marker, archive_stem, free_space, origin_marker, rename_no_replace, safe_path,
    sevenz_fmt, tar_fmt, zip_fmt, ArchiveFormat, Format,
};
use crate::core::ops;
use crate::core::transfer::{
    replace_with, FailureKind, Partial, Resolution, TransferFailure, TransferProgress,
    PROGRESS_EVERY,
};

const BUFFER: usize = 1024 * 1024;

/// The panel's 100 ms throttle; zero in tests, so a test sees every `add` as an event and can
/// tell "progress moved" from "only the opening total was sent".
const EVERY: Duration = if cfg!(test) {
    Duration::ZERO
} else {
    PROGRESS_EVERY
};

/// One thing an archive job made or replaced. Mirrors `TransferOutput` plus `created`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveOutput {
    /// the archive (extract) or the first source (compress)
    pub from: String,
    pub to: String,
    /// true: this job made it, so Undo may put it in the bin. false: it replaced a file the
    /// person had; Undo leaves it alone (taste Q5: no undo of a Replace).
    pub created: bool,
}

/// `transfer:done` for an archive job: the same shape as `TransferDone`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDone {
    pub job_id: u64,
    pub outputs: Vec<ArchiveOutput>,
    pub failed: Vec<TransferFailure>,
    pub error: Option<String>,
    pub cancelled: bool,
}

/// Progress for one archive job: bytes, at most one event per 100 ms, and the cancel flag.
pub struct ArchiveProgress<'a> {
    job_id: u64,
    done: u64,
    total: u64,
    current: String,
    last: Option<Instant>,
    sink: &'a dyn Fn(TransferProgress),
    cancel: &'a AtomicBool,
    pub(crate) failed: Vec<TransferFailure>,
    /// entries met (extract) or files sized (compress): the "of M" in the summary
    pub(crate) items: u64,
}

impl<'a> ArchiveProgress<'a> {
    pub fn new(job_id: u64, cancel: &'a AtomicBool, sink: &'a dyn Fn(TransferProgress)) -> Self {
        ArchiveProgress {
            job_id,
            done: 0,
            total: 0,
            current: String::new(),
            last: None,
            sink,
            cancel,
            failed: Vec::new(),
            items: 0,
        }
    }

    pub(crate) fn set_total(&mut self, total: u64) {
        self.total = total;
        self.emit();
    }

    pub(crate) fn set_current(&mut self, current: &str) {
        current.clone_into(&mut self.current);
    }

    fn emit(&mut self) {
        self.last = Some(Instant::now());
        (self.sink)(TransferProgress {
            job_id: self.job_id,
            bytes_done: self.done,
            bytes_total: self.total,
            current: self.current.clone(),
        });
    }

    pub(crate) fn add(&mut self, bytes: u64) {
        self.done = self.done.saturating_add(bytes);
        if self.last.is_none_or(|t| t.elapsed() >= EVERY) {
            self.emit();
        }
    }

    pub(crate) fn check_cancel(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(Error::new(ErrorKind::Interrupted, "cancelled"))
        } else {
            Ok(())
        }
    }

    fn is_cancel(&self, e: &Error) -> bool {
        e.kind() == ErrorKind::Interrupted && self.cancel.load(Ordering::Relaxed)
    }

    pub(crate) fn fail(&mut self, path: &str, destination: &Path, error: String) {
        self.failed.push(TransferFailure {
            path: path.to_string(),
            destination: destination.to_string_lossy().into_owned(),
            error,
            kind: FailureKind::File,
            copy: None,
        });
    }
}

/// One entry as a format reader lists it.
#[derive(Debug, Clone)]
pub(crate) struct EntryInfo {
    pub index: usize,
    /// the raw name inside the archive, `/` or `\` separated
    pub name: String,
    pub is_dir: bool,
    /// uncompressed bytes the archive declares; more than this is refused while writing
    pub size: u64,
    pub encrypted: bool,
    pub link: bool,
    /// a device, a FIFO or another kind that is neither file, folder nor link (tar): not made
    pub special: bool,
    /// unix permission bits, when the entry carries them (applied off Windows, `& 0o777`)
    #[cfg_attr(windows, allow(dead_code))]
    pub mode: Option<u32>,
    pub modified: Option<SystemTime>,
}

/// The bytes of one entry, handed to the engine by `Source::each`.
pub(crate) type Visit<'v> = dyn FnMut(usize, &mut dyn Read) -> Result<()> + 'v;

/// What a format reader gives the extract engine.
///
/// A zip can open any entry at any time (`open`); a compressed tar is one stream that can only
/// be read front to back. So the engine never asks for an entry by itself: it lists them all
/// (`entries`), then lets the reader walk the wanted ones in archive order (`each`).
pub(crate) trait Source {
    fn entries(&mut self) -> Result<Vec<EntryInfo>>;

    /// One entry's bytes, for a reader that can seek (zip). A stream reader overrides `each`.
    fn open(&mut self, _index: usize) -> Result<Box<dyn Read + '_>> {
        Err(Error::new(
            ErrorKind::Unsupported,
            "entry cannot be opened alone",
        ))
    }

    /// Call `visit` with every index in `wanted` (ascending, from `entries`) and its bytes.
    /// An entry that cannot be opened still reaches `visit`, as a reader that fails, so it is
    /// one failure row and the rest still extract. An error from `visit` stops the walk.
    fn each(&mut self, wanted: &[usize], visit: &mut Visit) -> Result<()> {
        for &index in wanted {
            match self.open(index) {
                Ok(mut reader) => visit(index, &mut reader)?,
                Err(e) => visit(index, &mut FailingRead(Some(e)))?,
            }
        }
        Ok(())
    }
}

/// A reader whose first read returns the error an entry failed to open with.
struct FailingRead(Option<Error>);
impl Read for FailingRead {
    fn read(&mut self, _: &mut [u8]) -> Result<usize> {
        Err(self
            .0
            .take()
            .unwrap_or_else(|| Error::other("entry cannot be read")))
    }
}

/// The reader for `archive`. `cancel` reaches a stream reader whose listing pass decompresses
/// the whole archive (tar.*), so Cancel works during it too.
pub(crate) fn open_source<'c>(
    archive: &Path,
    cancel: Option<&'c AtomicBool>,
) -> Result<Box<dyn Source + 'c>> {
    let format = Format::detect(archive)?;
    format.ensure_supported()?;
    match format {
        Format::Zip => Ok(Box::new(zip_fmt::ZipSource::open(archive)?)),
        Format::SevenZ => Ok(Box::new(sevenz_fmt::SevenZSource::open(archive, cancel)?)),
        Format::Tar(codec) => Ok(Box::new(tar_fmt::TarSource::open(archive, codec, cancel)?)),
        _ => Err(Error::new(ErrorKind::Unsupported, "not supported yet")),
    }
}

/// True for a folder entry that names the archive's own top (`./`, `.`): tar makes one for
/// `tar -C dir .`. Nothing to make and nothing unsafe, so not a failure row either.
fn is_root_folder(info: &EntryInfo) -> bool {
    info.is_dir
        && info
            .name
            .replace('\\', "/")
            .split('/')
            .all(|p| p.is_empty() || p == ".")
}

/// How two target names compare for "this job already wrote that": NTFS and default APFS are
/// case-insensitive, so `A.txt` and `a.txt` are one file there; Linux file systems are not, so
/// there the names are matched exactly. ⚠️ Case only — an NFC / NFD pair (`é` two ways) on
/// APFS is not folded (no normalization crate in the build).
fn fold(path: &Path) -> String {
    fold_name(&path.to_string_lossy())
}

fn fold_name(name: &str) -> String {
    if cfg!(any(windows, target_os = "macos")) {
        name.to_lowercase()
    } else {
        name.to_owned()
    }
}

/// The entry's parts relative to where it lands: all of them, or — when the job extracts only
/// some entries (`filter`) — from the selected entry's own name down.
fn relative_parts(parts: &[String], filter: &[Vec<String>]) -> Option<Vec<String>> {
    if filter.is_empty() {
        return Some(parts.to_vec());
    }
    filter
        .iter()
        .find(|f| parts.starts_with(f))
        .map(|f| parts[f.len() - 1..].to_vec())
}

/// macOS Finder's resource-fork folder (taste Q6: skipped, as Archive Utility hides it).
fn is_mac_junk(parts: &[String]) -> bool {
    parts.first().is_some_and(|p| p == "__MACOSX")
}

/// What the job does with one top-level name of the archive.
#[derive(Debug, Clone)]
enum TopPlan {
    Skip,
    Fail(String),
    /// land under `name` in the destination; `replace`: same-named files there are replaced
    Into {
        name: String,
        replace: bool,
    },
}

/// Top-level names of `entries` that already exist in `destination` — what the conflict
/// dialog asks about. Each listed once, as the full target path.
pub fn conflicts(
    archive: &Path,
    destination: &Path,
    filter: Option<&[String]>,
) -> Result<Vec<String>> {
    let mut source = open_source(archive, None)?;
    let filter = parse_filter(filter);
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for info in source.entries()? {
        let Ok(parts) = safe_path::entry_parts(&info.name) else {
            continue;
        };
        if is_mac_junk(&parts) {
            continue;
        }
        let Some(rel) = relative_parts(&parts, &filter) else {
            continue;
        };
        let target = destination.join(&rel[0]);
        if seen.insert(fold(&target)) && fs::symlink_metadata(&target).is_ok() {
            found.push(target.to_string_lossy().into_owned());
        }
    }
    Ok(found)
}

fn parse_filter(filter: Option<&[String]>) -> Vec<Vec<String>> {
    filter
        .unwrap_or_default()
        .iter()
        .filter_map(|f| safe_path::entry_parts(f).ok())
        .collect()
}

/// What landed, kept even when the job stops midway, so Undo always sees it.
#[derive(Default)]
struct Landed {
    /// files and folders this job made, parents before children
    created: Vec<PathBuf>,
    created_keys: HashSet<String>,
    /// files that replaced one the person had
    replaced: Vec<PathBuf>,
    /// every file target this job wrote (folded), for "two entries, one target"
    written: HashSet<String>,
}

impl Landed {
    fn make(&mut self, path: &Path) {
        self.created_keys.insert(fold(path));
        self.created.push(path.to_path_buf());
    }

    /// The created paths with no created ancestor (a new folder stands for all inside it),
    /// then the replaced files. A merged folder that existed before is never listed.
    fn outputs(&self, archive: &Path) -> Vec<ArchiveOutput> {
        let from = archive.to_string_lossy().into_owned();
        let topmost = self.created.iter().filter(|p| {
            !p.ancestors()
                .skip(1)
                .any(|a| self.created_keys.contains(&fold(a)))
        });
        topmost
            .map(|p| (p, true))
            .chain(self.replaced.iter().map(|p| (p, false)))
            .map(|(p, created)| ArchiveOutput {
                from: from.clone(),
                to: p.to_string_lossy().into_owned(),
                created,
            })
            .collect()
    }
}

fn human(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes as f64 >= 1024.0 * MB {
        format!("{:.1} GB", bytes as f64 / (1024.0 * MB))
    } else {
        format!("{:.1} MB", bytes as f64 / MB)
    }
}

/// Everything an extract needs besides the reader.
pub(crate) struct ExtractJob<'a> {
    pub archive: &'a Path,
    pub dest: &'a Path,
    pub filter: Option<&'a [String]>,
    pub resolution: Resolution,
    /// free bytes on a volume; injected so a test can fake a full disk
    pub free: &'a dyn Fn(&Path) -> Option<u64>,
}

fn extract_from(
    source: &mut dyn Source,
    job: &ExtractJob,
    progress: &mut ArchiveProgress,
    landed: &mut Landed,
) -> Result<()> {
    let dest = job.dest;
    if !fs::metadata(dest).is_ok_and(|m| m.is_dir()) {
        return Err(Error::new(
            ErrorKind::NotFound,
            "The destination folder is not there",
        ));
    }
    let filter = parse_filter(job.filter);
    let mut planned = Vec::new();
    for info in source.entries()? {
        if is_root_folder(&info) {
            continue;
        }
        match safe_path::entry_parts(&info.name) {
            Ok(parts) if is_mac_junk(&parts) => {}
            Ok(parts) => {
                if let Some(rel) = relative_parts(&parts, &filter) {
                    planned.push((info, Ok(rel)));
                }
            }
            // a refused name is still met (and reported) when nothing filters it out
            Err(e) if filter.is_empty() => planned.push((info, Err(e))),
            Err(_) => {}
        }
    }
    // saturating: sizes are what the archive CLAIMS; a crafted one whose sizes add up past
    // 2^64 must not wrap to a small total and slip under the free-space check
    let total: u64 = planned
        .iter()
        .filter(|(i, _)| !i.is_dir)
        .fold(0u64, |t, (i, _)| t.saturating_add(i.size));
    progress.items = planned.len() as u64;
    if let Some(free) = (job.free)(dest) {
        if total > free {
            return Err(Error::new(
                ErrorKind::StorageFull,
                format!(
                    "Not enough free space: the archive needs {}, the destination has {}",
                    human(total),
                    human(free)
                ),
            ));
        }
    }
    progress.set_total(total);

    // a top-level name is a folder when any entry goes below it
    let mut top_is_dir: HashMap<String, bool> = HashMap::new();
    for (info, parts) in &planned {
        if let Ok(parts) = parts {
            let d = top_is_dir.entry(fold_name(&parts[0])).or_default();
            *d |= parts.len() > 1 || info.is_dir;
        }
    }
    let marker = origin_marker(job.archive);
    let mut tops: HashMap<String, TopPlan> = HashMap::new();
    // folders this job made from a folder entry carrying a mode: set at the very end, deepest
    // first, so a `0o555` folder cannot lock its own children out halfway through the job
    let mut dir_modes: Vec<(PathBuf, u32)> = Vec::new();
    let wanted: Vec<usize> = planned.iter().map(|(info, _)| info.index).collect();
    let mut planned = planned.into_iter();
    let walked = source.each(&wanted, &mut |index, reader| {
        let Some((info, parts)) = planned.next() else {
            return Ok(());
        };
        debug_assert_eq!(info.index, index);
        let entry = Entry {
            info,
            parts,
            reader,
        };
        extract_entry(
            entry,
            job,
            &mut tops,
            &top_is_dir,
            marker.as_deref(),
            &mut dir_modes,
            progress,
            landed,
        )
    });
    apply_dir_modes(&mut dir_modes);
    walked?;
    progress.set_current("");
    Ok(())
}

/// Folder modes from the archive, deepest folder first (unix; Windows has none to set).
fn apply_dir_modes(dir_modes: &mut [(PathBuf, u32)]) {
    dir_modes.sort_by_key(|(p, _)| std::cmp::Reverse(p.components().count()));
    #[cfg(unix)]
    for (dir, mode) in dir_modes.iter() {
        use std::os::unix::fs::PermissionsExt;
        // never setuid / setgid / sticky from an archive
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(mode & 0o777));
    }
}

/// One planned entry and its bytes.
struct Entry<'r> {
    info: EntryInfo,
    parts: Result<Vec<String>>,
    reader: &'r mut dyn Read,
}

/// One planned entry: a failure row, a skip, a folder or a file written from its reader.
/// `Err` only for a cancel, which stops the job.
#[allow(clippy::too_many_arguments)]
fn extract_entry(
    entry: Entry,
    job: &ExtractJob,
    tops: &mut HashMap<String, TopPlan>,
    top_is_dir: &HashMap<String, bool>,
    marker: Option<&[u8]>,
    dir_modes: &mut Vec<(PathBuf, u32)>,
    progress: &mut ArchiveProgress,
    landed: &mut Landed,
) -> Result<()> {
    let dest = job.dest;
    let Entry {
        info,
        parts,
        reader,
    } = entry;
    {
        progress.check_cancel()?;
        progress.set_current(&info.name);
        let parts = match parts {
            Ok(p) => p,
            Err(e) => {
                progress.fail(&info.name, dest, e.to_string());
                progress.add(info.size);
                return Ok(());
            }
        };
        if info.link {
            progress.fail(
                &info.name,
                dest,
                format!("Link not extracted: {}", info.name),
            );
            progress.add(info.size);
            return Ok(());
        }
        if info.special {
            progress.fail(
                &info.name,
                dest,
                format!("Special file not extracted: {}", info.name),
            );
            progress.add(info.size);
            return Ok(());
        }
        if info.encrypted {
            progress.fail(
                &info.name,
                dest,
                "Password-protected, not supported yet".to_string(),
            );
            progress.add(info.size);
            return Ok(());
        }
        // the same key as `fold`: on Linux `Docs` and `docs` are two top-level names
        let top_key = fold_name(&parts[0]);
        let plan = match tops.get(&top_key) {
            Some(plan) => plan.clone(),
            None => {
                let is_dir = top_is_dir.get(&top_key).copied().unwrap_or(false);
                let plan = plan_top(dest, &parts[0], is_dir, job.resolution, landed);
                tops.insert(top_key, plan.clone());
                plan
            }
        };
        let (name, replace) = match plan {
            TopPlan::Skip => {
                progress.add(info.size);
                return Ok(());
            }
            TopPlan::Fail(why) => {
                progress.fail(&info.name, dest, why);
                progress.add(info.size);
                return Ok(());
            }
            TopPlan::Into { name, replace } => (name, replace),
        };
        let mut target = dest.join(&name);
        target.extend(&parts[1..]);
        let result = safe_path::refuse_link_ancestor(dest, &target).and_then(|()| {
            if info.is_dir {
                make_dirs(dest, &target, landed)?;
                if let Some(mode) = info.mode {
                    if landed.created_keys.contains(&fold(&target)) {
                        dir_modes.push((target.clone(), mode));
                    }
                }
                Ok(())
            } else {
                let parent = target.parent().unwrap_or(dest);
                make_dirs(dest, parent, landed)?;
                write_file(reader, &info, &target, replace, marker, progress, landed)
            }
        });
        if let Err(e) = result {
            if progress.is_cancel(&e) {
                return Err(e);
            }
            progress.fail(&info.name, dest, e.to_string());
        }
    }
    Ok(())
}

fn plan_top(
    dest: &Path,
    top: &str,
    is_dir: bool,
    resolution: Resolution,
    landed: &Landed,
) -> TopPlan {
    let target = dest.join(top);
    let meta = match fs::symlink_metadata(&target) {
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return TopPlan::Into {
                name: top.to_string(),
                replace: false,
            }
        }
        Err(e) => return TopPlan::Fail(e.to_string()),
        Ok(meta) => meta,
    };
    // a name this very job made a moment ago (the archive holds `a` and `a (2)` and Keep both
    // gave `a` the name `a (2)`): never replaced or skipped — kept both
    if landed.created_keys.contains(&fold(&target)) {
        return TopPlan::Into {
            name: ops::unique_name(dest, top, is_dir),
            replace: false,
        };
    }
    match resolution {
        Resolution::Skip => TopPlan::Skip,
        Resolution::KeepBoth => TopPlan::Into {
            name: ops::unique_name(dest, top, is_dir),
            replace: false,
        },
        Resolution::Replace => {
            let link = meta.file_type().is_symlink() || ops::is_dir_link(&meta);
            if link {
                TopPlan::Fail(format!("{top} is a link; nothing was replaced"))
            } else if meta.is_dir() != is_dir {
                TopPlan::Fail(format!(
                    "A file and a folder share the name {top}; nothing was replaced"
                ))
            } else {
                TopPlan::Into {
                    name: top.to_string(),
                    replace: true,
                }
            }
        }
    }
}

/// Make every missing folder from below `dest` down to `dir`, recording each one made. A file
/// in the way is an error, never removed.
fn make_dirs(dest: &Path, dir: &Path, landed: &mut Landed) -> Result<()> {
    let rel = dir.strip_prefix(dest).unwrap_or(Path::new(""));
    let mut at = dest.to_path_buf();
    for part in rel.components() {
        at.push(part);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() => continue,
            Ok(_) => {
                return Err(Error::new(
                    ErrorKind::AlreadyExists,
                    format!("A file is in the way of folder {}", at.display()),
                ))
            }
            Err(e) if e.kind() == ErrorKind::NotFound => match fs::create_dir(&at) {
                Ok(()) => landed.make(&at),
                Err(e) if e.kind() == ErrorKind::AlreadyExists && at.is_dir() => {}
                Err(e) => return Err(e),
            },
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Rename `from` to `target`, or — taken — to the next Keep-both name beside it. Returns where
/// it landed.
pub(crate) fn land_no_replace(from: &Path, target: &Path) -> Result<PathBuf> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = file_name(target);
    let mut to = target.to_path_buf();
    for _ in 0..1000 {
        match rename_no_replace(from, &to) {
            Ok(()) => return Ok(to),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                to = dir.join(ops::unique_name(dir, &name, false));
            }
            Err(e) => return Err(e),
        }
    }
    Err(Error::new(ErrorKind::AlreadyExists, "No free name found"))
}

#[allow(clippy::too_many_arguments)]
fn write_file(
    reader: &mut dyn Read,
    info: &EntryInfo,
    target: &Path,
    replace: bool,
    marker: Option<&[u8]>,
    progress: &mut ArchiveProgress,
    landed: &mut Landed,
) -> Result<()> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = file_name(target);
    let partial = Partial {
        path: dir.join(ops::unique_name(
            dir,
            &format!(".{name}.trove-partial"),
            false,
        )),
        armed: true,
    };
    let mut out = File::options()
        .write(true)
        .create_new(true)
        .open(&partial.path)?;
    {
        // one byte more than declared, so a lying entry shows itself on the first read
        let mut buf = vec![0u8; info.size.saturating_add(1).min(BUFFER as u64) as usize];
        let mut written = 0u64;
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            // after the read, not before: a file whose last buffer is already on disk is
            // whole and lands; Cancel drops only one that still has bytes to write
            progress.check_cancel()?;
            written = written.saturating_add(n as u64);
            // a zip bomb or a lying header: never write more than the archive declared
            if written > info.size {
                return Err(Error::new(
                    ErrorKind::InvalidData,
                    "Entry larger than it claims; not extracted",
                ));
            }
            out.write_all(&buf[..n])?;
            progress.add(n as u64);
        }
        // a cut-short archive (a tar stream that ends mid-entry) can read as an early end, not
        // an error: a short file must never land looking whole
        if written < info.size {
            return Err(Error::new(
                ErrorKind::UnexpectedEof,
                "The archive ends before this file does; not extracted",
            ));
        }
    }
    out.flush()?;
    if let Some(modified) = info.modified {
        let _ = out.set_modified(modified);
    }
    drop(out);
    #[cfg(unix)]
    if let Some(mode) = info.mode {
        use std::os::unix::fs::PermissionsExt;
        // never setuid / setgid / sticky from an archive
        let _ = fs::set_permissions(&partial.path, fs::Permissions::from_mode(mode & 0o777));
    }
    if let Some(marker) = marker {
        apply_origin_marker(&partial.path, marker);
    }
    let key = fold(target);
    let landed_at = if landed.written.contains(&key) {
        // two entries, one target: never replace what this job wrote a moment ago
        let at = land_no_replace(&partial.path, target)?;
        progress.fail(
            &info.name,
            dir,
            format!("Duplicate name in archive, kept both: {}", info.name),
        );
        landed.make(&at);
        at
    } else if replace && fs::symlink_metadata(target).is_ok() {
        if fs::symlink_metadata(target)?.is_dir() {
            return Err(Error::new(
                ErrorKind::AlreadyExists,
                format!("A folder is in the way of file {name}; nothing was replaced"),
            ));
        }
        replace_with(&partial.path, target)?;
        landed.replaced.push(target.to_path_buf());
        target.to_path_buf()
    } else {
        let at = land_no_replace(&partial.path, target)?;
        landed.make(&at);
        at
    };
    partial.keep();
    landed.written.insert(fold(&landed_at));
    Ok(())
}

fn summary(progress: &ArchiveProgress, verb: &str) -> Option<String> {
    let n = progress.failed.len() as u64;
    (n > 0).then(|| format!("{n} of {} items could not be {verb}", progress.items.max(n)))
}

fn finish(
    job_id: u64,
    progress: ArchiveProgress,
    result: Result<()>,
    outputs: Vec<ArchiveOutput>,
    verb: &str,
) -> ArchiveDone {
    let cancelled = matches!(&result, Err(e) if progress.is_cancel(e));
    let mut problems: Vec<String> = match result {
        Err(e) if !cancelled => vec![e.to_string()],
        _ => Vec::new(),
    };
    problems.extend(summary(&progress, verb));
    ArchiveDone {
        job_id,
        outputs,
        failed: progress.failed,
        error: (!problems.is_empty()).then(|| problems.join(". ")),
        cancelled,
    }
}

/// Extract `archive` (or only `entries` of it) into `dest`, answering a top-level conflict
/// with `resolution`. Never panics on I/O.
pub fn run_extract(
    job_id: u64,
    archive: &Path,
    dest: &Path,
    entries: Option<&[String]>,
    resolution: Resolution,
    cancel: &AtomicBool,
    sink: &dyn Fn(TransferProgress),
) -> ArchiveDone {
    let job = ExtractJob {
        archive,
        dest,
        filter: entries,
        resolution,
        free: &free_space,
    };
    extract_job(job_id, &job, cancel, sink)
}

pub(crate) fn extract_job(
    job_id: u64,
    job: &ExtractJob,
    cancel: &AtomicBool,
    sink: &dyn Fn(TransferProgress),
) -> ArchiveDone {
    let mut progress = ArchiveProgress::new(job_id, cancel, sink);
    let mut landed = Landed::default();
    let result = progress
        .check_cancel()
        .and_then(|()| open_source(job.archive, Some(cancel)))
        .and_then(|mut source| extract_from(source.as_mut(), job, &mut progress, &mut landed));
    let outputs = landed.outputs(job.archive);
    finish(job_id, progress, result, outputs, "extracted")
}

/// "Extract here": a new folder beside the archive named after it (`photos`, then
/// `photos (2)`…), so it can never conflict with anything. Removed again only if the job
/// left it empty (`remove_dir` refuses a folder that is not).
pub fn run_extract_here(
    job_id: u64,
    archive: &Path,
    cancel: &AtomicBool,
    sink: &dyn Fn(TransferProgress),
) -> ArchiveDone {
    let fail = |e: Error| ArchiveDone {
        job_id,
        outputs: Vec::new(),
        failed: Vec::new(),
        error: Some(e.to_string()),
        cancelled: false,
    };
    let Some(parent) = archive.parent() else {
        return fail(Error::new(
            ErrorKind::InvalidInput,
            "No folder around the archive",
        ));
    };
    if let Err(e) = Format::detect(archive).and_then(Format::ensure_supported) {
        return fail(e);
    }
    let stem = archive_stem(archive);
    let mut folder = None;
    for _ in 0..1000 {
        let at = parent.join(ops::unique_name(parent, &stem, true));
        match fs::create_dir(&at) {
            Ok(()) => {
                folder = Some(at);
                break;
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return fail(e),
        }
    }
    let Some(folder) = folder else {
        return fail(Error::new(
            ErrorKind::AlreadyExists,
            "No free folder name found",
        ));
    };
    let job = ExtractJob {
        archive,
        dest: &folder,
        filter: None,
        resolution: Resolution::Skip,
        free: &free_space,
    };
    let mut done = extract_job(job_id, &job, cancel, sink);
    let empty = fs::read_dir(&folder).is_ok_and(|mut d| d.next().is_none());
    if empty {
        let _ = fs::remove_dir(&folder);
        done.outputs.clear();
    } else {
        done.outputs = vec![ArchiveOutput {
            from: archive.to_string_lossy().into_owned(),
            to: folder.to_string_lossy().into_owned(),
            created: true,
        }];
    }
    done
}

/// Compress `sources` into one archive beside them: ZIP, 7z, tar.gz, tar.xz or tar.zst.
pub fn run_compress(
    job_id: u64,
    sources: &[PathBuf],
    format: ArchiveFormat,
    cancel: &AtomicBool,
    sink: &dyn Fn(TransferProgress),
) -> ArchiveDone {
    let mut progress = ArchiveProgress::new(job_id, cancel, sink);
    let result = match format {
        ArchiveFormat::Zip => progress
            .check_cancel()
            .and_then(|()| zip_fmt::compress(sources, &mut progress)),
        ArchiveFormat::TarGz | ArchiveFormat::TarXz | ArchiveFormat::TarZst => progress
            .check_cancel()
            .and_then(|()| tar_fmt::compress(sources, format, &mut progress)),
        ArchiveFormat::SevenZ => progress
            .check_cancel()
            .and_then(|()| sevenz_fmt::compress(sources, &mut progress)),
    };
    let (outputs, result) = match result {
        Ok(to) => (
            vec![ArchiveOutput {
                from: sources
                    .first()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                to: to.to_string_lossy().into_owned(),
                created: true,
            }],
            Ok(()),
        ),
        Err(e) => (Vec::new(), Err(e)),
    };
    finish(job_id, progress, result, outputs, "compressed")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::core::archive::test_util::scratch;
    use std::cell::RefCell;

    /// A zip at `path` holding `files` (name, bytes); a name ending in `/` is a folder.
    pub fn make_zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut w = zip::ZipWriter::new(File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        for (name, bytes) in files {
            if name.ends_with('/') {
                w.add_directory(*name, opts).unwrap();
            } else {
                w.start_file(*name, opts).unwrap();
                w.write_all(bytes).unwrap();
            }
        }
        w.finish().unwrap();
    }

    /// `<scratch>/a/b/dest`, made, and an archive path beside the scratch root's top.
    pub fn layout(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = scratch(name);
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let zip = root.join("in.zip");
        (root, dest, zip)
    }

    pub fn extract(zip: &Path, dest: &Path, resolution: Resolution) -> ArchiveDone {
        let cancel = AtomicBool::new(false);
        run_extract(1, zip, dest, None, resolution, &cancel, &|_| {})
    }

    /// Extract from a hand-made `source` (no archive on disk is read; `zip` only names it).
    pub fn extract_with(
        source: &mut dyn Source,
        zip: &Path,
        dest: &Path,
        resolution: Resolution,
    ) -> ArchiveDone {
        let cancel = AtomicBool::new(false);
        let mut progress = ArchiveProgress::new(1, &cancel, &|_| {});
        let mut landed = Landed::default();
        let job = ExtractJob {
            archive: zip,
            dest,
            filter: None,
            resolution,
            free: &|_| None,
        };
        let result = extract_from(source, &job, &mut progress, &mut landed);
        let outputs = landed.outputs(zip);
        finish(1, progress, result, outputs, "extracted")
    }

    /// A reader that lists one 3 MB `x.txt` and fails after its first buffer.
    pub struct Failing;
    impl Source for Failing {
        fn entries(&mut self) -> Result<Vec<EntryInfo>> {
            Ok(vec![EntryInfo {
                index: 0,
                name: "x.txt".into(),
                is_dir: false,
                size: 3 * BUFFER as u64,
                encrypted: false,
                link: false,
                special: false,
                mode: None,
                modified: None,
            }])
        }
        fn open(&mut self, _: usize) -> Result<Box<dyn Read + '_>> {
            let first = std::io::Cursor::new(vec![1u8; BUFFER]);
            Ok(Box::new(first.chain(FailRead)))
        }
    }
    struct FailRead;
    impl Read for FailRead {
        fn read(&mut self, _: &mut [u8]) -> Result<usize> {
            Err(Error::other("disk went away"))
        }
    }

    #[test]
    fn cancel_before_start_writes_nothing() {
        let (root, dest, zip) = layout("cancel-start");
        make_zip(&zip, &[("a.txt", b"aaa"), ("d/b.txt", b"bb")]);
        let cancel = AtomicBool::new(true);
        let done = run_extract(1, &zip, &dest, None, Resolution::Skip, &cancel, &|_| {});
        assert!(done.cancelled);
        assert!(done.outputs.is_empty());
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
        let src = root.join("src.txt");
        fs::write(&src, b"x").unwrap();
        let done = run_compress(2, &[src], ArchiveFormat::Zip, &cancel, &|_| {});
        assert!(done.cancelled && done.outputs.is_empty());
        assert_eq!(
            fs::read_dir(&root).unwrap().count(),
            3,
            "a/, in.zip, src.txt"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn progress_reaches_total() {
        let (root, dest, zip) = layout("progress");
        let big = vec![7u8; 3 * BUFFER + 5];
        make_zip(&zip, &[("big.bin", &big), ("small.txt", b"abc")]);
        let seen = RefCell::new(Vec::new());
        let cancel = AtomicBool::new(false);
        let sink = |p: TransferProgress| seen.borrow_mut().push((p.bytes_done, p.bytes_total));
        let done = run_extract(1, &zip, &dest, None, Resolution::Skip, &cancel, &sink);
        assert_eq!(done.error, None);
        let seen = seen.into_inner();
        let total = (big.len() + 3) as u64;
        assert!(seen.iter().all(|&(_, t)| t == total), "{seen:?}");
        // the throttle is off in tests, so every buffer is an event: the opening (0, total)
        // from `set_total`, then bytes that only go up and end on the total. An `add` that
        // never sent an event would leave the single opening one.
        assert_eq!(seen.first(), Some(&(0, total)));
        assert!(
            seen.len() >= 5,
            "4 buffers of big.bin + small.txt: {seen:?}"
        );
        assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0), "{seen:?}");
        assert_eq!(seen.last(), Some(&(total, total)));
        assert_eq!(fs::read(dest.join("big.bin")).unwrap(), big);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn done_lists_each_top_level_output_once() {
        let (root, dest, zip) = layout("outputs");
        make_zip(
            &zip,
            &[
                ("docs/", b""),
                ("docs/a.txt", b"a"),
                ("docs/sub/b.txt", b"b"),
                ("top.txt", b"t"),
            ],
        );
        let done = extract(&zip, &dest, Resolution::Skip);
        assert_eq!(done.error, None);
        let mut tos: Vec<_> = done.outputs.iter().map(|o| o.to.clone()).collect();
        tos.sort();
        assert_eq!(
            tos,
            [
                dest.join("docs").to_string_lossy().into_owned(),
                dest.join("top.txt").to_string_lossy().into_owned()
            ]
        );
        assert!(done.outputs.iter().all(|o| o.created));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replace_folder_merges_and_keeps_other_files() {
        let (root, dest, zip) = layout("merge");
        fs::create_dir_all(dest.join("docs")).unwrap();
        fs::write(dest.join("docs").join("mine.txt"), b"mine").unwrap();
        fs::write(dest.join("docs").join("a.txt"), b"old").unwrap();
        make_zip(&zip, &[("docs/a.txt", b"new"), ("docs/n/b.txt", b"b")]);
        let c = conflicts(&zip, &dest, None).unwrap();
        assert_eq!(c, [dest.join("docs").to_string_lossy().into_owned()]);
        let done = extract(&zip, &dest, Resolution::Replace);
        assert_eq!(done.error, None);
        assert_eq!(
            fs::read(dest.join("docs").join("mine.txt")).unwrap(),
            b"mine"
        );
        assert_eq!(fs::read(dest.join("docs").join("a.txt")).unwrap(), b"new");
        // the folder existed: outputs name what was made inside it and what was replaced,
        // never the folder itself
        let mut outs: Vec<_> = done
            .outputs
            .iter()
            .map(|o| (o.to.clone(), o.created))
            .collect();
        outs.sort();
        assert_eq!(
            outs,
            [
                (
                    dest.join("docs")
                        .join("a.txt")
                        .to_string_lossy()
                        .into_owned(),
                    false
                ),
                (
                    dest.join("docs").join("n").to_string_lossy().into_owned(),
                    true
                ),
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_name_twice_keeps_both() {
        let (root, dest, zip) = layout("dupe");
        let mut w = zip::ZipWriter::new(File::create(&zip).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("x.txt", opts).unwrap();
        w.write_all(b"one").unwrap();
        // the zip writer refuses a duplicate name, so the second goes in with a `./` spelling
        // that `safe_path` folds onto the same target
        w.start_file("./x.txt", opts).unwrap();
        w.write_all(b"two").unwrap();
        w.finish().unwrap();
        let done = extract(&zip, &dest, Resolution::Replace);
        assert_eq!(fs::read(dest.join("x.txt")).unwrap(), b"one");
        assert_eq!(fs::read(dest.join("x (2).txt")).unwrap(), b"two");
        assert_eq!(done.failed.len(), 1, "{:?}", done.failed);
        assert!(done.failed[0].error.starts_with("Duplicate name"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn same_name_twice_keeps_both_across_case() {
        let (root, dest, zip) = layout("dupe-case");
        make_zip(&zip, &[("Read.txt", b"upper"), ("read.txt", b"lower")]);
        let done = extract(&zip, &dest, Resolution::Replace);
        assert_eq!(fs::read(dest.join("Read.txt")).unwrap(), b"upper");
        assert_eq!(fs::read(dest.join("read (2).txt")).unwrap(), b"lower");
        assert_eq!(done.failed.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_when_total_exceeds_free_space() {
        let (root, dest, zip) = layout("nospace");
        make_zip(&zip, &[("a.bin", &[1u8; 4096])]);
        let cancel = AtomicBool::new(false);
        let job = ExtractJob {
            archive: &zip,
            dest: &dest,
            filter: None,
            resolution: Resolution::Skip,
            free: &|_| Some(100),
        };
        let done = extract_job(1, &job, &cancel, &|_| {});
        assert!(done.error.unwrap().starts_with("Not enough free space"));
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    /// A reader that lists one 4-byte entry but hands back 10 bytes.
    struct Lying;
    impl Source for Lying {
        fn entries(&mut self) -> Result<Vec<EntryInfo>> {
            Ok(vec![EntryInfo {
                index: 0,
                name: "liar.bin".into(),
                is_dir: false,
                size: 4,
                encrypted: false,
                link: false,
                special: false,
                mode: None,
                modified: None,
            }])
        }
        fn open(&mut self, _: usize) -> Result<Box<dyn Read + '_>> {
            Ok(Box::new(std::io::Cursor::new(vec![9u8; 10])))
        }
    }

    #[test]
    fn lying_size_entry_is_dropped() {
        let (root, dest, zip) = layout("liar");
        let cancel = AtomicBool::new(false);
        let mut progress = ArchiveProgress::new(1, &cancel, &|_| {});
        let mut landed = Landed::default();
        let job = ExtractJob {
            archive: &zip,
            dest: &dest,
            filter: None,
            resolution: Resolution::Skip,
            free: &|_| None,
        };
        extract_from(&mut Lying, &job, &mut progress, &mut landed).unwrap();
        assert_eq!(progress.failed.len(), 1);
        assert!(progress.failed[0].error.contains("larger than it claims"));
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0, "no partial left");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extract_here_never_conflicts() {
        let root = scratch("here");
        let dir = root.join("a").join("b");
        fs::create_dir_all(&dir).unwrap();
        let zip = dir.join("photos.zip");
        make_zip(&zip, &[("p.jpg", b"jpg")]);
        let cancel = AtomicBool::new(false);
        let one = run_extract_here(1, &zip, &cancel, &|_| {});
        let two = run_extract_here(2, &zip, &cancel, &|_| {});
        assert_eq!(one.outputs[0].to, dir.join("photos").to_string_lossy());
        assert_eq!(two.outputs[0].to, dir.join("photos (2)").to_string_lossy());
        assert_eq!(
            fs::read(dir.join("photos (2)").join("p.jpg")).unwrap(),
            b"jpg"
        );
        // a cancelled one leaves no empty folder behind
        let stop = AtomicBool::new(true);
        let three = run_extract_here(3, &zip, &stop, &|_| {});
        assert!(three.cancelled && three.outputs.is_empty());
        assert!(!dir.join("photos (3)").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn motw_is_copied_to_extracted_files() {
        let (root, dest, zip) = layout("motw");
        make_zip(&zip, &[("setup.exe", b"MZ")]);
        let mut ads = zip.as_os_str().to_os_string();
        ads.push(":Zone.Identifier");
        fs::write(&ads, b"[ZoneTransfer]\r\nZoneId=3\r\n").unwrap();
        extract(&zip, &dest, Resolution::Skip);
        let mut out = dest.join("setup.exe").into_os_string();
        out.push(":Zone.Identifier");
        assert_eq!(fs::read(out).unwrap(), b"[ZoneTransfer]\r\nZoneId=3\r\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn quarantine_is_copied() {
        let (root, dest, zip) = layout("quarantine");
        make_zip(&zip, &[("x.app.txt", b"x")]);
        crate::core::archive::mac_xattr::set(&zip, b"0081;00000000;Safari;");
        extract(&zip, &dest, Resolution::Skip);
        assert_eq!(
            crate::core::archive::mac_xattr::get(&dest.join("x.app.txt")).unwrap(),
            b"0081;00000000;Safari;"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

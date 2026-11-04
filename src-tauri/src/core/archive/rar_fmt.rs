//! RAR (plan 16 Phase 5): list and extract only — Trove never makes a RAR (UnRAR licence,
//! `LICENSES/unrar.txt`). Built only with the `rar` cargo feature (on by default).
//!
//! The reader is RARLAB's UnRAR through the `unrar` crate. `entries` walks the headers
//! (`open_for_listing`, nothing decompressed); `each` walks them again with
//! `open_for_processing` and hands each wanted file to the engine (`job.rs`). A solid RAR can
//! only be read front to back, so `each` always walks in archive order, like tar.
//!
//! Every entry name still goes through `safe_path` in `job.rs`, exactly as for zip, 7z and tar:
//! the engine plans the target path and refuses `..`, absolute and drive names BEFORE this
//! reader writes anything. UnRAR itself is only ever told to write one file into Trove's own
//! private temp folder (`extract_to(<temp>/<index>)`), never into the destination, so a name
//! UnRAR would place elsewhere cannot reach it. The engine then copies that file through its
//! usual partial-then-rename write (size cap, no-replace, Mark of the Web, cancel).
//!
//! Links (a unix symlink, a Windows reparse point) and encrypted entries are failure rows in
//! the engine, never made. A multi-volume set (`x.part1.rar`, `x.part2.rar` …) is always opened
//! from part 1, whichever part was double-clicked; a missing later part ends the job in words.

use std::fs::{self, File};
use std::io::{self, Error, ErrorKind, Read, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::SystemTime;

use unrar::error::{Code, UnrarError, When};
use unrar::Archive;

use super::job::{EntryInfo, Source, Visit};

const PASSWORD: &str = "Password-protected, not supported yet";

/// Windows' "this is a reparse point" attribute (a symlink or junction made on Windows).
const ATTR_REPARSE_POINT: u32 = 0x400;
const S_IFMT: u32 = 0o170_000;
const S_IFLNK: u32 = 0o120_000;

fn cancelled() -> Error {
    Error::new(ErrorKind::Interrupted, "cancelled")
}

/// An UnRAR error in the words the job shows, with the same kinds the other readers use.
pub(crate) fn from_rar(e: UnrarError) -> Error {
    match (e.code, e.when) {
        (Code::MissingPassword | Code::BadPassword, _) | (Code::UnknownFormat, When::Open) => {
            Error::new(ErrorKind::Unsupported, PASSWORD)
        }
        (Code::EOpen, When::Process) => Error::new(
            ErrorKind::NotFound,
            "A part of this multi-part archive is missing",
        ),
        (Code::EOpen, _) => Error::new(ErrorKind::NotFound, "The archive could not be opened"),
        (Code::NoMemory, _) => Error::new(ErrorKind::OutOfMemory, "Not enough memory"),
        (Code::ECreate | Code::EWrite | Code::EClose, _) => {
            Error::other(format!("Could not write the extracted file ({e})"))
        }
        (Code::EReference, _) => Error::new(
            ErrorKind::Unsupported,
            "This entry is a reference to another file in the archive, not extracted",
        ),
        _ => Error::new(
            ErrorKind::InvalidData,
            format!("The archive is damaged or cut short: {e}"),
        ),
    }
}

/// True when the attributes say link: a unix `S_IFLNK` mode (RAR made on Linux / macOS stores
/// the mode) or a Windows reparse point. UnRAR does not tell which OS made the archive.
fn is_link(attr: u32) -> bool {
    attr & S_IFMT == S_IFLNK || attr & ATTR_REPARSE_POINT != 0
}

/// A RAR header time (MS-DOS date in the high 16 bits, time in the low, wall clock where the
/// archive was made) — read as local time, like a zip's.
fn dos_time(t: u32) -> Option<SystemTime> {
    let dt = zip::DateTime::try_from_msdos((t >> 16) as u16, t as u16).ok()?;
    super::zip_fmt::time::from_zip(dt)
}

/// What the engine needs from one RAR header. Kept apart from `unrar::FileHeader` (which cannot
/// be built outside the crate) so the mapping and the slip guard are tested without a fixture.
pub(crate) fn entry_info(
    index: usize,
    name: &Path,
    is_dir: bool,
    encrypted: bool,
    size: u64,
    attr: u32,
    time: u32,
) -> EntryInfo {
    EntryInfo {
        index,
        name: name.to_string_lossy().into_owned(),
        is_dir,
        size: if is_dir { 0 } else { size },
        encrypted,
        link: !is_dir && is_link(attr),
        special: false,
        // RAR modes are not restored: UnRAR's attributes are a unix mode OR Windows flags with
        // no host-OS field to tell them apart, and Windows flags read as a mode can make a file
        // unreadable to its owner. Files land with the destination's default permissions.
        mode: None,
        modified: dos_time(time),
    }
}

/// A temp folder only this job writes into, removed (file by file, then the folder) on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Scratch> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "trove-rar-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir)?;
        Ok(Scratch(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Ok(read) = fs::read_dir(&self.0) {
            for item in read.flatten() {
                let _ = fs::remove_file(item.path());
            }
        }
        let _ = fs::remove_dir(&self.0);
    }
}

pub(crate) struct RarSource<'c> {
    /// part 1 of a multi-volume set, else the archive itself
    path: PathBuf,
    entries: Vec<EntryInfo>,
    cancel: Option<&'c AtomicBool>,
}

impl<'c> RarSource<'c> {
    pub fn open(archive: &Path, cancel: Option<&'c AtomicBool>) -> Result<Self> {
        let path = Archive::new(archive)
            .as_first_part()
            .filename()
            .to_path_buf();
        let path = if path.exists() {
            path
        } else {
            archive.to_path_buf()
        };
        let listing = Archive::new(&path).open_for_listing().map_err(from_rar)?;
        let mut entries = Vec::new();
        for header in listing {
            let h = header.map_err(from_rar)?;
            // a file continued from an earlier volume is the same entry, listed once
            if h.is_split_before() {
                continue;
            }
            entries.push(entry_info(
                entries.len(),
                &h.filename,
                h.is_directory(),
                h.is_encrypted(),
                h.unpacked_size,
                h.file_attr,
                h.file_time,
            ));
        }
        Ok(RarSource {
            path,
            entries,
            cancel,
        })
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.is_some_and(|c| c.load(Ordering::Relaxed))
    }

    /// One pass from the top of the archive, visiting the wanted entries at or after `from`.
    /// `Ok(None)`: the walk finished. `Ok(Some(i))`: entry `i` failed to decode and UnRAR gave
    /// up its handle with it; it was visited as a failure, the caller reopens after it.
    fn walk(
        &self,
        wanted: &[usize],
        from: usize,
        scratch: &Path,
        visit: &mut Visit,
    ) -> Result<Option<usize>> {
        let mut want = wanted.iter().copied().filter(|&i| i >= from).peekable();
        let mut arc = Archive::new(&self.path)
            .open_for_processing()
            .map_err(from_rar)?;
        let mut index = 0usize;
        while let Some(&next) = want.peek() {
            if self.is_cancelled() {
                return Err(cancelled());
            }
            let Some(header) = arc.read_header().map_err(from_rar)? else {
                break;
            };
            if header.entry().is_split_before() {
                arc = header.skip().map_err(from_rar)?;
                continue;
            }
            let i = index;
            index += 1;
            if i != next {
                arc = header.skip().map_err(from_rar)?;
                continue;
            }
            want.next();
            let info = &self.entries[i];
            if info.is_dir || info.link || info.encrypted {
                // the engine makes the folder / writes the failure row; no bytes needed
                visit(i, &mut io::empty())?;
                arc = header.skip().map_err(from_rar)?;
                continue;
            }
            let temp = scratch.join(i.to_string());
            match header.extract_to(&temp) {
                Ok(rest) => {
                    let result = match File::open(&temp) {
                        Ok(mut file) => visit(i, &mut file),
                        Err(e) => visit(i, &mut FailRead(Some(e))),
                    };
                    let _ = fs::remove_file(&temp);
                    result?;
                    arc = rest;
                }
                Err(e) => {
                    let _ = fs::remove_file(&temp);
                    visit(i, &mut FailRead(Some(from_rar(e))))?;
                    return Ok(Some(i));
                }
            }
        }
        Ok(None)
    }
}

/// A reader whose first read returns the error its entry failed with.
struct FailRead(Option<Error>);
impl Read for FailRead {
    fn read(&mut self, _: &mut [u8]) -> Result<usize> {
        Err(self
            .0
            .take()
            .unwrap_or_else(|| Error::other("entry cannot be read")))
    }
}

impl Source for RarSource<'_> {
    fn entries(&mut self) -> Result<Vec<EntryInfo>> {
        Ok(self.entries.clone())
    }

    fn each(&mut self, wanted: &[usize], visit: &mut Visit) -> Result<()> {
        if wanted.is_empty() {
            return Ok(());
        }
        let scratch = Scratch::new()?;
        let mut from = 0;
        // a broken entry costs UnRAR its handle: reopen and carry on after it, so one bad file
        // is one failure row and the rest still extract (as in zip, 7z and tar)
        while let Some(failed) = self.walk(wanted, from, &scratch.0, visit)? {
            from = failed + 1;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::archive::job::tests::{extract, extract_with};
    use crate::core::archive::test_util::scratch;
    use crate::core::transfer::Resolution;

    /// Two tiny RARs from the `unrar` crate's own test data (MIT OR Apache-2.0): `VERSION`
    /// stored plain, and `.gitignore` encrypted with a password.
    const VERSION_RAR: &[u8] = include_bytes!("testdata/unrar-crate-version.rar");
    const CRYPTED_RAR: &[u8] = include_bytes!("testdata/unrar-crate-crypted.rar");

    /// A source built from header-shaped rows, so the engine's guard is tested on RAR names
    /// without a RAR on disk.
    struct Rows(Vec<(EntryInfo, &'static [u8])>);
    impl Source for Rows {
        fn entries(&mut self) -> Result<Vec<EntryInfo>> {
            Ok(self.0.iter().map(|(i, _)| i.clone()).collect())
        }
        fn open(&mut self, index: usize) -> Result<Box<dyn Read + '_>> {
            Ok(Box::new(self.0[index].1))
        }
    }

    /// Tests that run a real RAR through `RarSource` hold this, because
    /// `real_rar_lists_and_extracts` checks that no `trove-rar-<pid>-*` temp folder of this
    /// process is left, and another test's live `Scratch` would otherwise fail that check.
    fn real_rar_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn row(index: usize, name: &str, bytes: &'static [u8]) -> (EntryInfo, &'static [u8]) {
        let info = entry_info(
            index,
            Path::new(name),
            false,
            false,
            bytes.len() as u64,
            0x20,
            0,
        );
        (info, bytes)
    }

    #[test]
    fn rar_names_go_through_the_slip_guard() {
        let root = scratch("rar-slip-rows");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let mut source = Rows(vec![
            row(0, "..\\x.txt", b"back"),
            row(1, "../evil.txt", b"evil"),
            row(2, "/abs.txt", b"abs"),
            row(3, "C:\\drive.txt", b"drive"),
            row(4, "good.txt", b"good"),
        ]);
        let archive = root.join("in.rar");
        let done = extract_with(&mut source, &archive, &dest, Resolution::Skip);
        assert_eq!(fs::read(dest.join("good.txt")).unwrap(), b"good");
        let b = dest.parent().unwrap();
        assert!(!b.join("x.txt").exists() && !b.join("evil.txt").exists());
        let names: Vec<_> = fs::read_dir(&dest)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["good.txt"]);
        assert_eq!(done.failed.len(), 4, "{:?}", done.failed);
        assert!(done
            .failed
            .iter()
            .all(|f| f.error.starts_with("Unsafe path")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn attributes_map_to_links_and_folders() {
        let unix_link = entry_info(0, Path::new("l"), false, false, 4, 0o120_777, 0);
        assert!(unix_link.link);
        let win_link = entry_info(0, Path::new("l"), false, false, 0, 0x20 | 0x400, 0);
        assert!(win_link.link);
        let file = entry_info(0, Path::new("f"), false, false, 9, 0o100_644, 0);
        assert!(!file.link && file.mode.is_none());
        let dir = entry_info(0, Path::new("d"), true, false, 99, 0x10, 0);
        assert!(dir.is_dir && !dir.link && dir.size == 0);
        // 2024-03-05 10:20:30, MS-DOS packed
        let t = ((2024 - 1980) << 25) | (3 << 21) | (5 << 16) | (10 << 11) | (20 << 5) | 15;
        assert!(entry_info(0, Path::new("f"), false, false, 0, 0, t)
            .modified
            .is_some());
        assert!(entry_info(0, Path::new("f"), false, false, 0, 0, 0)
            .modified
            .is_none());
    }

    #[test]
    fn errors_read_in_plain_words() {
        let pw = from_rar(UnrarError::from(Code::MissingPassword, When::Process));
        assert_eq!(pw.kind(), ErrorKind::Unsupported);
        assert_eq!(pw.to_string(), PASSWORD);
        let crc = from_rar(UnrarError::from(Code::BadData, When::Process));
        assert_eq!(crc.kind(), ErrorKind::InvalidData);
        assert!(crc.to_string().contains("damaged"), "{crc}");
        let part = from_rar(UnrarError::from(Code::EOpen, When::Process));
        assert!(part.to_string().contains("multi-part"), "{part}");
    }

    #[test]
    fn real_rar_lists_and_extracts() {
        let _serial = real_rar_lock();
        let root = scratch("rar-real");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let archive = root.join("version.rar");
        fs::write(&archive, VERSION_RAR).unwrap();
        let mut source = RarSource::open(&archive, None).unwrap();
        let names: Vec<String> = source
            .entries()
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["VERSION"]);
        // browse inside goes through the same reader
        let listed = crate::core::archive::index::read_index(&archive).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].is_dir && listed[0].size > 0);
        let done = extract(&archive, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        assert!(done.failed.is_empty(), "{:?}", done.failed);
        let bytes = fs::read(dest.join("VERSION")).unwrap();
        assert!(!bytes.is_empty());
        // nothing left in a trove-rar temp folder of this process
        let ours = format!("trove-rar-{}-", std::process::id());
        let left: Vec<_> = fs::read_dir(std::env::temp_dir())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(&ours))
            .collect();
        assert!(left.is_empty(), "{left:?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn encrypted_entry_is_a_failure_row() {
        let _serial = real_rar_lock();
        let root = scratch("rar-crypted");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let archive = root.join("crypted.rar");
        fs::write(&archive, CRYPTED_RAR).unwrap();
        let done = extract(&archive, &dest, Resolution::Skip);
        assert_eq!(done.failed.len(), 1, "{:?}", done.failed);
        assert_eq!(done.failed[0].error, PASSWORD);
        assert!(!dest.join(".gitignore").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn not_a_rar_is_refused_in_words() {
        let _serial = real_rar_lock();
        let root = scratch("rar-cut");
        let archive = root.join("cut.rar");
        fs::write(&archive, &VERSION_RAR[..VERSION_RAR.len() / 2]).unwrap();
        // a cut-short RAR either fails to open or fails on its header walk; never a panic
        let result = RarSource::open(&archive, None);
        if let Err(e) = result {
            assert!(!e.to_string().is_empty());
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// `tests/fixtures/archives/basic.rar`: `hello.txt` and a `docs/` folder with two files
    /// (RAR5, stored; written by `make_rar_fixtures.py` beside it).
    #[test]
    fn rar_lists_and_extracts_fixture() {
        let _serial = real_rar_lock();
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/archives/basic.rar");
        let root = scratch("rar-basic");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let entries = RarSource::open(&fixture, None).unwrap().entries().unwrap();
        assert!(!entries.is_empty());
        let done = extract(&fixture, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        assert!(done.failed.is_empty(), "{:?}", done.failed);
        assert_eq!(
            fs::read_to_string(dest.join("hello.txt")).unwrap(),
            "hello from trove\n"
        );
        assert!(dest.join("docs").join("readme.md").is_file());
        assert!(dest.join("docs").join("notes.txt").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    /// `tests/fixtures/archives/slip.rar`: an ordinary `good.txt` and one entry named
    /// `../slip.txt` (RAR5, stored; written by `make_rar_fixtures.py` beside it).
    #[test]
    fn rar_slip_fixture_is_refused() {
        let _serial = real_rar_lock();
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/archives/slip.rar");
        let root = scratch("rar-slip");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let done = extract(&fixture, &dest, Resolution::Skip);
        assert!(!dest.parent().unwrap().join("slip.txt").exists());
        assert!(dest.join("good.txt").is_file());
        assert!(
            done.failed
                .iter()
                .any(|f| f.error.starts_with("Unsafe path")),
            "{:?}",
            done.failed
        );
        fs::remove_dir_all(root).unwrap();
    }
}

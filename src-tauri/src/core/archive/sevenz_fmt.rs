//! 7z (plan 16 Phase 3): the reader the extract engine (`job.rs`) walks, and Compress to 7z.
//!
//! A 7z keeps its list of entries in a header at the END of the file, so `entries` is cheap
//! (no decompression). The bytes live in blocks: a solid block packs many files into one
//! stream that can only be read front to back, a non-solid archive has one block per file.
//! `each` decodes only the blocks that hold a wanted entry, and inside a block reads past the
//! entries it does not want (it has to: the next entry starts where the previous one ends).
//!
//! Every entry name still goes through `safe_path` in `job.rs`; links (a unix symlink or a
//! Windows reparse point), anti-items and devices are failure rows there, never made. An
//! encrypted block or header is refused as "not supported yet": this build has no AES.
//!
//! Methods this build reads: Copy, LZMA, LZMA2, PPMd, BZip2, Deflate, the BCJ / BCJ2 / ARM /
//! ARM64 / PPC / SPARC / IA64 / RISC-V filters and Delta. Not read: Deflate64 (no pure-Rust
//! decoder in `sevenz-rust2`), AES (feature off), and the zstd / brotli / lz4 methods of the
//! 7-Zip forks; an entry using one is a failure row naming the method.

use std::cell::RefCell;
use std::fmt::Display;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Error, ErrorKind, Read, Result, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sevenz_rust2::{
    Archive, ArchiveEntry, ArchiveWriter, BlockDecoder, EncoderMethod, NtTime, Password,
    SourceReader,
};

use super::job::{land_no_replace, ArchiveProgress, EntryInfo, Source, Visit};
use super::zip_fmt::{list_items, place, Item};
use crate::core::ops;
use crate::core::transfer::Partial;

const BUFFER: usize = 1024 * 1024;
const PASSWORD: &str = "Password-protected, not supported yet";

const ATTR_DIRECTORY: u32 = 0x10;
const ATTR_ARCHIVE: u32 = 0x20;
const ATTR_REPARSE_POINT: u32 = 0x400;
/// 7-Zip's flag that the high 16 bits of the attributes are a unix `st_mode`
const ATTR_UNIX_EXTENSION: u32 = 0x8000;
const S_IFMT: u32 = 0o170_000;
const S_IFREG: u32 = 0o100_000;
const S_IFDIR: u32 = 0o040_000;
const S_IFLNK: u32 = 0o120_000;

/// The message a damaged or cut-short archive ends the job with.
fn damaged(e: impl Display) -> Error {
    Error::new(
        ErrorKind::InvalidData,
        format!("The archive is damaged or cut short: {e}"),
    )
}

fn cancelled() -> Error {
    Error::new(ErrorKind::Interrupted, "cancelled")
}

fn password() -> Error {
    Error::new(ErrorKind::Unsupported, PASSWORD)
}

/// A `sevenz_rust2` error in the words the job shows.
fn from_7z(e: sevenz_rust2::Error) -> Error {
    use sevenz_rust2::Error as E;
    match e {
        E::PasswordRequired | E::MaybeBadPassword(_) => password(),
        E::UnsupportedCompressionMethod(m) if m.contains("AES") => password(),
        E::UnsupportedCompressionMethod(m) => Error::new(
            ErrorKind::Unsupported,
            format!("This archive uses a compression method Trove cannot read yet ({m})"),
        ),
        E::Io(e, _) | E::FileOpen(e, _)
            if !matches!(e.kind(), ErrorKind::InvalidData | ErrorKind::UnexpectedEof) =>
        {
            e
        }
        other => damaged(other),
    }
}

/// Seconds since 1601 → `SystemTime`; `None` before 1970 or past what `SystemTime` holds.
fn nt_to_system(t: NtTime) -> Option<SystemTime> {
    const EPOCH_GAP: u64 = 11_644_473_600;
    let ticks = u64::from(t);
    let secs = (ticks / 10_000_000).checked_sub(EPOCH_GAP)?;
    let nanos = ((ticks % 10_000_000) * 100) as u32;
    UNIX_EPOCH.checked_add(Duration::new(secs, nanos))
}

/// An entry's bytes as the engine sees them: a cancel stops the next read (`Interrupted`, the
/// engine reads in its own loop, never `io::copy`), and a decode or checksum error reads as
/// damage.
struct Guard<'r, 'c> {
    inner: &'r mut dyn Read,
    cancel: Option<&'c AtomicBool>,
}

impl Guard<'_, '_> {
    fn is_cancelled(&self) -> bool {
        self.cancel.is_some_and(|c| c.load(Ordering::Relaxed))
    }
}

impl Read for Guard<'_, '_> {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        if self.is_cancelled() {
            return Err(cancelled());
        }
        self.inner.read(buf).map_err(|e| {
            if self.is_cancelled() {
                cancelled()
            } else {
                damaged(e)
            }
        })
    }
}

/// Read what is left of an entry, so the next one in the block starts at its own bytes.
fn drain(reader: &mut Guard) -> Result<()> {
    let mut buf = vec![0u8; 64 * 1024];
    while reader.read(&mut buf)? > 0 {}
    Ok(())
}

/// A reader whose first read returns `why` (an entry in a block that cannot be decoded).
struct FailRead(Option<Error>);
impl Read for FailRead {
    fn read(&mut self, _: &mut [u8]) -> Result<usize> {
        Err(self
            .0
            .take()
            .unwrap_or_else(|| Error::other("entry cannot be read")))
    }
}

/// Why a block's walk stopped early.
enum Stop {
    /// from the engine (`visit`), a cancel included: ends the job
    Visit(Error),
    /// the block's bytes are broken from here on: the rest of the block is failure rows
    Broken(Error),
}

/// An open 7z: its parsed header and the file, read block by block.
pub(crate) struct SevenZSource<'c> {
    file: BufReader<File>,
    archive: Archive,
    /// per block: the block is AES-encrypted
    encrypted: Vec<bool>,
    cancel: Option<&'c AtomicBool>,
}

impl<'c> SevenZSource<'c> {
    pub fn open(path: &Path, cancel: Option<&'c AtomicBool>) -> Result<Self> {
        let mut file = BufReader::new(File::open(path)?);
        let archive = Archive::read(&mut file, &Password::empty()).map_err(from_7z)?;
        let encrypted = archive
            .blocks
            .iter()
            .map(|b| {
                b.coders
                    .iter()
                    .any(|c| c.encoder_method_id() == EncoderMethod::ID_AES256_SHA256)
            })
            .collect();
        Ok(SevenZSource {
            file,
            archive,
            encrypted,
            cancel,
        })
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.is_some_and(|c| c.load(Ordering::Relaxed))
    }
}

/// What the engine needs to know of one 7z entry.
fn info_of(index: usize, entry: &ArchiveEntry, encrypted: bool) -> EntryInfo {
    let attrs = entry
        .has_windows_attributes
        .then_some(entry.windows_attributes);
    let unix = attrs
        .filter(|a| a & ATTR_UNIX_EXTENSION != 0)
        .map(|a| a >> 16);
    let kind = unix.map(|m| m & S_IFMT).filter(|&k| k != 0);
    let link = attrs.is_some_and(|a| a & ATTR_REPARSE_POINT != 0) || kind == Some(S_IFLNK);
    let is_dir = !link && (entry.is_directory || kind == Some(S_IFDIR));
    let special =
        entry.is_anti_item || kind.is_some_and(|k| k != S_IFREG && k != S_IFDIR && k != S_IFLNK);
    EntryInfo {
        index,
        name: entry.name.clone(),
        is_dir,
        size: if is_dir || link { 0 } else { entry.size },
        encrypted,
        link,
        special,
        mode: unix.map(|m| m & 0o7777),
        modified: entry
            .has_last_modified_date
            .then(|| nt_to_system(entry.last_modified_date))
            .flatten(),
    }
}

impl Source for SevenZSource<'_> {
    fn entries(&mut self) -> Result<Vec<EntryInfo>> {
        let map = &self.archive.stream_map.file_block_index;
        Ok(self
            .archive
            .files
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let encrypted = map
                    .get(i)
                    .copied()
                    .flatten()
                    .is_some_and(|b| self.encrypted[b]);
                info_of(i, f, encrypted)
            })
            .collect())
    }

    fn each(&mut self, wanted: &[usize], visit: &mut Visit) -> Result<()> {
        let cancel = self.cancel;
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(4)) as u32;
        let mut next = wanted.iter().copied().peekable();
        let mut broken: Option<String> = None;
        for block in 0..self.archive.blocks.len() {
            let start = self.archive.stream_map.block_first_file_index[block];
            let password = Password::empty();
            let decoder =
                BlockDecoder::new(threads, block, &self.archive, &password, &mut self.file);
            let end = start + decoder.entry_count();
            // entries with no bytes (folders, empty files) that sit before this block
            while let Some(i) = next.next_if(|&i| i < start) {
                visit(i, &mut io::empty())?;
            }
            if next.peek().is_none_or(|&i| i >= end) {
                continue;
            }
            if self.encrypted[block] {
                // the engine refuses an `encrypted` entry before reading it
                while let Some(i) = next.next_if(|&i| i < end) {
                    visit(i, &mut io::empty())?;
                }
                continue;
            }
            let mut index = start;
            let mut stop: Option<Stop> = None;
            let walked = decoder.for_each_entries(&mut |_, reader| {
                let i = index;
                index += 1;
                if next.peek().is_none_or(|&w| w >= end) {
                    return Ok(false);
                }
                let mut guard = Guard {
                    inner: reader,
                    cancel,
                };
                if next.next_if_eq(&i).is_some() {
                    if let Err(e) = visit(i, &mut guard) {
                        stop = Some(Stop::Visit(e));
                        return Err(sevenz_rust2::Error::Other("stopped".into()));
                    }
                }
                match drain(&mut guard) {
                    Ok(()) => Ok(true),
                    Err(e) => {
                        stop = Some(if e.kind() == ErrorKind::Interrupted {
                            Stop::Visit(e)
                        } else {
                            Stop::Broken(e)
                        });
                        Err(sevenz_rust2::Error::Other("stopped".into()))
                    }
                }
            });
            let why = match (stop, walked) {
                (Some(Stop::Visit(e)), _) => return Err(e),
                (Some(Stop::Broken(e)), _) => e,
                (None, Ok(_)) => continue,
                (None, Err(e)) => from_7z(e),
            };
            if self.is_cancelled() {
                return Err(cancelled());
            }
            // the rest of this block cannot be read: one failure row each, then the next block
            let kind = why.kind();
            let text = why.to_string();
            if kind == ErrorKind::InvalidData {
                broken = Some(text.clone());
            }
            while let Some(i) = next.next_if(|&i| i < end) {
                visit(i, &mut FailRead(Some(Error::new(kind, text.clone()))))?;
            }
        }
        // entries with no bytes after the last block
        for i in next {
            visit(i, &mut io::empty())?;
        }
        match broken {
            Some(why) => Err(Error::new(ErrorKind::InvalidData, why)),
            None => Ok(()),
        }
    }
}

/// One file's bytes on their way into the solid block, opened only when the writer reaches it
/// (thousands of files must not hold thousands of handles): exactly the size listed, counted
/// into progress, with a cancel check per 1 MB. A file that shrank since it was listed is an
/// error. Errors are `Other`: the writer's own loop hands them back unchanged.
struct LazyFile<'r, 'p, 'a> {
    item: &'r Item,
    from: Option<io::Take<File>>,
    left: u64,
    since_check: usize,
    progress: &'r RefCell<&'p mut ArchiveProgress<'a>>,
}

impl Read for LazyFile<'_, '_, '_> {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        let from = match &mut self.from {
            Some(f) => f,
            None => {
                let mut progress = self.progress.borrow_mut();
                if progress.check_cancel().is_err() {
                    return Err(Error::other("cancelled"));
                }
                progress.set_current(&self.item.path.to_string_lossy());
                drop(progress);
                self.from
                    .insert(File::open(&self.item.path)?.take(self.left))
            }
        };
        if self.since_check >= BUFFER {
            self.since_check = 0;
            if self.progress.borrow().check_cancel().is_err() {
                return Err(Error::other("cancelled"));
            }
        }
        let n = from.read(buf)?;
        if n == 0 && self.left > 0 {
            return Err(Error::other("A file got smaller while being compressed"));
        }
        self.left -= n as u64;
        self.since_check += n;
        self.progress.borrow_mut().add(n as u64);
        Ok(n)
    }
}

/// The entry `item` becomes: name, modified time and attributes (with the unix mode in the
/// high bits off Windows, as 7-Zip writes it).
fn entry_for(item: &Item) -> ArchiveEntry {
    let mut entry = if item.dir {
        ArchiveEntry::new_directory(&item.inside)
    } else {
        ArchiveEntry::new_file(&item.inside)
    };
    // follows a link on purpose: like the zip writer, a file link stores its target's bytes
    let meta = std::fs::metadata(&item.path).ok();
    if let Some(t) = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| NtTime::try_from(t).ok())
    {
        entry.last_modified_date = t;
        entry.has_last_modified_date = true;
    }
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut attrs = if item.dir {
        ATTR_DIRECTORY
    } else {
        ATTR_ARCHIVE
    };
    #[cfg(unix)]
    if let Some(m) = &meta {
        use std::os::unix::fs::PermissionsExt;
        let kind = if item.dir { S_IFDIR } else { S_IFREG };
        attrs |= ATTR_UNIX_EXTENSION | ((kind | (m.permissions().mode() & 0o777)) << 16);
    }
    entry.has_windows_attributes = true;
    entry.windows_attributes = attrs;
    entry
}

/// Compress `paths` into one `.7z` (LZMA2, solid) beside the first of them, named like
/// Compress to ZIP names its zip. Written under a `.<name>.trove-partial` name and renamed into
/// place only when whole, never over an existing file; a cancel or any error deletes the
/// partial.
pub(crate) fn compress(paths: &[PathBuf], progress: &mut ArchiveProgress) -> Result<PathBuf> {
    let (dir, base) = place(paths)?;
    let dir = dir.as_path();
    let name = format!("{base}.7z");
    let items = list_items(paths)?;
    progress.items = items.len() as u64;
    progress.set_total(items.iter().fold(0u64, |t, i| t.saturating_add(i.size)));

    let partial = Partial {
        path: dir.join(ops::unique_name(
            dir,
            &format!(".{name}.trove-partial"),
            false,
        )),
        armed: true,
    };
    let file = File::options()
        .write(true)
        .create_new(true)
        .open(&partial.path)?;
    let mut writer = ArchiveWriter::new(BufWriter::new(file)).map_err(from_7z)?;
    let shared = RefCell::new(&mut *progress);
    let mut entries = Vec::new();
    let mut readers = Vec::new();
    for item in &items {
        if shared.borrow().check_cancel().is_err() {
            return Err(cancelled());
        }
        if item.dir || item.size == 0 {
            // no bytes: an entry with no stream (7z's "empty file" when not a folder)
            writer
                .push_archive_entry(entry_for(item), None::<io::Empty>)
                .map_err(from_7z)?;
            continue;
        }
        entries.push(entry_for(item));
        readers.push(SourceReader::new(LazyFile {
            item,
            from: None,
            left: item.size,
            since_check: 0,
            progress: &shared,
        }));
    }
    if !entries.is_empty() {
        if let Err(e) = writer.push_archive_entries(entries, readers) {
            if shared.borrow().check_cancel().is_err() {
                return Err(cancelled());
            }
            return Err(match e {
                sevenz_rust2::Error::Io(e, _) => e,
                other => Error::other(other.to_string()),
            });
        }
    }
    let mut out = writer.finish()?.into_inner().map_err(|e| e.into_error())?;
    out.flush()?;
    drop(out);
    progress.set_current("");
    // picked only now, and still no-replace: a file that took this name meanwhile is kept
    let landed = land_no_replace(
        &partial.path,
        &dir.join(ops::unique_name(dir, &name, false)),
    )?;
    partial.keep();
    Ok(landed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::archive::job::tests::extract;
    use crate::core::archive::job::{run_compress, run_extract};
    use crate::core::archive::test_util::scratch;
    use crate::core::archive::ArchiveFormat;
    use crate::core::transfer::{Resolution, TransferProgress};
    use std::fs;

    fn names_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn compress_one(src: &Path) -> PathBuf {
        let cancel = AtomicBool::new(false);
        let done = run_compress(
            1,
            &[src.to_path_buf()],
            ArchiveFormat::SevenZ,
            &cancel,
            &|_| {},
        );
        assert_eq!(done.error, None);
        PathBuf::from(&done.outputs[0].to)
    }

    /// A 7z at `path` holding `files` (name, bytes) written raw through the crate's writer,
    /// names exactly as given; `solid` puts every file in one block.
    fn make_7z(path: &Path, files: &[(&str, &[u8])], solid: bool) {
        let mut w = ArchiveWriter::create(path).unwrap();
        if solid {
            let entries = files
                .iter()
                .map(|(n, _)| ArchiveEntry::new_file(n))
                .collect();
            let readers = files.iter().map(|(_, b)| SourceReader::new(*b)).collect();
            w.push_archive_entries(entries, readers).unwrap();
        } else {
            for (n, b) in files {
                w.push_archive_entry(ArchiveEntry::new_file(n), Some(*b))
                    .unwrap();
            }
        }
        w.finish().unwrap();
    }

    /// Bytes LZMA cannot shrink, so a cut or a flipped byte lands inside a file's data.
    fn noise(len: usize) -> Vec<u8> {
        let mut x = 0x2545_f491_u32;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect()
    }

    #[test]
    fn round_trip_7z() {
        let root = scratch("7z-round");
        let src = root.join("a").join("b").join("Photos");
        fs::create_dir_all(src.join("2024")).unwrap();
        fs::write(src.join("2024").join("a.jpg"), b"jpg").unwrap();
        fs::write(src.join("top.txt"), vec![5u8; 2 * BUFFER + 7]).unwrap();
        fs::write(src.join("zero.txt"), b"").unwrap();
        let out = compress_one(&src);
        assert_eq!(out.file_name().unwrap().to_string_lossy(), "Photos.7z");
        // solid: every file with bytes is in one block
        let source = SevenZSource::open(&out, None).unwrap();
        assert_eq!(source.archive.blocks.len(), 1);
        let dest = root.join("a").join("b").join("out");
        fs::create_dir_all(&dest).unwrap();
        let done = extract(&out, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        let back = dest.join("Photos");
        assert_eq!(fs::read(back.join("2024").join("a.jpg")).unwrap(), b"jpg");
        assert_eq!(
            fs::read(back.join("top.txt")).unwrap(),
            vec![5u8; 2 * BUFFER + 7]
        );
        assert_eq!(fs::read(back.join("zero.txt")).unwrap(), b"");
        let t0 = fs::metadata(src.join("top.txt"))
            .unwrap()
            .modified()
            .unwrap();
        let t1 = fs::metadata(back.join("top.txt"))
            .unwrap()
            .modified()
            .unwrap();
        let diff = t0
            .duration_since(t1)
            .or_else(|e| Ok::<_, ()>(e.duration()))
            .unwrap();
        assert!(diff.as_secs() <= 1, "{diff:?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_folder_survives() {
        let root = scratch("7z-empty-dir");
        let src = root.join("a").join("b").join("Box");
        fs::create_dir_all(src.join("empty").join("deeper")).unwrap();
        fs::write(src.join("one.txt"), b"1").unwrap();
        let out = compress_one(&src);
        let dest = root.join("a").join("b").join("out");
        fs::create_dir_all(&dest).unwrap();
        let done = extract(&out, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        assert!(dest.join("Box").join("empty").join("deeper").is_dir());
        assert_eq!(fs::read(dest.join("Box").join("one.txt")).unwrap(), b"1");
        fs::remove_dir_all(root).unwrap();
    }

    /// The 7z writer stores a name as given (checked: `..\x` and `../x` both go in), so the
    /// slip archive is made here, no fixture needed. Both spellings are refused on extract.
    #[test]
    fn seven_z_slip_is_refused() {
        for solid in [false, true] {
            let root = scratch(&format!("7z-slip-{solid}"));
            let dest = root.join("a").join("b").join("dest");
            fs::create_dir_all(&dest).unwrap();
            let archive = root.join("in.7z");
            make_7z(
                &archive,
                &[
                    ("..\\x.txt", b"back"),
                    ("../evil.txt", b"evil"),
                    ("good.txt", b"good"),
                ],
                solid,
            );
            let names: Vec<String> = SevenZSource::open(&archive, None)
                .unwrap()
                .entries()
                .unwrap()
                .into_iter()
                .map(|e| e.name)
                .collect();
            assert_eq!(names, ["..\\x.txt", "../evil.txt", "good.txt"]);
            let done = extract(&archive, &dest, Resolution::Skip);
            assert_eq!(fs::read(dest.join("good.txt")).unwrap(), b"good");
            let b = dest.parent().unwrap();
            assert!(!b.join("x.txt").exists() && !b.join("evil.txt").exists());
            assert_eq!(names_in(&dest), ["good.txt"]);
            assert_eq!(done.failed.len(), 2, "{:?}", done.failed);
            assert!(done
                .failed
                .iter()
                .all(|f| f.error.starts_with("Unsafe path")));
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn links_and_anti_items_are_failure_rows() {
        let root = scratch("7z-link");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let archive = root.join("in.7z");
        let mut w = ArchiveWriter::create(&archive).unwrap();
        let mut link = ArchiveEntry::new_file("link");
        link.has_windows_attributes = true;
        link.windows_attributes = ATTR_UNIX_EXTENSION | ((S_IFLNK | 0o777) << 16);
        w.push_archive_entry(link, Some(&b"/etc"[..])).unwrap();
        let mut reparse = ArchiveEntry::new_directory("junction");
        reparse.has_windows_attributes = true;
        reparse.windows_attributes = ATTR_DIRECTORY | ATTR_REPARSE_POINT;
        w.push_archive_entry(reparse, None::<&[u8]>).unwrap();
        w.push_archive_entry(ArchiveEntry::new_file("ok.txt"), Some(&b"ok"[..]))
            .unwrap();
        w.finish().unwrap();
        let done = extract(&archive, &dest, Resolution::Skip);
        assert_eq!(names_in(&dest), ["ok.txt"]);
        assert_eq!(done.failed.len(), 2, "{:?}", done.failed);
        assert!(done
            .failed
            .iter()
            .all(|f| f.error.starts_with("Link not extracted")));

        let mut anti = ArchiveEntry::new_file("gone.txt");
        anti.is_anti_item = true;
        assert!(info_of(0, &anti, false).special);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancel_mid_7z_compress_leaves_nothing() {
        let root = scratch("7z-cancel");
        let src = root.join("a").join("b").join("big");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("1.bin"), noise(3 * BUFFER)).unwrap();
        fs::write(src.join("2.bin"), vec![2u8; BUFFER]).unwrap();
        let cancel = AtomicBool::new(false);
        let sink = |p: TransferProgress| {
            if p.bytes_done > 0 {
                cancel.store(true, Ordering::Relaxed);
            }
        };
        let done = run_compress(
            1,
            std::slice::from_ref(&src),
            ArchiveFormat::SevenZ,
            &cancel,
            &sink,
        );
        assert!(done.cancelled, "{:?}", done.error);
        assert!(done.outputs.is_empty());
        assert_eq!(names_in(&root.join("a").join("b")), ["big"]);

        // and extracting: a cancel midway stops the job and leaves no partial
        let archive = compress_one(&src);
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let cancel2 = AtomicBool::new(false);
        let sink = |p: TransferProgress| {
            if p.bytes_done > 0 {
                cancel2.store(true, Ordering::Relaxed);
            }
        };
        let done = run_extract(1, &archive, &dest, None, Resolution::Skip, &cancel2, &sink);
        assert!(done.cancelled, "{:?}", done.error);
        let left: Vec<String> = walkdir::WalkDir::new(&dest)
            .into_iter()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("trove-partial"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_damaged_block_keeps_the_others() {
        let root = scratch("7z-damaged");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let archive = root.join("in.7z");
        let bad = noise(64 * 1024);
        // non-solid: one block per file, so a broken second block leaves the first and third
        make_7z(
            &archive,
            &[
                ("first.txt", b"first"),
                ("second.bin", &bad),
                ("third.txt", b"third"),
            ],
            false,
        );
        let mut bytes = fs::read(&archive).unwrap();
        // inside second.bin's packed bytes: after the 32-byte signature header and first.txt
        let at = 32 + 40 + 1000;
        bytes[at] ^= 0xFF;
        bytes[at + 1] ^= 0xFF;
        fs::write(&archive, &bytes).unwrap();
        let done = extract(&archive, &dest, Resolution::Skip);
        assert_eq!(fs::read(dest.join("first.txt")).unwrap(), b"first");
        assert_eq!(fs::read(dest.join("third.txt")).unwrap(), b"third");
        assert!(!dest.join("second.bin").exists());
        assert_eq!(done.failed.len(), 1, "{:?}", done.failed);
        assert!(
            done.failed[0].path.ends_with("second.bin"),
            "{:?}",
            done.failed
        );
        assert_eq!(names_in(&dest), ["first.txt", "third.txt"]);

        // a 7z cut short loses its header (it is at the end): refused in plain words
        let cut = root.join("cut.7z");
        fs::write(&cut, &bytes[..bytes.len() / 2]).unwrap();
        let err = SevenZSource::open(&cut, None).err().unwrap();
        assert!(err.to_string().contains("damaged or cut short"), "{err}");
        fs::remove_dir_all(root).unwrap();
    }

    /// A 7z made by 7-Zip 7z.exe itself, not by our writer: an LZMA2 solid block (a.txt and
    /// sub/b.txt), then a PPMd block and a BZip2 block appended, plus an empty folder.
    /// Names inside use 7-Zip's own separators. Proves real-world 7z, not just a round trip.
    #[test]
    fn real_7zip_archive_extracts() {
        const REAL: &[u8] = include_bytes!("testdata/7zip-lzma2-ppmd-bzip2.7z");
        fn lines(n: usize, f: impl Fn(usize) -> String) -> String {
            (1..=n).map(|i| f(i) + "\n").collect()
        }
        let root = scratch("7z-real");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let archive = root.join("real.7z");
        fs::write(&archive, REAL).unwrap();
        let source = SevenZSource::open(&archive, None).unwrap();
        assert_eq!(source.archive.blocks.len(), 3);
        let done = extract(&archive, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        assert!(done.failed.is_empty(), "{:?}", done.failed);
        let real = dest.join("real");
        let read = |p: &Path| String::from_utf8(fs::read(p).unwrap()).unwrap();
        assert_eq!(
            read(&real.join("a.txt")),
            lines(200, |i| format!(
                "line {i} of the lzma2 solid block - trove 7z fixture"
            ))
        );
        assert_eq!(
            read(&real.join("sub").join("b.txt")),
            lines(100, |i| format!("nested {i}"))
        );
        assert_eq!(
            read(&real.join("ppmd.txt")),
            lines(150, |i| format!(
                "ppmd text line {i}, compressible prose for the PPMd method"
            ))
        );
        assert_eq!(
            read(&real.join("bz.txt")),
            lines(120, |i| format!("bzip2 row {i}"))
        );
        assert!(real.join("empty").is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nt_time_out_of_range_is_none() {
        assert_eq!(nt_to_system(NtTime::from(0)), None);
        // the far end fits in a Unix SystemTime but not in a Windows one; either way no panic
        assert!(nt_to_system(NtTime::from(u64::MAX)).is_none_or(|t| t > UNIX_EPOCH));
        assert_eq!(
            nt_to_system(NtTime::from(116_444_736_000_000_000)),
            Some(UNIX_EPOCH)
        );
    }
}

//! tar, bare or compressed with gz / xz / zst (plan 16 Phase 2): the reader the extract engine
//! (`job.rs`) walks, and Compress to tar.gz / tar.xz / tar.zst.
//!
//! A compressed tar is one stream that can only be read front to back, so the reader never
//! opens an entry alone: `entries` decompresses the whole archive once to list it, and `each`
//! decompresses it again from the start and hands the wanted entries over in order. Each pass
//! opens the file afresh (`tar::Archive::entries` refuses to start anywhere but the front).
//!
//! A `.gz` / `.xz` / `.zst` that is not a tar inside (`notes.txt.gz`) is one compressed file:
//! it extracts as that one file, named after the archive without its extension.
//!
//! Every entry name still goes through `safe_path` in `job.rs`; links, devices and FIFOs are
//! failure rows there, never made.

use std::fs::File;
use std::io::{self, BufReader, Error, ErrorKind, Read, Result, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};

use tar::{Archive, Builder, EntryType, Header};

use super::job::{land_no_replace, ArchiveProgress, EntryInfo, Source, Visit};
use super::zip_fmt::{list_items, place};
use super::{archive_stem, ArchiveFormat, TarCodec};
use crate::core::ops;
use crate::core::transfer::Partial;

const BUFFER: usize = 1024 * 1024;
const BLOCK: usize = 512;

/// The message a damaged or cut-short stream ends the job with.
fn damaged(e: &Error) -> Error {
    Error::new(
        ErrorKind::InvalidData,
        format!("The archive is damaged or cut short: {e}"),
    )
}

fn cancelled() -> Error {
    Error::new(ErrorKind::Interrupted, "cancelled")
}

/// Fails every read once Cancel is pressed, so a pass through a huge entry stops too. The
/// error is `Other`, not `Interrupted`: `io::copy` and the tar crate retry an `Interrupted`
/// read forever. Whoever sees the error checks the flag and turns it into the cancel.
struct CancelRead<'c, R> {
    inner: R,
    cancel: Option<&'c AtomicBool>,
}

impl<R: Read> Read for CancelRead<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        if self.cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(Error::other("cancelled"));
        }
        self.inner.read(buf)
    }
}

/// An entry's bytes as the engine sees them: once Cancel is pressed any read error is the
/// cancel (`Interrupted`), which stops the job instead of becoming a failure row.
struct EntryRead<'a, 'c> {
    inner: &'a mut dyn Read,
    cancel: Option<&'c AtomicBool>,
}

impl Read for EntryRead<'_, '_> {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        self.inner.read(buf).map_err(|e| {
            if self.cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                cancelled()
            } else {
                e
            }
        })
    }
}

/// An open tar.*, read in passes.
pub(crate) struct TarSource<'c> {
    path: PathBuf,
    codec: TarCodec,
    /// `Some(name)`: not a tar inside, one compressed file of that name
    single: Option<String>,
    cancel: Option<&'c AtomicBool>,
    /// why the listing pass stopped early, if it did: `each` reports it once it is done
    broken: Option<String>,
}

impl<'c> TarSource<'c> {
    pub fn open(path: &Path, codec: TarCodec, cancel: Option<&'c AtomicBool>) -> Result<Self> {
        let mut source = TarSource {
            path: path.to_path_buf(),
            codec,
            single: None,
            cancel,
            broken: None,
        };
        if codec != TarCodec::None {
            let mut head = [0u8; BLOCK];
            let mut got = 0;
            let mut stream = source.stream()?;
            while got < BLOCK {
                match stream.read(&mut head[got..]) {
                    Ok(0) => break,
                    Ok(n) => got += n,
                    Err(e) => return Err(damaged(&e)),
                }
            }
            if got < BLOCK || !looks_like_tar(&head) {
                source.single = Some(archive_stem(path));
            }
        }
        Ok(source)
    }

    /// The decompressed bytes from the start, from a fresh file handle.
    fn stream(&self) -> Result<Box<dyn Read + 'c>> {
        let file = BufReader::new(File::open(&self.path)?);
        let inner: Box<dyn Read> = match self.codec {
            TarCodec::None => Box::new(file),
            TarCodec::Gz => Box::new(flate2::read::MultiGzDecoder::new(file)),
            TarCodec::Xz => Box::new(lzma_rust2::XzReader::new(file, true)),
            TarCodec::Zst => Box::new(zstd::Decoder::with_buffer(file)?),
        };
        Ok(Box::new(CancelRead {
            inner,
            cancel: self.cancel,
        }))
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.is_some_and(|c| c.load(Ordering::Relaxed))
    }

    fn check_cancel(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(cancelled())
        } else {
            Ok(())
        }
    }

    /// Every entry of the tar in order (a pax global header is not an entry), numbered the
    /// same on every pass. A broken stream is `WalkError::Stream`; an error from `visit`, or a
    /// cancel between entries, is `WalkError::Visit`.
    fn walk(&self, visit: &mut WalkVisit<'_, 'c>) -> std::result::Result<(), WalkError> {
        let mut archive = Archive::new(self.stream().map_err(WalkError::Stream)?);
        let entries = archive.entries().map_err(WalkError::Stream)?;
        let mut index = 0usize;
        for entry in entries {
            self.check_cancel().map_err(WalkError::Visit)?;
            let mut entry = entry.map_err(WalkError::Stream)?;
            if entry.header().entry_type() == EntryType::XGlobalHeader {
                continue;
            }
            if !visit(index, &mut entry).map_err(WalkError::Visit)? {
                return Ok(());
            }
            index += 1;
        }
        Ok(())
    }

    /// The one file of a bare compressed file, counted by decompressing it.
    fn single_entry(&self, name: &str) -> Result<EntryInfo> {
        let mut stream = self.stream()?;
        let mut buf = vec![0u8; BUFFER];
        let mut size = 0u64;
        loop {
            self.check_cancel()?;
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => size += n as u64,
                Err(_) if self.is_cancelled() => return Err(cancelled()),
                Err(e) => return Err(damaged(&e)),
            }
        }
        let modified = std::fs::metadata(&self.path)
            .and_then(|m| m.modified())
            .ok();
        Ok(EntryInfo {
            index: 0,
            name: name.to_string(),
            is_dir: false,
            size,
            encrypted: false,
            link: false,
            special: false,
            mode: None,
            modified,
        })
    }
}

/// What `TarSource::walk` calls with each entry; `Ok(false)` stops the walk.
type WalkVisit<'v, 'c> = dyn FnMut(usize, &mut tar::Entry<Box<dyn Read + 'c>>) -> Result<bool> + 'v;

enum WalkError {
    Stream(Error),
    Visit(Error),
}

/// A 512-byte block that is a tar header (its checksum adds up) or the all-zero end block.
fn looks_like_tar(block: &[u8; BLOCK]) -> bool {
    if block.iter().all(|&b| b == 0) {
        return true;
    }
    let header = Header::from_byte_slice(block);
    let Ok(stored) = header.cksum() else {
        return false;
    };
    // the checksum is the byte sum with the checksum field itself read as spaces
    let sum: u32 = block
        .iter()
        .enumerate()
        .map(|(i, &b)| {
            if (148..156).contains(&i) {
                32
            } else {
                u32::from(b)
            }
        })
        .sum();
    sum == stored
}

/// What the engine needs to know of one tar entry.
fn info_of(index: usize, entry: &tar::Entry<impl Read>) -> EntryInfo {
    let header = entry.header();
    let kind = header.entry_type();
    let name = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
    let is_dir = kind.is_dir() || (kind.is_file() && name.ends_with('/'));
    let link = kind.is_symlink() || kind.is_hard_link();
    let file = kind.is_file() || kind.is_contiguous() || kind.is_gnu_sparse();
    EntryInfo {
        index,
        name,
        is_dir,
        size: if is_dir || link { 0 } else { entry.size() },
        encrypted: false,
        link,
        special: !(is_dir || link || file),
        mode: header.mode().ok(),
        modified: header
            .mtime()
            .ok()
            .and_then(|s| UNIX_EPOCH.checked_add(Duration::from_secs(s))),
    }
}

impl Source for TarSource<'_> {
    fn entries(&mut self) -> Result<Vec<EntryInfo>> {
        if let Some(name) = self.single.clone() {
            return Ok(vec![self.single_entry(&name)?]);
        }
        let mut list = Vec::new();
        let walked = self.walk(&mut |index, entry| {
            list.push(info_of(index, entry));
            Ok(true)
        });
        match walked {
            Ok(()) => {}
            Err(WalkError::Visit(e)) => return Err(e),
            Err(WalkError::Stream(_)) if self.is_cancelled() => return Err(cancelled()),
            // what was listed before the damage still extracts; the job then reports it
            Err(WalkError::Stream(e)) if !list.is_empty() => {
                self.broken = Some(damaged(&e).to_string());
            }
            Err(WalkError::Stream(e)) => return Err(damaged(&e)),
        }
        Ok(list)
    }

    fn each(&mut self, wanted: &[usize], visit: &mut Visit) -> Result<()> {
        let cancel = self.cancel;
        if self.single.is_some() {
            if wanted.first() == Some(&0) {
                let mut stream = self.stream()?;
                visit(
                    0,
                    &mut EntryRead {
                        inner: &mut stream,
                        cancel,
                    },
                )?;
            }
            return Ok(());
        }
        let mut next = wanted.iter().copied().peekable();
        let walked = self.walk(&mut |index, entry| {
            let Some(&want) = next.peek() else {
                return Ok(false);
            };
            if index == want {
                next.next();
                visit(
                    index,
                    &mut EntryRead {
                        inner: entry,
                        cancel,
                    },
                )?;
            }
            Ok(next.peek().is_some())
        });
        match walked {
            Ok(()) => {}
            Err(WalkError::Visit(e)) => return Err(e),
            Err(WalkError::Stream(_)) if self.is_cancelled() => return Err(cancelled()),
            Err(WalkError::Stream(e)) => return Err(damaged(&e)),
        }
        match self.broken.take() {
            Some(why) => Err(Error::new(ErrorKind::InvalidData, why)),
            None => Ok(()),
        }
    }
}

/// The compressor under the tar stream.
enum Encoder {
    Gz(flate2::write::GzEncoder<File>),
    Xz(lzma_rust2::XzWriter<File>),
    Zst(zstd::Encoder<'static, File>),
}

impl Encoder {
    fn new(format: ArchiveFormat, file: File) -> Result<Encoder> {
        Ok(match format {
            ArchiveFormat::TarGz => Encoder::Gz(flate2::write::GzEncoder::new(
                file,
                flate2::Compression::default(),
            )),
            ArchiveFormat::TarXz => Encoder::Xz(lzma_rust2::XzWriter::new(
                file,
                lzma_rust2::XzOptions::with_preset(6),
            )?),
            ArchiveFormat::TarZst => Encoder::Zst(zstd::Encoder::new(file, 3)?),
            _ => return Err(Error::new(ErrorKind::InvalidInput, "not a tar format")),
        })
    }

    fn finish(self) -> Result<File> {
        match self {
            Encoder::Gz(e) => e.finish(),
            Encoder::Xz(e) => e.finish(),
            Encoder::Zst(e) => e.finish(),
        }
    }
}

impl Write for Encoder {
    fn write(&mut self, buf: &[u8]) -> Result<usize> {
        match self {
            Encoder::Gz(e) => e.write(buf),
            Encoder::Xz(e) => e.write(buf),
            Encoder::Zst(e) => e.write(buf),
        }
    }

    fn flush(&mut self) -> Result<()> {
        match self {
            Encoder::Gz(e) => e.flush(),
            Encoder::Xz(e) => e.flush(),
            Encoder::Zst(e) => e.flush(),
        }
    }
}

/// A file's bytes on their way into the tar: exactly `size` of them, counted into progress,
/// with a cancel check per 1 MB. A file that shrank since it was sized is an error, never a
/// short entry (the tar would be corrupt from there on). Errors are `Other`: `io::copy`
/// retries `Interrupted` forever.
struct FileBytes<'p, 'a> {
    from: io::Take<File>,
    left: u64,
    since_check: usize,
    progress: &'p mut ArchiveProgress<'a>,
}

impl Read for FileBytes<'_, '_> {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        if self.since_check >= BUFFER {
            self.since_check = 0;
            if self.progress.check_cancel().is_err() {
                return Err(Error::other("cancelled"));
            }
        }
        let n = self.from.read(buf)?;
        if n == 0 && self.left > 0 {
            return Err(Error::other("A file got smaller while being compressed"));
        }
        self.left -= n as u64;
        self.since_check += n;
        self.progress.add(n as u64);
        Ok(n)
    }
}

/// Seconds since 1970 for a tar header (0 for a time before it or unknown).
fn tar_time(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

#[cfg(unix)]
fn tar_mode(meta: &std::fs::Metadata, _dir: bool) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o777
}

#[cfg(not(unix))]
fn tar_mode(_meta: &std::fs::Metadata, dir: bool) -> u32 {
    if dir {
        0o755
    } else {
        0o644
    }
}

/// Compress `paths` into one `.tar.gz` / `.tar.xz` / `.tar.zst` beside the first of them,
/// named like Compress to ZIP names its zip. Written under a `.<name>.trove-partial` name and
/// renamed into place only when whole, never over an existing file; a cancel or any error
/// deletes the partial.
pub(crate) fn compress(
    paths: &[PathBuf],
    format: ArchiveFormat,
    progress: &mut ArchiveProgress,
) -> Result<PathBuf> {
    let ext = match format {
        ArchiveFormat::TarGz => "tar.gz",
        ArchiveFormat::TarXz => "tar.xz",
        ArchiveFormat::TarZst => "tar.zst",
        _ => return Err(Error::new(ErrorKind::InvalidInput, "not a tar format")),
    };
    let (dir, base) = place(paths)?;
    let dir = dir.as_path();
    let name = format!("{base}.{ext}");
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
    let mut builder = Builder::new(Encoder::new(format, file)?);
    builder.follow_symlinks(false);
    for item in &items {
        progress.check_cancel()?;
        progress.set_current(&item.path.to_string_lossy());
        let meta = std::fs::symlink_metadata(&item.path)?;
        let mut header = Header::new_gnu();
        header.set_mtime(tar_time(&meta));
        if let Some(target) = &item.link {
            // Mac/Linux only (`link` is always `None` on Windows): stored as a link, not followed
            header.set_entry_type(EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            builder.append_link(&mut header, &item.inside, target)?;
            continue;
        }
        if item.dir {
            header.set_entry_type(EntryType::Directory);
            header.set_size(0);
            header.set_mode(tar_mode(&meta, true));
            builder.append_data(&mut header, format!("{}/", item.inside), io::empty())?;
            continue;
        }
        let from = File::open(&item.path)?;
        let meta = from.metadata()?;
        let size = meta.len();
        header.set_entry_type(EntryType::Regular);
        header.set_size(size);
        header.set_mode(tar_mode(&meta, false));
        header.set_mtime(tar_time(&meta));
        let bytes = FileBytes {
            from: from.take(size),
            left: size,
            since_check: 0,
            progress,
        };
        if let Err(e) = builder.append_data(&mut header, &item.inside, bytes) {
            progress.check_cancel()?;
            return Err(e);
        }
    }
    let mut file = builder.into_inner()?.finish()?;
    file.flush()?;
    drop(file);
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

    fn compress_one(src: &Path, format: ArchiveFormat) -> PathBuf {
        let cancel = AtomicBool::new(false);
        let done = run_compress(1, &[src.to_path_buf()], format, &cancel, &|_| {});
        assert_eq!(done.error, None);
        PathBuf::from(&done.outputs[0].to)
    }

    /// A tar.gz at `path` built by `fill`.
    fn make_tar_gz(path: &Path, fill: impl FnOnce(&mut Builder<flate2::write::GzEncoder<File>>)) {
        let enc =
            flate2::write::GzEncoder::new(File::create(path).unwrap(), flate2::Compression::fast());
        let mut b = Builder::new(enc);
        fill(&mut b);
        b.into_inner().unwrap().finish().unwrap();
    }

    fn file_header(size: u64) -> Header {
        let mut h = Header::new_gnu();
        h.set_entry_type(EntryType::Regular);
        h.set_size(size);
        h.set_mode(0o644);
        h
    }

    /// Appends a file whose name is written raw, so `..` survives (`append_data` refuses it).
    fn append_raw(b: &mut Builder<impl Write>, name: &str, bytes: &[u8]) {
        let mut h = file_header(bytes.len() as u64);
        let field = &mut h.as_old_mut().name;
        field.fill(0);
        field[..name.len()].copy_from_slice(name.as_bytes());
        h.set_cksum();
        b.append(&h, bytes).unwrap();
    }

    #[test]
    fn round_trip_each_codec() {
        for (format, ext) in [
            (ArchiveFormat::TarGz, "tar.gz"),
            (ArchiveFormat::TarXz, "tar.xz"),
            (ArchiveFormat::TarZst, "tar.zst"),
        ] {
            let root = scratch(&format!("tar-round-{}", ext.replace('.', "-")));
            let src = root.join("a").join("b").join("Photos");
            fs::create_dir_all(src.join("2024")).unwrap();
            fs::create_dir_all(src.join("empty")).unwrap();
            fs::write(src.join("2024").join("a.jpg"), b"jpg").unwrap();
            fs::write(src.join("top.txt"), vec![5u8; 2 * BUFFER + 7]).unwrap();
            let out = compress_one(&src, format);
            assert_eq!(
                out.file_name().unwrap().to_string_lossy(),
                format!("Photos.{ext}")
            );
            let dest = root.join("a").join("b").join("out");
            fs::create_dir_all(&dest).unwrap();
            let done = extract(&out, &dest, Resolution::Skip);
            assert_eq!(done.error, None, "{ext}: {:?}", done.failed);
            let back = dest.join("Photos");
            assert_eq!(fs::read(back.join("2024").join("a.jpg")).unwrap(), b"jpg");
            assert_eq!(
                fs::read(back.join("top.txt")).unwrap(),
                vec![5u8; 2 * BUFFER + 7]
            );
            assert!(back.join("empty").is_dir());
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
            assert!(diff.as_secs() <= 1, "{ext}: {diff:?}");
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn tar_slip_via_dot_dot_is_refused() {
        let root = scratch("tar-slip");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let archive = root.join("in.tar.gz");
        make_tar_gz(&archive, |b| {
            append_raw(b, "../evil.txt", b"evil");
            append_raw(b, "good.txt", b"good");
        });
        let done = extract(&archive, &dest, Resolution::Skip);
        assert_eq!(fs::read(dest.join("good.txt")).unwrap(), b"good");
        assert!(!dest.parent().unwrap().join("evil.txt").exists());
        assert!(!dest.join("evil.txt").exists());
        assert_eq!(done.failed.len(), 1, "{:?}", done.failed);
        assert!(done.failed[0].error.starts_with("Unsafe path"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tar_symlink_then_file_through_it_is_refused() {
        let root = scratch("tar-link");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let archive = root.join("in.tar.gz");
        make_tar_gz(&archive, |b| {
            let mut h = Header::new_gnu();
            h.set_entry_type(EntryType::Symlink);
            h.set_size(0);
            h.set_mode(0o777);
            b.append_link(&mut h, "top/link", &outside).unwrap();
            let mut h = file_header(4);
            b.append_data(&mut h, "top/link/pwn.txt", &b"pwn!"[..])
                .unwrap();
        });
        let done = extract(&archive, &dest, Resolution::Skip);
        assert!(names_in(&outside).is_empty(), "wrote through the link");
        let link = dest.join("top").join("link");
        assert!(fs::symlink_metadata(&link).map_or(true, |m| !m.file_type().is_symlink()));
        assert!(
            done.failed
                .iter()
                .any(|f| f.error.starts_with("Link not extracted")),
            "{:?}",
            done.failed
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn setuid_bit_is_dropped() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("tar-suid");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let archive = root.join("in.tar.gz");
        make_tar_gz(&archive, |b| {
            let mut h = file_header(2);
            h.set_mode(0o4755);
            b.append_data(&mut h, "run.sh", &b"#!"[..]).unwrap();
        });
        let done = extract(&archive, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        let mode = fs::metadata(dest.join("run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o7000, 0, "{mode:o}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancel_mid_xz_leaves_no_partial() {
        let root = scratch("tar-cancel-xz");
        let src = root.join("a").join("b").join("big");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("1.bin"), vec![1u8; 3 * BUFFER]).unwrap();
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
            ArchiveFormat::TarXz,
            &cancel,
            &sink,
        );
        assert!(done.cancelled, "{:?}", done.error);
        assert!(done.outputs.is_empty());
        assert_eq!(names_in(&root.join("a").join("b")), ["big"]);

        // and extracting: a cancel midway leaves what landed and no partial
        let cancel2 = AtomicBool::new(false);
        let archive = compress_one(&src, ArchiveFormat::TarXz);
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
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
    fn a_truncated_tar_gz_reports_and_keeps_what_arrived() {
        let root = scratch("tar-cut");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let whole = root.join("whole.tar.gz");
        // incompressible bytes, so cutting the .gz in half cuts inside the second file
        let mut noise = vec![0u8; 256 * 1024];
        let mut x = 0x2545_f491_u32;
        for b in noise.iter_mut() {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            *b = x as u8;
        }
        make_tar_gz(&whole, |b| {
            let mut h = file_header(5);
            b.append_data(&mut h, "first.txt", &b"first"[..]).unwrap();
            let mut h = file_header(noise.len() as u64);
            b.append_data(&mut h, "second.bin", &noise[..]).unwrap();
        });
        let bytes = fs::read(&whole).unwrap();
        let cut = root.join("cut.tar.gz");
        fs::write(&cut, &bytes[..bytes.len() / 2]).unwrap();
        let done = extract(&cut, &dest, Resolution::Skip);
        assert_eq!(fs::read(dest.join("first.txt")).unwrap(), b"first");
        assert!(!dest.join("second.bin").exists());
        let error = done.error.unwrap_or_default();
        assert!(
            error.contains("damaged or cut short") || !done.failed.is_empty(),
            "{error:?} {:?}",
            done.failed
        );
        assert!(!error.is_empty());
        assert_eq!(names_in(&dest), ["first.txt"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bare_gz_extracts_one_file() {
        let root = scratch("tar-bare-gz");
        let dest = root.join("a").join("b").join("dest");
        fs::create_dir_all(&dest).unwrap();
        let gz = root.join("notes.txt.gz");
        let mut enc = flate2::write::GzEncoder::new(
            File::create(&gz).unwrap(),
            flate2::Compression::default(),
        );
        enc.write_all(b"hello notes").unwrap();
        enc.finish().unwrap();
        let done = extract(&gz, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        assert_eq!(fs::read(dest.join("notes.txt")).unwrap(), b"hello notes");
        fs::remove_dir_all(root).unwrap();
    }
}

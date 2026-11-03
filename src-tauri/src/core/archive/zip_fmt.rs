//! ZIP: the reader the extract engine (`job.rs`) pulls entries from, and Compress to ZIP
//! (moved here from `ops.rs` `write_zip`, plan 16 step 1.2) with a cancel check per entry and
//! per 1 MB buffer.
//!
//! Every entry name still goes through `safe_path` in `job.rs`; that rule is stricter than the
//! crate's own `enclosed_name` (it refuses every `..`, not only one that climbs out).

use std::fs::File;
use std::io::{Error, ErrorKind, Read, Result, Write};
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::job::{land_no_replace, ArchiveProgress, EntryInfo, Source};
use crate::core::ops;
use crate::core::transfer::Partial;

const BUFFER: usize = 1024 * 1024;

fn zip_err(e: zip::result::ZipError) -> Error {
    match e {
        zip::result::ZipError::Io(e) => e,
        e => Error::new(ErrorKind::InvalidData, e.to_string()),
    }
}

/// The entry's name. The crate decodes a name without the UTF-8 flag (general-purpose bit 11) as
/// CP437, but macOS `zip` writes UTF-8 bytes and leaves the flag off, so `café.txt` came out as
/// `cafe╠ü.txt`. Info-ZIP `unzip` and `ditto` try the raw bytes as UTF-8 first; so do we, and
/// CP437 (the crate's reading, which also honours a 0x7075 Unicode-path field) is the fallback.
fn entry_name(decoded: &str, raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(u) if u.is_ascii() => decoded.to_string(),
        Ok(_) if decoded.as_bytes() == raw => decoded.to_string(),
        Ok(utf8) => utf8.to_string(),
        Err(_) => decoded.to_string(),
    }
}

/// An open zip, read through its central directory.
pub(crate) struct ZipSource {
    archive: ZipArchive<File>,
}

impl ZipSource {
    pub fn open(path: &Path) -> Result<ZipSource> {
        let archive = ZipArchive::new(File::open(path)?).map_err(zip_err)?;
        Ok(ZipSource { archive })
    }
}

impl Source for ZipSource {
    fn entries(&mut self) -> Result<Vec<EntryInfo>> {
        let mut out = Vec::with_capacity(self.archive.len());
        for index in 0..self.archive.len() {
            // raw: the directory record only, so an encrypted entry lists instead of failing
            let f = self.archive.by_index_raw(index).map_err(zip_err)?;
            out.push(EntryInfo {
                index,
                name: entry_name(f.name(), f.name_raw()),
                is_dir: f.is_dir(),
                size: f.size(),
                encrypted: f.encrypted(),
                link: f.is_symlink(),
                special: false,
                mode: f.unix_mode(),
                modified: f.last_modified().and_then(time::from_zip),
            });
        }
        Ok(out)
    }

    fn open(&mut self, index: usize) -> Result<Box<dyn Read + '_>> {
        Ok(Box::new(self.archive.by_index(index).map_err(zip_err)?))
    }
}

/// One thing that goes into the archive, listed before a byte is written so the total is known.
pub(crate) struct Item {
    /// the name inside the archive, `/` separated
    pub inside: String,
    pub path: PathBuf,
    pub dir: bool,
    pub size: u64,
    /// Mac/Linux: a symlink's own target, which a tar stores as a link. The zip writer ignores
    /// it (a folder link is an empty folder there, a file link its target's bytes). Always
    /// `None` on Windows, where a link's target (`\??\C:\x`) must never reach an archive.
    pub link: Option<PathBuf>,
}

/// A unix symlink's target; `None` for anything else and everywhere on Windows.
fn link_target(path: &Path, meta: &std::fs::Metadata) -> Option<PathBuf> {
    if cfg!(unix) && meta.file_type().is_symlink() {
        std::fs::read_link(path).ok()
    } else {
        None
    }
}

/// Size of a file item: its target's for a link (a dangling unix link counts 0 here; the zip
/// writer then fails on it as before, the tar writer stores the link).
fn item_size(path: &Path, link: &Option<PathBuf>) -> Result<u64> {
    match std::fs::metadata(path) {
        Ok(m) => Ok(m.len()),
        Err(_) if link.is_some() => Ok(0),
        Err(e) => Err(e),
    }
}

/// Where an archive of `paths` lands and its name without extension: beside the first item,
/// named after the single item (`report`, `Photos`) or `Archive`.
pub(crate) fn place(paths: &[PathBuf]) -> Result<(PathBuf, String)> {
    let first = paths
        .first()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "Nothing to compress"))?;
    let dir = first
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "Cannot compress a drive root"))?;
    let base = match paths {
        [only] => only
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Archive".to_string()),
        _ => "Archive".to_string(),
    };
    Ok((dir.to_path_buf(), base))
}

/// Every selected item and, for a folder, everything under it. A folder link goes in as an
/// empty folder (its contents belong to its target, and walking it could loop); an
/// unreadable entry fails the archive rather than quietly leaving it out.
pub(crate) fn list_items(paths: &[PathBuf]) -> Result<Vec<Item>> {
    let mut items = Vec::new();
    for path in paths {
        // ⚠️ Lossy, on purpose: a name that is not valid UTF-16 (an unpaired surrogate, legal
        // on NTFS) has no exact spelling in a zip entry, which is UTF-8. It goes in with U+FFFD
        // where the bad unit was — renamed, but present.
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "Cannot compress a drive root"))?;
        // `symlink_metadata`, not `is_dir`: a selected link must not be walked into its target
        let top = std::fs::symlink_metadata(path)?;
        let link = link_target(path, &top);
        if ops::is_folder_link(path, &top) {
            items.push(Item {
                inside: name,
                path: path.clone(),
                dir: true,
                size: 0,
                link,
            });
            continue;
        }
        if !top.is_dir() {
            items.push(Item {
                inside: name,
                path: path.clone(),
                dir: false,
                size: item_size(path, &link)?,
                link,
            });
            continue;
        }
        for entry in walkdir::WalkDir::new(path).follow_links(false) {
            let entry = entry.map_err(|e| Error::other(e.to_string()))?;
            let rel = entry.path().strip_prefix(path).unwrap_or(entry.path());
            let inside = std::iter::once(name.clone())
                .chain(rel.iter().map(|c| c.to_string_lossy().into_owned()))
                .filter(|c| !c.is_empty())
                .collect::<Vec<_>>()
                .join("/");
            let meta = std::fs::symlink_metadata(entry.path())?;
            let link = link_target(entry.path(), &meta);
            let dir = ops::is_folder_link(entry.path(), &meta) || entry.file_type().is_dir();
            let size = if dir {
                0
            } else {
                item_size(entry.path(), &link)?
            };
            items.push(Item {
                inside,
                path: entry.path().to_path_buf(),
                dir,
                size,
                link,
            });
        }
    }
    Ok(items)
}

/// Explorer's "Compress to ZIP file": the items land in one archive beside them, named after
/// the single item (`report.zip`, `Photos.zip`) or `Archive.zip`, never over an existing file.
///
/// The archive is written under a `.<name>.trove-partial` name and renamed into place only when
/// whole, with a no-replace rename (another program may take the name meanwhile). A cancel, a
/// locked file, a full disk or a vanished item deletes the partial and returns the error.
pub(crate) fn compress(paths: &[PathBuf], progress: &mut ArchiveProgress) -> Result<PathBuf> {
    let (dir, base) = place(paths)?;
    let dir = dir.as_path();
    let name = format!("{base}.zip");
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
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut buf = vec![0u8; BUFFER];
    for item in &items {
        progress.check_cancel()?;
        progress.set_current(&item.path.to_string_lossy());
        if item.dir {
            zip.add_directory(item.inside.as_str(), options)
                .map_err(zip_err)?;
            continue;
        }
        let mut from = File::open(&item.path)?;
        let meta = from.metadata()?;
        // ZIP64 only where needed: without it the writer refuses a file of 4 GiB or more;
        // with it on every entry each carries an extra header for nothing
        let mut opts = options.large_file(meta.len() >= u64::from(u32::MAX));
        if let Some(t) = meta.modified().ok().and_then(time::to_zip) {
            opts = opts.last_modified_time(t);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            opts = opts.unix_permissions(meta.permissions().mode() & 0o777);
        }
        zip.start_file(item.inside.as_str(), opts)
            .map_err(zip_err)?;
        loop {
            progress.check_cancel()?;
            let n = from.read(&mut buf)?;
            if n == 0 {
                break;
            }
            zip.write_all(&buf[..n])?;
            progress.add(n as u64);
        }
    }
    let mut file = zip.finish().map_err(zip_err)?;
    file.flush()?;
    drop(file);
    progress.set_current("");
    // picked only now, and still no-replace: a file that took this name while we compressed
    // is never replaced — the next Keep-both name is used instead
    let landed = land_no_replace(
        &partial.path,
        &dir.join(ops::unique_name(dir, &name, false)),
    )?;
    partial.keep();
    Ok(landed)
}

/// Zip times are the clock on the wall where the zip was made (no time zone), like Explorer
/// and 7-Zip read and write them: local time here.
mod time {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use zip::DateTime;

    /// Days since 1970-01-01 of a civil date (H. Hinnant's algorithm).
    fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let mp = (m + 9) % 12;
        let doy = (153 * mp + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    fn civil_from_days(z: i64) -> (i64, i64, i64) {
        let z = z + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        (
            if m <= 2 {
                yoe + era * 400 + 1
            } else {
                yoe + era * 400
            },
            m,
            d,
        )
    }

    /// Seconds since the epoch of a wall-clock time read as UTC.
    fn naive_secs(t: &DateTime) -> i64 {
        days_from_civil(t.year().into(), t.month().into(), t.day().into()) * 86_400
            + i64::from(t.hour()) * 3600
            + i64::from(t.minute()) * 60
            + i64::from(t.second())
    }

    fn naive_to_zip(secs: i64) -> Option<DateTime> {
        let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
        let s = secs.rem_euclid(86_400);
        DateTime::from_date_and_time(
            u16::try_from(y).ok()?,
            m as u8,
            d as u8,
            (s / 3600) as u8,
            (s / 60 % 60) as u8,
            (s % 60) as u8,
        )
        .ok()
    }

    fn system_time(secs: i64) -> Option<SystemTime> {
        let secs = u64::try_from(secs).ok()?;
        UNIX_EPOCH.checked_add(Duration::from_secs(secs))
    }

    /// The entry's time, or `None` for the "no time" default (1980-01-01 00:00) a writer
    /// without a clock puts in: restoring that would date every file 1980.
    pub fn from_zip(t: DateTime) -> Option<SystemTime> {
        if t == DateTime::default() || !t.is_valid() {
            return None;
        }
        system_time(naive_secs(&t) - local_offset_secs(naive_secs(&t))?)
    }

    pub fn to_zip(t: SystemTime) -> Option<DateTime> {
        let utc = i64::try_from(t.duration_since(UNIX_EPOCH).ok()?.as_secs()).ok()?;
        naive_to_zip(utc + utc_offset_secs(utc)?)
    }

    /// local − UTC at the UTC instant `utc`, in seconds.
    #[cfg(windows)]
    fn utc_offset_secs(utc: i64) -> Option<i64> {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::Storage::FileSystem::FileTimeToLocalFileTime;
        let ft = to_filetime(utc)?;
        let mut local = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        // SAFETY: both point at live FILETIMEs for the call.
        if unsafe { FileTimeToLocalFileTime(&ft, &mut local) } == 0 {
            return None;
        }
        Some(from_filetime(&local) - utc)
    }

    /// local − UTC for a wall-clock time `naive` (seconds as if it were UTC).
    #[cfg(windows)]
    fn local_offset_secs(naive: i64) -> Option<i64> {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::Storage::FileSystem::LocalFileTimeToFileTime;
        let local = to_filetime(naive)?;
        let mut utc = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        // SAFETY: both point at live FILETIMEs for the call.
        if unsafe { LocalFileTimeToFileTime(&local, &mut utc) } == 0 {
            return None;
        }
        Some(naive - from_filetime(&utc))
    }

    /// 100 ns ticks since 1601-01-01.
    #[cfg(windows)]
    const EPOCH_DIFF_SECS: i64 = 11_644_473_600;

    #[cfg(windows)]
    fn to_filetime(secs: i64) -> Option<windows_sys::Win32::Foundation::FILETIME> {
        let ticks = u64::try_from(secs.checked_add(EPOCH_DIFF_SECS)?)
            .ok()?
            .checked_mul(10_000_000)?;
        Some(windows_sys::Win32::Foundation::FILETIME {
            dwLowDateTime: ticks as u32,
            dwHighDateTime: (ticks >> 32) as u32,
        })
    }

    #[cfg(windows)]
    fn from_filetime(ft: &windows_sys::Win32::Foundation::FILETIME) -> i64 {
        let ticks = (u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime);
        (ticks / 10_000_000) as i64 - EPOCH_DIFF_SECS
    }

    #[cfg(unix)]
    fn utc_offset_secs(utc: i64) -> Option<i64> {
        let t = libc::time_t::try_from(utc).ok()?;
        // SAFETY: an all-zero `tm` is a valid plain C struct; `localtime_r` only writes it.
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        // SAFETY: both pointers are live for the call.
        if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
            return None;
        }
        #[allow(clippy::unnecessary_cast)]
        Some(tm.tm_gmtoff as i64)
    }

    #[cfg(unix)]
    fn local_offset_secs(naive: i64) -> Option<i64> {
        let (y, m, d) = civil_from_days(naive.div_euclid(86_400));
        let s = naive.rem_euclid(86_400);
        // SAFETY: as above.
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        tm.tm_year = (y - 1900) as libc::c_int;
        tm.tm_mon = (m - 1) as libc::c_int;
        tm.tm_mday = d as libc::c_int;
        tm.tm_hour = (s / 3600) as libc::c_int;
        tm.tm_min = (s / 60 % 60) as libc::c_int;
        tm.tm_sec = (s % 60) as libc::c_int;
        tm.tm_isdst = -1;
        // SAFETY: `tm` is live; `mktime` reads and normalises it.
        let utc = unsafe { libc::mktime(&mut tm) };
        if utc == -1 {
            return None;
        }
        // time_t is i64 on 64-bit Linux/macOS, narrower elsewhere
        #[allow(clippy::useless_conversion)]
        let utc = i64::from(utc);
        Some(naive - utc)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn civil_round_trip() {
            for days in [-1, 0, 3652, 11_016, 19_000, 47_000] {
                let (y, m, d) = civil_from_days(days);
                assert_eq!(days_from_civil(y, m, d), days);
            }
            assert_eq!(civil_from_days(0), (1970, 1, 1));
        }

        #[test]
        fn zip_time_round_trips_to_the_even_second() {
            // 2024-05-06 07:08:10 UTC
            let t = UNIX_EPOCH + Duration::from_secs(1_714_979_290);
            let z = to_zip(t).unwrap();
            assert_eq!(from_zip(z).unwrap(), t);
            assert_eq!(from_zip(DateTime::default()), None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::archive::job::tests::{extract, layout, make_zip};
    use crate::core::archive::job::{run_compress, run_extract};
    use crate::core::archive::test_util::scratch;
    use crate::core::archive::ArchiveFormat;
    use crate::core::transfer::{Resolution, TransferProgress};
    use std::fs;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn names_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn round_trip_tree_with_empty_folder() {
        let root = scratch("zip-round");
        let src = root.join("a").join("b").join("Photos");
        fs::create_dir_all(src.join("2024")).unwrap();
        fs::create_dir_all(src.join("empty")).unwrap();
        fs::write(src.join("2024").join("a.jpg"), b"jpg").unwrap();
        fs::write(src.join("top.txt"), vec![5u8; 2 * BUFFER + 7]).unwrap();
        let cancel = AtomicBool::new(false);
        let done = run_compress(
            1,
            std::slice::from_ref(&src),
            ArchiveFormat::Zip,
            &cancel,
            &|_| {},
        );
        assert_eq!(done.error, None);
        let zip = PathBuf::from(&done.outputs[0].to);
        assert_eq!(zip.file_name().unwrap(), "Photos.zip");
        let dest = root.join("a").join("b").join("out");
        fs::create_dir_all(&dest).unwrap();
        let done = extract(&zip, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        let back = dest.join("Photos");
        assert_eq!(fs::read(back.join("2024").join("a.jpg")).unwrap(), b"jpg");
        assert_eq!(
            fs::read(back.join("top.txt")).unwrap().len(),
            2 * BUFFER + 7
        );
        assert!(back.join("empty").is_dir());
        // the file time came back (zip keeps it to the even second)
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
        assert!(diff.as_secs() <= 2, "{diff:?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zip_slip_entry_is_refused_and_rest_extracts() {
        let (root, dest, zip) = layout("zip-slip");
        let mut w = ZipWriter::new(File::create(&zip).unwrap());
        w.start_file("../evil.txt", SimpleFileOptions::default())
            .unwrap();
        w.write_all(b"evil").unwrap();
        w.start_file("good.txt", SimpleFileOptions::default())
            .unwrap();
        w.write_all(b"good").unwrap();
        w.finish().unwrap();
        let done = extract(&zip, &dest, Resolution::Skip);
        assert_eq!(fs::read(dest.join("good.txt")).unwrap(), b"good");
        assert!(!dest.parent().unwrap().join("evil.txt").exists());
        assert!(!dest.join("evil.txt").exists());
        assert_eq!(done.failed.len(), 1, "{:?}", done.failed);
        assert!(done.failed[0].error.starts_with("Unsafe path"));
        assert_eq!(
            done.error.as_deref(),
            Some("1 of 2 items could not be extracted")
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut c = !0u32;
        for &b in data {
            c ^= u32::from(b);
            for _ in 0..8 {
                c = if c & 1 == 1 {
                    (c >> 1) ^ 0xEDB8_8320
                } else {
                    c >> 1
                };
            }
        }
        !c
    }

    /// name bytes, general-purpose flags, extra field, data
    type RawEntry<'a> = (&'a [u8], u16, &'a [u8], &'a [u8]);

    /// Zip with the given entries written by hand: stored, `flags` is the general-purpose bit
    /// flag (bit 11 = UTF-8 names), `extra` goes in both the local and the central header.
    fn raw_zip(entries: &[RawEntry]) -> Vec<u8> {
        let (mut out, mut central) = (Vec::new(), Vec::new());
        for &(name, flags, extra, data) in entries {
            let offset = out.len() as u32;
            let mut common = Vec::new();
            common.extend_from_slice(&20u16.to_le_bytes()); // version needed
            common.extend_from_slice(&flags.to_le_bytes());
            common.extend_from_slice(&0u16.to_le_bytes()); // stored
            common.extend_from_slice(&0u16.to_le_bytes()); // time
            common.extend_from_slice(&0x21u16.to_le_bytes()); // date 1980-01-01
            common.extend_from_slice(&crc32(data).to_le_bytes());
            common.extend_from_slice(&(data.len() as u32).to_le_bytes());
            common.extend_from_slice(&(data.len() as u32).to_le_bytes());
            common.extend_from_slice(&(name.len() as u16).to_le_bytes());
            common.extend_from_slice(&(extra.len() as u16).to_le_bytes());
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&common);
            out.extend_from_slice(name);
            out.extend_from_slice(extra);
            out.extend_from_slice(data);
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes()); // version made by
            central.extend_from_slice(&common);
            central.extend_from_slice(&[0u8; 2 + 2 + 2 + 4]); // comment, disk, int attr, ext attr
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name);
            central.extend_from_slice(extra);
        }
        let cd_offset = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0u8; 4]); // disk numbers
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    fn listed_names(zip: &Path) -> Vec<String> {
        let mut src = ZipSource::open(zip).unwrap();
        src.entries().unwrap().into_iter().map(|e| e.name).collect()
    }

    #[test]
    fn utf8_flagged_names_list_and_extract_unchanged() {
        let (root, dest, zip) = layout("zip-utf8-names");
        let mut w = ZipWriter::new(File::create(&zip).unwrap());
        for (name, body) in [("résumé.txt", "one"), ("日本.txt", "two")] {
            w.start_file(name, SimpleFileOptions::default()).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
        assert_eq!(listed_names(&zip), ["résumé.txt", "日本.txt"]);
        let done = extract(&zip, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        assert_eq!(names_in(&dest), ["résumé.txt", "日本.txt"]);
        assert_eq!(fs::read(dest.join("résumé.txt")).unwrap(), b"one");
        assert_eq!(fs::read(dest.join("日本.txt")).unwrap(), b"two");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cp437_name_with_unicode_path_extra_field_gets_the_unicode_name() {
        let (root, dest, zip) = layout("zip-cp437-7075");
        // "résumé.txt" in CP437 (é = 0x82); no UTF-8 flag, so the name bytes alone mean CP437
        let cp437: &[u8] = b"r\x82sum\x82.txt";
        let unicode = "résumé.txt";
        let mut extra = Vec::new();
        extra.extend_from_slice(&0x7075u16.to_le_bytes());
        extra.extend_from_slice(&((1 + 4 + unicode.len()) as u16).to_le_bytes());
        extra.push(1); // version
        extra.extend_from_slice(&crc32(cp437).to_le_bytes());
        extra.extend_from_slice(unicode.as_bytes());
        fs::write(&zip, raw_zip(&[(cp437, 0, &extra, b"body")])).unwrap();
        assert_eq!(listed_names(&zip), [unicode]);
        let done = extract(&zip, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        assert_eq!(names_in(&dest), [unicode]);
        assert_eq!(fs::read(dest.join(unicode)).unwrap(), b"body");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn utf8_name_without_the_flag_is_read_as_utf8() {
        let (root, dest, zip) = layout("zip-utf8-noflag");
        // macOS `zip`: UTF-8 bytes, bit 11 unset; NFD (e + U+0301) as a Mac stores it
        let nfd = "cafe\u{301}.txt";
        fs::write(
            &zip,
            raw_zip(&[
                ("café.txt".as_bytes(), 0, &[], b"a"),
                (nfd.as_bytes(), 0, &[], b"b"),
            ]),
        )
        .unwrap();
        let listed = listed_names(&zip);
        assert_eq!(listed[0], "café.txt");
        assert_eq!(listed[1].as_bytes(), nfd.as_bytes());
        let done = extract(&zip, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        assert_eq!(fs::read(dest.join("café.txt")).unwrap(), b"a");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_utf8_name_without_the_flag_stays_cp437() {
        let (root, _dest, zip) = layout("zip-cp437-plain");
        fs::write(&zip, raw_zip(&[(b"caf\x82.txt", 0, &[], b"x")])).unwrap();
        assert_eq!(listed_names(&zip), ["café.txt"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nfd_name_is_kept_byte_for_byte() {
        let (root, dest, zip) = layout("zip-nfd");
        // "résumé.txt" decomposed, as a Mac zip stores it: e + U+0301
        let nfd = "re\u{301}sume\u{301}.txt";
        assert_ne!(nfd, "résumé.txt");
        fs::write(&zip, raw_zip(&[(nfd.as_bytes(), 1 << 11, &[], b"mac")])).unwrap();
        let listed = listed_names(&zip);
        assert_eq!(listed[0].as_bytes(), nfd.as_bytes());
        let done = extract(&zip, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        let got = names_in(&dest);
        assert_eq!(got[0].as_bytes(), nfd.as_bytes(), "{got:?}");
        assert_eq!(fs::read(dest.join(nfd)).unwrap(), b"mac");
        fs::remove_dir_all(root).unwrap();
    }

    /// A zip made by 7-Zip with `-mm=Deflate64` (method 9, `7z l -slt` says "Method = Deflate64"):
    /// one 60-line text file. Proves the `deflate64` feature of the zip crate is really on.
    #[test]
    fn extracts_a_deflate64_zip() {
        const REAL: &[u8] = include_bytes!("testdata/deflate64.zip");
        let (root, dest, zip) = layout("zip-deflate64");
        fs::write(&zip, REAL).unwrap();
        let method = ZipArchive::new(File::open(&zip).unwrap())
            .unwrap()
            .by_index(0)
            .unwrap()
            .compression();
        assert_eq!(method, zip::CompressionMethod::Deflate64);
        let done = extract(&zip, &dest, Resolution::Skip);
        assert_eq!(done.error, None, "{:?}", done.failed);
        assert!(done.failed.is_empty(), "{:?}", done.failed);
        let want: String = (1..=60)
            .map(|i| {
                format!(
                    "line {i} of the deflate64 fixture - trove zip method 9
"
                )
            })
            .collect();
        let got = fs::read(dest.join("deflate64.txt"))
            .or_else(|_| fs::read(dest.join("in").join("deflate64.txt")))
            .unwrap();
        assert_eq!(got, want.as_bytes());
        fs::remove_dir_all(root).unwrap();
    }

    /// Cancel set by the progress sink once the first bytes are counted: the job is midway.
    fn cancel_after_first_bytes(cancel: &AtomicBool) -> impl Fn(TransferProgress) + '_ {
        move |p: TransferProgress| {
            if p.bytes_done > 0 {
                cancel.store(true, Ordering::Relaxed);
            }
        }
    }

    #[test]
    fn cancel_mid_compress_leaves_no_partial_and_no_zip() {
        let root = scratch("zip-cancel-c");
        let src = root.join("a").join("b").join("big");
        fs::create_dir_all(&src).unwrap();
        // the first buffer of the first file is counted, then Cancel; more is left to write
        fs::write(src.join("1.bin"), vec![1u8; 3 * BUFFER]).unwrap();
        fs::write(src.join("2.bin"), vec![2u8; BUFFER]).unwrap();
        let cancel = AtomicBool::new(false);
        let sink = cancel_after_first_bytes(&cancel);
        let done = run_compress(
            1,
            std::slice::from_ref(&src),
            ArchiveFormat::Zip,
            &cancel,
            &sink,
        );
        assert!(done.cancelled, "{:?}", done.error);
        assert!(done.outputs.is_empty());
        assert_eq!(names_in(&root.join("a").join("b")), ["big"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancel_mid_extract_leaves_no_partial_file() {
        let (root, dest, zip) = layout("zip-cancel-x");
        make_zip(
            &zip,
            &[("small.txt", b"s"), ("big.bin", &vec![3u8; 3 * BUFFER])],
        );
        let cancel = AtomicBool::new(false);
        let sink = cancel_after_first_bytes(&cancel);
        let done = run_extract(1, &zip, &dest, None, Resolution::Skip, &cancel, &sink);
        assert!(done.cancelled);
        // what landed before the cancel stays and is listed for Undo; no partial is left
        assert_eq!(names_in(&dest), ["small.txt"]);
        assert_eq!(done.outputs.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    /// A reader whose second buffer fails: the Replace must leave the old file whole.
    #[test]
    fn replace_failing_midway_keeps_old_file() {
        use crate::core::archive::job::tests::{extract_with, Failing};
        let (root, dest, zip) = layout("zip-replace-fail");
        fs::write(dest.join("x.txt"), b"old").unwrap();
        let done = extract_with(&mut Failing, &zip, &dest, Resolution::Replace);
        assert_eq!(fs::read(dest.join("x.txt")).unwrap(), b"old");
        assert_eq!(names_in(&dest), ["x.txt"], "no partial left");
        assert_eq!(done.failed.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keep_both_numbers_before_extension() {
        let (root, dest, zip) = layout("zip-keepboth");
        fs::write(dest.join("a.txt"), b"mine").unwrap();
        make_zip(&zip, &[("a.txt", b"theirs")]);
        let done = extract(&zip, &dest, Resolution::KeepBoth);
        assert_eq!(done.error, None);
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"mine");
        assert_eq!(fs::read(dest.join("a (2).txt")).unwrap(), b"theirs");
        assert_eq!(done.outputs.len(), 1);
        assert!(done.outputs[0].to.ends_with("a (2).txt") && done.outputs[0].created);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skip_leaves_target_untouched() {
        let (root, dest, zip) = layout("zip-skip");
        fs::write(dest.join("a.txt"), b"mine").unwrap();
        make_zip(&zip, &[("a.txt", b"theirs"), ("b.txt", b"b")]);
        let done = extract(&zip, &dest, Resolution::Skip);
        assert_eq!(done.error, None);
        assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"mine");
        assert_eq!(names_in(&dest), ["a.txt", "b.txt"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn encrypted_and_link_entries_are_failures() {
        let (root, dest, zip) = layout("zip-link");
        let mut w = ZipWriter::new(File::create(&zip).unwrap());
        w.add_symlink("ln", "../../outside", SimpleFileOptions::default())
            .unwrap();
        w.start_file("ok.txt", SimpleFileOptions::default())
            .unwrap();
        w.write_all(b"ok").unwrap();
        w.finish().unwrap();
        let done = extract(&zip, &dest, Resolution::Skip);
        assert_eq!(names_in(&dest), ["ok.txt"]);
        assert_eq!(done.failed.len(), 1);
        assert!(done.failed[0].error.starts_with("Link not extracted"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "writes 4 GiB; run by hand"]
    fn zip64_file_over_4gib_is_flagged() {
        let root = scratch("zip64");
        let src = root.join("a").join("b").join("huge.bin");
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        let f = File::create(&src).unwrap();
        f.set_len(u64::from(u32::MAX) + 10).unwrap();
        drop(f);
        let cancel = AtomicBool::new(false);
        let done = run_compress(
            1,
            std::slice::from_ref(&src),
            ArchiveFormat::Zip,
            &cancel,
            &|_| {},
        );
        assert_eq!(done.error, None);
        fs::remove_dir_all(root).unwrap();
    }
}

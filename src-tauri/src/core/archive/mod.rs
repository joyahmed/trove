//! Archives inside Trove (plan 16): make, extract and later browse zip, 7z, tar.* and RAR
//! without a second app. ZIP (Phase 1), tar, bare or in gz / xz / zst (Phase 2), and 7z
//! (Phase 3) are read and written; RAR is detected here and refused with a plain
//! "not supported yet".
//!
//! The rules every format follows live in this folder, not in each reader:
//! - `safe_path`: an entry name becomes a path inside the chosen folder or is refused (zip-slip);
//! - `job`: progress, cancel, conflicts, partial-then-rename writes and what Undo may remove;
//! - `rename_no_replace` (below): a final rename that never replaces anything.

pub mod index;
pub mod job;
pub mod safe_path;
pub mod sevenz_fmt;
pub mod tar_fmt;
pub mod zip_fmt;

use std::fs::File;
use std::io::{Error, ErrorKind, Read, Result};
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The compression around a tar stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TarCodec {
    None,
    Gz,
    Xz,
    Zst,
}

/// What an archive file is, read from its first bytes (the name is only a fallback).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Zip,
    SevenZ,
    Tar(TarCodec),
    Rar,
}

/// The formats "Compress to" can make. Mirrors `src/lib/types/archive.ts` `ArchiveFormat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArchiveFormat {
    #[serde(rename = "zip")]
    Zip,
    #[serde(rename = "7z")]
    SevenZ,
    #[serde(rename = "tar.gz")]
    TarGz,
    #[serde(rename = "tar.xz")]
    TarXz,
    #[serde(rename = "tar.zst")]
    TarZst,
}

pub const NOT_AN_ARCHIVE: &str = "Not an archive Trove can open";

impl Format {
    /// Magic bytes first: a zip renamed to `x.7z` is still a zip, and a text file named
    /// `x.zip` is not one. A bare tar has no magic at offset 0, so it falls back to the name.
    pub fn detect(path: &Path) -> Result<Format> {
        let mut head = [0u8; 8];
        let n = read_head(path, &mut head)?;
        let head = &head[..n];
        if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") {
            return Ok(Format::Zip);
        }
        if head.starts_with(b"7z\xBC\xAF\x27\x1C") {
            return Ok(Format::SevenZ);
        }
        if head.starts_with(&[0x1F, 0x8B]) {
            return Ok(Format::Tar(TarCodec::Gz));
        }
        if head.starts_with(&[0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) {
            return Ok(Format::Tar(TarCodec::Xz));
        }
        if head.starts_with(&[0x28, 0xB5, 0x2F, 0xFD]) {
            return Ok(Format::Tar(TarCodec::Zst));
        }
        if head.starts_with(b"Rar!\x1A\x07") {
            return Ok(Format::Rar);
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if name.ends_with(".tar") {
            return Ok(Format::Tar(TarCodec::None));
        }
        Err(Error::new(ErrorKind::InvalidData, NOT_AN_ARCHIVE))
    }

    /// ZIP, 7z and the tar family extract; RAR is known but refused in plain words.
    pub fn ensure_supported(self) -> Result<()> {
        match self {
            Format::Zip | Format::SevenZ | Format::Tar(_) => Ok(()),
            _ => Err(Error::new(
                ErrorKind::Unsupported,
                "This kind of archive is not supported yet",
            )),
        }
    }
}

fn read_head(path: &Path, buf: &mut [u8]) -> Result<usize> {
    let mut file = File::open(path)?;
    let mut filled = 0;
    while filled < buf.len() {
        let n = file.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// The folder name "Extract here" makes for `archive`: its name without the WHOLE archive
/// extension (`x.tar.gz` → `x`, never `x.tar`), trimmed of a trailing dot or space (Windows
/// drops them silently), `Archive` when nothing is left.
pub fn archive_stem(archive: &Path) -> String {
    const COMPOUND: [&str; 3] = [".tar.gz", ".tar.xz", ".tar.zst"];
    let name = archive
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let lower = name.to_lowercase();
    let stem = match COMPOUND.iter().find(|ext| lower.ends_with(*ext)) {
        Some(ext) => &name[..name.len() - ext.len()],
        None => match name.rsplit_once('.') {
            Some((stem, _)) if !stem.is_empty() => stem,
            _ => name.as_str(),
        },
    };
    let trimmed = stem.trim_end_matches([' ', '.']);
    if trimmed.is_empty() || super::ops::validate_name(trimmed).is_err() {
        "Archive".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Rename `from` to `to` only if nothing is at `to`; "already exists" is `ErrorKind::AlreadyExists`.
///
/// ⛔ `fs::rename` replaces an existing target on ALL three OSes (POSIX `rename(2)` too), and
/// between picking a free name and renaming onto it another program can take that name. Every
/// write that is not an explicit Replace goes through here instead.
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> Result<()> {
    imp::rename_no_replace(from, to)
}

#[cfg(windows)]
mod imp {
    use std::io::{Error, Result};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    pub fn rename_no_replace(from: &Path, to: &Path) -> Result<()> {
        let (f, t) = (wide(from), wide(to));
        // SAFETY: both are live NUL-terminated UTF-16 buffers for the whole call. Flags 0 =
        // no MOVEFILE_REPLACE_EXISTING: an existing target fails with ERROR_ALREADY_EXISTS /
        // ERROR_FILE_EXISTS, which std maps to `AlreadyExists`.
        if unsafe { MoveFileExW(f.as_ptr(), t.as_ptr(), 0) } == 0 {
            return Err(Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(unix)]
mod imp {
    use std::ffi::CString;
    use std::io::{Error, ErrorKind, Result};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    fn c(p: &Path) -> Result<CString> {
        CString::new(p.as_os_str().as_bytes()).map_err(|e| Error::new(ErrorKind::InvalidInput, e))
    }

    #[cfg(target_os = "linux")]
    fn native(from: &CString, to: &CString) -> Option<Result<()>> {
        // SAFETY: both are live NUL-terminated strings for the call; AT_FDCWD = relative to cwd
        // (the paths are absolute anyway).
        let r = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if r == 0 {
            return Some(Ok(()));
        }
        let e = Error::last_os_error();
        match e.raw_os_error() {
            // the filesystem (or an old kernel) has no RENAME_NOREPLACE: use the link fallback
            Some(libc::EINVAL) | Some(libc::ENOSYS) | Some(libc::EOPNOTSUPP) => None,
            _ => Some(Err(e)),
        }
    }

    #[cfg(target_os = "macos")]
    fn native(from: &CString, to: &CString) -> Option<Result<()>> {
        // SAFETY: both are live NUL-terminated strings for the call.
        let r = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        if r == 0 {
            return Some(Ok(()));
        }
        let e = Error::last_os_error();
        match e.raw_os_error() {
            Some(libc::ENOTSUP) | Some(libc::EINVAL) => None,
            _ => Some(Err(e)),
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn native(_: &CString, _: &CString) -> Option<Result<()>> {
        None
    }

    pub fn rename_no_replace(from: &Path, to: &Path) -> Result<()> {
        if let Some(done) = native(&c(from)?, &c(to)?) {
            return done;
        }
        // `link` refuses an existing target on every filesystem that has links; then the
        // partial name goes. Files only — no caller renames a folder through here.
        std::fs::hard_link(from, to)?;
        std::fs::remove_file(from)
    }
}

/// Bytes free for this user on the volume holding `dir`; `None` when the OS will not say.
pub(crate) fn free_space(dir: &Path) -> Option<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free = 0u64;
        // SAFETY: `wide` is NUL-terminated and live; the two totals we do not need are null.
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(free)
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
        // SAFETY: an all-zero `statvfs` is a valid plain C struct; the call only writes it.
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: both pointers are live for the call.
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        #[allow(clippy::unnecessary_cast)]
        Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
    }
}

/// The "downloaded from the internet" marker on `archive`: Windows `:Zone.Identifier`, macOS
/// `com.apple.quarantine`. Explorer, 7-Zip and Archive Utility copy it onto every file they
/// extract; dropping it would let a downloaded `.exe` / `.app` run without SmartScreen or
/// Gatekeeper asking. Linux has no such marker.
pub(crate) fn origin_marker(archive: &Path) -> Option<Vec<u8>> {
    #[cfg(windows)]
    {
        let mut ads = archive.as_os_str().to_os_string();
        ads.push(":Zone.Identifier");
        std::fs::read(ads).ok()
    }
    #[cfg(target_os = "macos")]
    {
        mac_xattr::get(archive)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = archive;
        None
    }
}

/// Put the marker read by `origin_marker` on `file`. Best effort: a volume without streams or
/// xattrs (FAT32 stick) cannot carry it, and neither can Explorer's own copy there.
pub(crate) fn apply_origin_marker(file: &Path, marker: &[u8]) {
    #[cfg(windows)]
    {
        let mut ads = file.as_os_str().to_os_string();
        ads.push(":Zone.Identifier");
        let _ = std::fs::write(ads, marker);
    }
    #[cfg(target_os = "macos")]
    {
        mac_xattr::set(file, marker);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (file, marker);
    }
}

#[cfg(target_os = "macos")]
mod mac_xattr {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    const NAME: &[u8] = b"com.apple.quarantine\0";

    pub fn get(path: &Path) -> Option<Vec<u8>> {
        let c = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut buf = vec![0u8; 1024];
        // SAFETY: `c` and NAME are NUL-terminated; `buf` is live for `buf.len()` bytes.
        let n = unsafe {
            libc::getxattr(
                c.as_ptr(),
                NAME.as_ptr().cast(),
                buf.as_mut_ptr().cast(),
                buf.len(),
                0,
                0,
            )
        };
        if n <= 0 {
            return None;
        }
        buf.truncate(n as usize);
        Some(buf)
    }

    pub fn set(path: &Path, value: &[u8]) {
        let Ok(c) = CString::new(path.as_os_str().as_bytes()) else {
            return;
        };
        // SAFETY: as in `get`; `value` is live for its length.
        unsafe {
            libc::setxattr(
                c.as_ptr(),
                NAME.as_ptr().cast(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            );
        }
    }
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::path::PathBuf;

    /// A fresh folder under the temp dir, unique per test and process. Every archive test
    /// extracts at least three levels below it, so a broken `..` rule still lands inside it.
    pub fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trove-archive-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::test_util::scratch;
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn detect_reads_magic_not_extension() {
        let root = scratch("detect");
        let fake7z = root.join("x.7z");
        let mut w = zip::ZipWriter::new(File::create(&fake7z).unwrap());
        w.start_file("a.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(b"a").unwrap();
        w.finish().unwrap();
        assert_eq!(Format::detect(&fake7z).unwrap(), Format::Zip);

        let text = root.join("x.zip");
        fs::write(&text, b"just some words").unwrap();
        let err = Format::detect(&text).unwrap_err();
        assert_eq!(err.to_string(), NOT_AN_ARCHIVE);

        fs::write(root.join("y.gz"), [0x1F, 0x8B, 8, 0]).unwrap();
        assert_eq!(
            Format::detect(&root.join("y.gz")).unwrap(),
            Format::Tar(TarCodec::Gz)
        );
        assert!(Format::Tar(TarCodec::Gz).ensure_supported().is_ok());
        assert!(Format::SevenZ.ensure_supported().is_ok());
        assert!(Format::Rar.ensure_supported().is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stem_drops_the_whole_archive_extension() {
        assert_eq!(archive_stem(Path::new("photos.zip")), "photos");
        assert_eq!(archive_stem(Path::new("x.tar.gz")), "x");
        assert_eq!(archive_stem(Path::new("x.TAR.ZST")), "x");
        assert_eq!(archive_stem(Path::new("x.tgz")), "x");
        assert_eq!(archive_stem(Path::new("notes.txt.gz")), "notes.txt");
        assert_eq!(archive_stem(Path::new("a.b.zip")), "a.b");
        assert_eq!(archive_stem(Path::new("dots. .zip")), "dots");
        assert_eq!(archive_stem(Path::new(".zip")), ".zip");
        assert_eq!(archive_stem(Path::new("...zip")), "Archive");
    }

    #[test]
    fn no_replace_rename_refuses_existing_target() {
        let root = scratch("noreplace");
        let (a, b) = (root.join("a.txt"), root.join("b.txt"));
        fs::write(&a, b"new").unwrap();
        fs::write(&b, b"old").unwrap();
        let err = rename_no_replace(&a, &b).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::AlreadyExists, "{err}");
        assert_eq!(fs::read(&b).unwrap(), b"old");
        assert_eq!(fs::read(&a).unwrap(), b"new");
        let c = root.join("c.txt");
        rename_no_replace(&a, &c).unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read(&c).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn free_space_reads_the_temp_volume() {
        let root = scratch("free");
        assert!(free_space(&root).is_some_and(|n| n > 0));
        fs::remove_dir_all(root).unwrap();
    }
}

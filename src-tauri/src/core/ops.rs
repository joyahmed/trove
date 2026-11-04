//! File operations: rename, new folder, delete to the Recycle Bin. Each returns the path the
//! frontend should select afterwards. Errors are `io::Error`s the command layer turns into
//! one-line messages.

use std::io::{Error, ErrorKind, Result};
use std::path::{Path, PathBuf};

const INVALID_NAME_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// DOS device names Windows refuses as a file name, with or without an extension.
const RESERVED_DEVICE_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// `CON`, `con.txt`, `Com1.tar.gz` — the part before the first dot is what Windows checks.
fn is_reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end();
    RESERVED_DEVICE_NAMES
        .iter()
        .any(|r| r.eq_ignore_ascii_case(stem))
}

/// Explorer's rule for a name typed by the user: not empty, no path separators or reserved
/// characters, no trailing dot or space, not a DOS device name.
pub fn validate_name(name: &str) -> Result<()> {
    let trimmed = name.trim_end_matches([' ', '.']);
    if trimmed.is_empty() {
        return Err(Error::new(ErrorKind::InvalidInput, "A name is required"));
    }
    if let Some(c) = name.chars().find(|c| INVALID_NAME_CHARS.contains(c)) {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            format!("A file name can't contain '{c}'"),
        ));
    }
    // Tab, newline and the rest below 0x20 are refused by NTFS outright; say so here rather
    // than pass on the OS's "The filename, directory name, or volume label syntax is incorrect"
    if name.chars().any(|c| (c as u32) < 0x20) {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "A file name can't contain control characters",
        ));
    }
    if is_reserved_device_name(trimmed) {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "The specified device name is invalid.",
        ));
    }
    // ⛔ Win32 strips a trailing dot or space without a word: `rename` to `notes.` creates
    // `notes`, and the path we hand back (`notes.`) then names nothing. Refused, not trimmed,
    // so what the person typed is either what lands or an error they can see.
    if trimmed.len() != name.len() {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "A file name can't end with a dot or a space",
        ));
    }
    Ok(())
}

/// Rename `from` to `new_name` inside its own directory. Refuses to overwrite.
pub fn rename(from: &Path, new_name: &str) -> Result<PathBuf> {
    validate_name(new_name)?;
    let parent = from
        .parent()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "Cannot rename a drive root"))?;
    let to = parent.join(new_name);
    if to == from {
        return Ok(to);
    }
    if to.exists() && !same_file_case_change(from, &to) {
        return Err(Error::new(
            ErrorKind::AlreadyExists,
            format!("There is already a file or folder named '{new_name}' here"),
        ));
    }
    std::fs::rename(from, &to)?;
    Ok(to)
}

/// `New folder`, then `New folder (2)`, `(3)`… — whatever is free in `dir`.
pub fn unique_child_name(dir: &Path, base: &str) -> String {
    if !taken(&dir.join(base)) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base} ({n})"))
        .find(|name| !taken(&dir.join(name)))
        .expect("an unbounded range always yields")
}

/// Whether anything stands at `path`, a link included whether or not it points anywhere.
///
/// ⛔ (G.2 review 6, 4) Was `exists()`, which follows a link: a broken link said "free", so the
/// same name was picked again and again (all 16 park tries on one name), and a write there
/// would have gone through the link.
fn taken(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Explorer's "Keep both" name for a file or folder landing next to a namesake: a folder
/// counts after its name (`Photos (2)`), a file before its extension (`report (2).txt`).
pub fn unique_name(dir: &Path, name: &str, is_dir: bool) -> String {
    if !taken(&dir.join(name)) {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !is_dir && !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    (2..)
        .map(|n| format!("{stem} ({n}){ext}"))
        .find(|candidate| !taken(&dir.join(candidate)))
        .expect("an unbounded range always yields")
}

/// How the platform's file manager names a copy pasted into the folder its original is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyStyle {
    /// Explorer: `report - Copy.txt`, then `report - Copy (2).txt`
    Windows,
    /// Finder: `report copy.txt`, then `report copy 2.txt`
    Mac,
    /// Nautilus: `report (copy).txt`; its "(another copy)", "(3rd copy)"… are `(copy 2)` here
    Linux,
}

impl CopyStyle {
    /// This machine's.
    pub const HOST: Self = if cfg!(windows) {
        Self::Windows
    } else if cfg!(target_os = "macos") {
        Self::Mac
    } else {
        Self::Linux
    };

    /// The `n`th copy's name (`n` from 1), the counter after the copy word and before the
    /// extension, as the file managers write it.
    fn candidate(self, stem: &str, ext: &str, n: u32) -> String {
        match (self, n) {
            (Self::Windows, 1) => format!("{stem} - Copy{ext}"),
            (Self::Windows, n) => format!("{stem} - Copy ({n}){ext}"),
            (Self::Mac, 1) => format!("{stem} copy{ext}"),
            (Self::Mac, n) => format!("{stem} copy {n}{ext}"),
            (Self::Linux, 1) => format!("{stem} (copy){ext}"),
            (Self::Linux, n) => format!("{stem} (copy {n}){ext}"),
        }
    }
}

/// The name for a duplicate of `name` made in its own folder `dir` — the first free one of the
/// platform's copy names. Always new: the original's own name is never returned. A folder's
/// whole name is its stem; a file's copy word goes before its extension. A Mac app bundle is a
/// folder that keeps its `.app` (Finder: `Safari copy.app`); `Safari.app copy` is not an app.
pub fn copy_name(dir: &Path, name: &str, is_dir: bool, style: CopyStyle) -> String {
    let app_bundle =
        is_dir && style == CopyStyle::Mac && name.to_ascii_lowercase().ends_with(".app");
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if (!is_dir || app_bundle) && !stem.is_empty() => {
            (stem, format!(".{ext}"))
        }
        _ => (name, String::new()),
    };
    (1..)
        .map(|n| style.candidate(stem, &ext, n))
        .find(|candidate| !taken(&dir.join(candidate)))
        .expect("an unbounded range always yields")
}

pub fn create_folder(dir: &Path) -> Result<PathBuf> {
    let path = dir.join(unique_child_name(dir, "New folder"));
    std::fs::create_dir(&path)?;
    Ok(path)
}

/// `New Text Document.txt`, then `New Text Document (2).txt`… — an empty file, never over an
/// existing one. `ext` has no dot; the stem is validated like a typed name.
pub fn create_file(dir: &Path, base_name: &str, ext: &str) -> Result<PathBuf> {
    validate_name(base_name)?;
    let name = if ext.is_empty() {
        base_name.to_string()
    } else {
        format!("{base_name}.{ext}")
    };
    // the stem alone passing is not enough: an `ext` of `txt.` or `t?t` breaks the full name
    validate_name(&name)?;
    let path = dir.join(unique_name(dir, &name, false));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    Ok(path)
}

/// Explorer's "Compress to ZIP file", the plain call: `archive::zip_fmt::compress` with no
/// progress sink and a cancel flag nobody sets. The job-system path (`archive::job::run_compress`)
/// is the same code with a progress row and Cancel.
pub fn zip_entries(paths: &[PathBuf]) -> Result<PathBuf> {
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let mut progress = super::archive::job::ArchiveProgress::new(0, &cancel, &|_| {});
    super::archive::zip_fmt::compress(paths, &mut progress)
}

/// A junction or a directory symlink: a link (`is_symlink`) that Windows files as a folder
/// (`FILE_ATTRIBUTE_DIRECTORY`). `symlink_metadata` calls it neither file nor dir, yet it must
/// be removed with `remove_dir` — `remove_file` on it is "Access is denied" — and copied as a
/// link, never walked: its contents belong to its target.
pub fn is_dir_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
        meta.file_type().is_symlink() && meta.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0
    }
    #[cfg(not(windows))]
    {
        // elsewhere a symlink is one file whatever it points at, and `remove_file` takes it
        let _ = meta;
        false
    }
}

/// A link that leads to a folder, on any platform: a Windows junction or directory symlink, or
/// a unix symlink whose target is a folder. Never to be walked or opened as a file.
pub(crate) fn is_folder_link(path: &Path, meta: &std::fs::Metadata) -> bool {
    is_dir_link(meta) || (meta.file_type().is_symlink() && path.is_dir())
}

/// Remove one entry as what it is: a real folder with everything under it, a folder link as
/// the link alone (its target is untouched), anything else as a file.
///
/// ⛔ On Windows a link is removed by whichever call takes it, never by `remove_dir_all`. A
/// Linux directory symlink seen over a WSL share reports `is_symlink` with no DIRECTORY bit
/// (attributes `0x400`), yet `remove_file` on it fails "path not found"; `remove_dir` takes it.
/// A junction is the other way round. Either way only the link goes, never its target.
pub fn remove_entry(path: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    if cfg!(windows) && meta.file_type().is_symlink() {
        type Remove = fn(&Path) -> Result<()>;
        let (first, second): (Remove, Remove) = if is_dir_link(&meta) {
            (|p| std::fs::remove_dir(p), |p| std::fs::remove_file(p))
        } else {
            (|p| std::fs::remove_file(p), |p| std::fs::remove_dir(p))
        };
        // the first call's error is the one worth showing if nothing takes it
        first(path).or_else(|e| {
            second(path)
                .or_else(|_| delete_link_itself(path))
                .map_err(|_| e)
        })
    } else if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

/// The last resort for a link neither `remove_file` nor `remove_dir` takes: open the link
/// itself (`FILE_FLAG_OPEN_REPARSE_POINT`, never its target) and mark it delete-on-close.
///
/// A Linux directory symlink over the WSL share (reparse tag `IO_REPARSE_TAG_LX_SYMLINK`
/// `0xA000001D`, attributes `0x400`) needs this: probed live 2026-10-07, `DeleteFileW` fails
/// "path not found" and `RemoveDirectoryW` "the directory name is invalid", while this removed
/// the link and left the canary file in its target.
#[cfg(windows)]
fn delete_link_itself(path: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileDispositionInfo, SetFileInformationByHandle, DELETE,
        FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call; no security attributes or template.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(Error::last_os_error());
    }
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: `handle` is open with DELETE access; `info` is the struct the class names, sized.
    let ok = unsafe {
        SetFileInformationByHandle(
            handle,
            FileDispositionInfo,
            std::ptr::from_ref(&info).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    let result = if ok == 0 {
        Err(Error::last_os_error())
    } else {
        Ok(())
    };
    // SAFETY: closed once; the delete happens on this close
    unsafe { CloseHandle(handle) };
    result
}

#[cfg(not(windows))]
fn delete_link_itself(path: &Path) -> Result<()> {
    std::fs::remove_file(path)
}

/// Delete for good, bypassing the Recycle Bin. One failure does not stop the batch: the rest
/// are still deleted (the person asked for all of them), and the error names every path that
/// stayed, so what is gone is gone and what is listed is still there.
pub fn delete_permanently(paths: &[PathBuf]) -> Result<()> {
    let mut failed: Vec<String> = Vec::new();
    let mut kind = ErrorKind::Other;
    for path in paths {
        if let Err(e) = remove_entry(path) {
            kind = e.kind();
            failed.push(format!("{}: {e}", path.display()));
        }
    }
    match failed.len() {
        0 => Ok(()),
        // one failure keeps its own kind, so a caller can still tell NotFound from the rest
        1 => Err(Error::new(kind, failed.remove(0))),
        n => Err(Error::other(format!(
            "{n} items could not be deleted — {}",
            failed.join("; ")
        ))),
    }
}

/// Send to the Recycle Bin. All-or-nothing per the `trash` crate.
///
/// ⛔ Only a local fixed volume has a Recycle Bin. On a network share (`\\server\share`, a mapped
/// drive like `N:`, a WSL share, `\\?\UNC\…`), a USB stick or a RAM disk, `trash 5.2.9`
/// `delete_all` returns Ok and deletes FOR GOOD — verified live 2026-10-07 on
/// `\\wsl.localhost\…` and `\\localhost\C$\…`. "To the bin" would be a lie and the undo it
/// leaves would restore nothing. So every path is checked first and one bin-less path refuses
/// the whole batch, before anything is touched: `ErrorKind::Unsupported` carrying a
/// [`NoRecycleBin`] that names the place. The caller decides — the frontend asks, then deletes
/// permanently with no undo. A place whose kind cannot be told is refused too (`Other`).
///
/// On a Mac the move goes through `trash_mac`: Finder first (keeps Put Back, and can ask for the
/// admin password an app in /Applications needs), the file manager when macOS refuses Trove Apple
/// Events for Finder, and a [`NoRecycleBin`] (`Why::Denied`) when both fail — so the caller asks,
/// never shows the raw AppleScript error. Where each item landed is recorded, for ⌘Z
/// (`restore_from_trash`). Uninstall comes through here too (`LiveLauncher::trash`).
pub fn trash(paths: &[PathBuf]) -> Result<()> {
    check_every_path_has_a_bin(paths, None)?;
    send_to_bin(paths)
}

/// The size a Replace takes the bin to be on a Windows volume whose bin has no `MaxCapacity`
/// value (its size never set in Properties): 1 GiB. Windows' own default is a share of the disk
/// Trove does not compute; a bigger old file is treated as "too big for the bin" — overwritten,
/// with the warning — rather than risk the bin quietly deleting it for good.
pub const REPLACE_BIN_GUESS: u64 = 1024 * 1024 * 1024;

/// `trash` for the old file a Replace writes over (`transfer::TrashBin`): the same checks, but
/// a volume with no bin size set takes nothing above [`REPLACE_BIN_GUESS`].
pub fn trash_replaced(paths: &[PathBuf]) -> Result<()> {
    check_every_path_has_a_bin(paths, Some(REPLACE_BIN_GUESS))?;
    send_to_bin(paths)
}

fn send_to_bin(paths: &[PathBuf]) -> Result<()> {
    #[cfg(target_os = "macos")]
    return super::trash_mac::trash_with(paths, &super::trash_mac::LEDGER, super::trash_mac::run);
    #[cfg(not(target_os = "macos"))]
    bin_then_check(paths, |p| trash::delete_all(p))
}

/// Move `paths` with `delete`, then believe it only if every path is really gone from its folder.
/// Seen live 2026-10-23 on Windows: after a program let go of a held file, Delete's Retry cleared
/// the selection with no error twice (only an Ok does that, `actions.svelte.ts` `#binned`) while
/// the file stayed and the bin got nothing. Not reproduced outside the app (probe: 0 of 18), so
/// the cause inside the shell is unknown; whatever it is, Ok with the file still there is now an
/// error that names the file, not a silent success. Items that did go stay in the bin.
#[cfg(not(target_os = "macos"))]
fn bin_then_check(
    paths: &[PathBuf],
    delete: impl FnOnce(&[PathBuf]) -> std::result::Result<(), trash::Error>,
) -> Result<()> {
    delete(paths).map_err(|e| Error::other(crate::core::os_limited::describe(&e)))?;
    // `symlink_metadata`: a link is the item itself, so a link whose target is gone still counts
    let stayed: Vec<String> = paths
        .iter()
        .filter(|p| std::fs::symlink_metadata(p).is_ok())
        .map(|p| p.display().to_string())
        .collect();
    match stayed.len() {
        0 => Ok(()),
        1 => Err(Error::other(format!(
            "{} did not go to the Recycle Bin — it is still in its folder. Try again.",
            stayed[0]
        ))),
        n => Err(Error::other(format!(
            "{n} items did not go to the Recycle Bin — they are still in their folder: {}. Try again.",
            stayed.join("; ")
        ))),
    }
}

/// Why `trash` refused a batch: `place` has no Recycle Bin. `place` is `WSL`, a drive (`N:`),
/// or a share (`\\server\share`). Find it on an error with [`no_recycle_bin`].
#[derive(Debug)]
pub struct NoRecycleBin {
    pub place: String,
    pub path: PathBuf,
    pub why: Why,
    /// every path in the batch that cannot go to a bin (`path` is the first); the rest of the
    /// batch can, so the caller may send those alone and ask about these
    pub paths: Vec<PathBuf>,
}

/// Why a place takes nothing to the Recycle Bin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    /// the place has none: a share, a mapped drive, WSL, a USB stick, a RAM disk
    NoBin,
    /// the person (or a policy) turned the bin off: "Don't move files to the Recycle Bin"
    // only the Windows bin check builds these two; Mac and Linux still match on them
    #[cfg_attr(not(windows), allow(dead_code))]
    TurnedOff,
    /// the batch is bigger than the bin's "Custom size": Windows would delete it for good
    #[cfg_attr(not(windows), allow(dead_code))]
    TooBig,
    /// macOS refused the Trash to Trove: Finder's Apple Events are denied (-1743) and the file
    /// manager's move failed too (`trash_mac`)
    #[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
    Denied,
}

impl std::fmt::Display for NoRecycleBin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let path = self.path.display();
        let place = &self.place;
        match self.why {
            Why::TurnedOff => {
                return write!(
                    f,
                    "The Recycle Bin is turned off for {place}, so nothing was deleted: {path}"
                )
            }
            Why::TooBig => {
                return write!(
                    f,
                    "Too big for the Recycle Bin on {place}, so nothing was deleted: {path}"
                )
            }
            Why::Denied => {
                return write!(
                    f,
                    "macOS did not let Trove use the Trash, so nothing more was moved: {path}"
                )
            }
            Why::NoBin => {}
        }
        if self.place == WSL_PLACE {
            write!(
                f,
                "WSL folders have no Recycle Bin, so nothing was deleted: {path}"
            )
        } else {
            write!(
                f,
                "{} has no Recycle Bin, so nothing was deleted: {path}",
                self.place
            )
        }
    }
}

impl std::error::Error for NoRecycleBin {}

/// The place every WSL share is reported as, whichever spelling reached it.
const WSL_PLACE: &str = "WSL";

/// The place (`WSL`, `N:`, `\\server\share`) that would refuse `paths` the bin, judged the way
/// `trash` judges them but touching nothing — for the conflict dialog to warn before a Replace
/// that the old files cannot come back. `None` when every path has a bin, or when the place
/// cannot be told (the Replace then finds out, and the frontend says so afterwards).
pub fn bin_refusal(paths: &[PathBuf]) -> Option<String> {
    let e = check_every_path_has_a_bin(paths, Some(REPLACE_BIN_GUESS)).err()?;
    no_recycle_bin(&e).map(|n| n.place.clone())
}

/// The [`NoRecycleBin`] inside a `trash` error, if that is why it failed.
pub fn no_recycle_bin(e: &Error) -> Option<&NoRecycleBin> {
    e.get_ref()?.downcast_ref::<NoRecycleBin>()
}

/// Every path is judged before anything is touched. A place that cannot be told refuses the
/// batch (`Other`); otherwise the paths with no bin (each WSL path, each path on a share, a
/// turned-off or too-small bin…) refuse it as one [`NoRecycleBin`] that lists them all.
/// `unset_cap`: the size taken for a Windows bin with none set (`None`: no size check).
fn check_every_path_has_a_bin(paths: &[PathBuf], unset_cap: Option<u64>) -> Result<()> {
    #[cfg(windows)]
    let mut judged = {
        let others: Vec<PathBuf> = paths.iter().filter(|p| !is_wsl_share(p)).cloned().collect();
        bin_check::check(&others, unset_cap)?.into_iter()
    };
    #[cfg(not(windows))]
    let _ = unset_cap;
    // Mac and Linux: a path on a network share (smbfs, nfs, cifs, sshfs…) has no usable bin
    #[cfg(not(windows))]
    let mounts = super::mounts::mount_table();
    let mut stuck: Vec<(PathBuf, String, Why)> = Vec::new();
    for path in paths {
        if is_wsl_share(path) {
            stuck.push((path.clone(), WSL_PLACE.to_string(), Why::NoBin));
            continue;
        }
        #[cfg(not(windows))]
        if let Some(place) = super::mounts::network_share_of(path, &mounts) {
            stuck.push((path.clone(), place, Why::NoBin));
            continue;
        }
        #[cfg(windows)]
        if let Some(Some((place, why))) = judged.next() {
            stuck.push((path.clone(), place, why));
        }
    }
    let Some((path, place, why)) = stuck.first().cloned() else {
        return Ok(());
    };
    Err(Error::new(
        ErrorKind::Unsupported,
        NoRecycleBin {
            place,
            path,
            why,
            paths: stuck.into_iter().map(|(p, ..)| p).collect(),
        },
    ))
}

/// A path on a WSL share: either share name, any case, `\\` or `//`.
fn is_wsl_share(path: &Path) -> bool {
    super::wsl::is_wsl_path(&path.to_string_lossy().replace('/', "\\"))
}

/// Which volume a Windows path is on, and whether that volume has a Recycle Bin.
#[cfg(windows)]
mod bin_check {
    use super::{Error, ErrorKind, Path, PathBuf, Result, Why, WSL_PLACE};
    use crate::core::registry::Hive;
    use std::collections::HashMap;
    use std::path::{Component, Prefix};

    // GetDriveTypeW's answers (WinBase.h)
    pub(super) const DRIVE_REMOVABLE: u32 = 2;
    pub(super) const DRIVE_FIXED: u32 = 3;
    pub(super) const DRIVE_REMOTE: u32 = 4;
    pub(super) const DRIVE_CDROM: u32 = 5;
    pub(super) const DRIVE_RAMDISK: u32 = 6;

    #[derive(Debug, PartialEq, Eq, Clone)]
    pub(super) enum Verdict {
        HasBin,
        /// the place, as the person would name it
        NoBin(String),
        /// a volume Windows cannot classify (`DRIVE_UNKNOWN`, `DRIVE_NO_ROOT_DIR`, `\\?\GLOBALROOT`…)
        Unknown(String),
        /// a fixed disk whose bin is turned off (its own setting, or a policy)
        Off(String),
        /// a fixed disk whose bin is too small for what is being deleted
        TooBig(String),
    }

    /// Every path's folder is placed once, then every volume's bin settings are read once,
    /// before anything is deleted. Per path, in order: `None` when it can go to a bin, else its
    /// place and why not. Any place that cannot be told refuses the whole batch.
    pub(super) fn check(
        paths: &[PathBuf],
        unset_cap: Option<u64>,
    ) -> Result<Vec<Option<(String, Why)>>> {
        verdicts_capped(paths, &Live, unset_cap)
            .into_iter()
            .map(|(path, verdict)| match verdict {
                Verdict::HasBin => Ok(None),
                Verdict::NoBin(place) => Ok(Some((place, Why::NoBin))),
                Verdict::Off(place) => Ok(Some((place, Why::TurnedOff))),
                Verdict::TooBig(place) => Ok(Some((place, Why::TooBig))),
                Verdict::Unknown(place) => Err(Error::other(format!(
                    "Trove cannot tell whether {place} has a Recycle Bin, so nothing was deleted: {}",
                    path.display()
                ))),
            })
            .collect()
    }

    /// Each path with its verdict, in order. A path on a fixed disk is then judged by that
    /// volume's bin settings ([`settings`]), with every path bound for that volume counted
    /// against its size.
    #[cfg(test)]
    pub(super) fn verdicts(paths: &[PathBuf], sys: &dyn System) -> Vec<(PathBuf, Verdict)> {
        verdicts_capped(paths, sys, None)
    }

    /// `verdicts`, with the size a bin that has none set is taken to be (`unset_cap`).
    pub(super) fn verdicts_capped(
        paths: &[PathBuf],
        sys: &dyn System,
        unset_cap: Option<u64>,
    ) -> Vec<(PathBuf, Verdict)> {
        type Located = std::result::Result<(String, String), Verdict>;
        let mut seen: HashMap<PathBuf, Located> = HashMap::new();
        let mut placed = Vec::with_capacity(paths.len());
        for path in paths {
            let abs = std::path::absolute(path).unwrap_or_else(|_| path.clone());
            let folder = abs.parent().unwrap_or(&abs).to_path_buf();
            let spot = seen
                .entry(folder)
                .or_insert_with_key(|folder| located(folder, sys))
                .clone();
            placed.push((path.clone(), abs, spot));
        }
        // the paths bound for each volume, in first-seen order
        let mut volumes: Vec<(String, String, Vec<PathBuf>)> = Vec::new();
        for (_, abs, spot) in &placed {
            if let Ok((root, place)) = spot {
                match volumes.iter_mut().find(|(r, _, _)| r == root) {
                    Some((_, _, list)) => list.push(abs.clone()),
                    None => volumes.push((root.clone(), place.clone(), vec![abs.clone()])),
                }
            }
        }
        let judged: HashMap<String, Verdict> = volumes
            .into_iter()
            .map(|(root, place, list)| {
                let v = settings(&root, place, &list, sys, unset_cap);
                (root, v)
            })
            .collect();
        placed
            .into_iter()
            .map(|(path, _, spot)| {
                let v = match spot {
                    Ok((root, _)) => judged[&root].clone(),
                    Err(v) => v,
                };
                (path, v)
            })
            .collect()
    }

    pub(super) const POLICY: &str = r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer";
    pub(super) const BIT_BUCKET: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume";
    const MIB: u64 = 1024 * 1024;

    /// A fixed disk's own bin settings, as Explorer keeps them: the `NoRecycleFiles` policy
    /// (either hive) turns every bin off; per volume (by its GUID), `NukeOnDelete` turns it off
    /// and `MaxCapacity` (MB) is its size. A read that fails, or a volume with no GUID, is
    /// unknown. ⚠ No `MaxCapacity` value (never set in the Properties dialog) skips the size
    /// check: Windows' default size is a share of the disk Trove does not compute. A Replace
    /// passes `unset_cap` (`REPLACE_BIN_GUESS`) to be judged against that size instead.
    pub(super) fn settings(
        root: &str,
        place: String,
        paths: &[PathBuf],
        sys: &dyn System,
        unset_cap: Option<u64>,
    ) -> Verdict {
        for hive in [Hive::CurrentUser, Hive::LocalMachine] {
            match sys.dword(hive, POLICY, "NoRecycleFiles") {
                Ok(Some(v)) if v != 0 => return Verdict::Off(place),
                Ok(_) => {}
                Err(_) => return Verdict::Unknown(place),
            }
        }
        let Some(guid) = sys.volume_guid(root) else {
            return Verdict::Unknown(place);
        };
        let key = format!(r"{BIT_BUCKET}\{guid}");
        match sys.dword(Hive::CurrentUser, &key, "NukeOnDelete") {
            Ok(Some(v)) if v != 0 => return Verdict::Off(place),
            Ok(_) => {}
            Err(_) => return Verdict::Unknown(place),
        }
        let cap = match sys.dword(Hive::CurrentUser, &key, "MaxCapacity") {
            Ok(Some(mb)) => u64::from(mb) * MIB,
            Ok(None) => match unset_cap {
                Some(cap) => cap,
                None => return Verdict::HasBin,
            },
            Err(_) => return Verdict::Unknown(place),
        };
        let mut total = 0u64;
        for path in paths {
            total = total.saturating_add(sys.size_up_to(path, cap - total));
            if total > cap {
                return Verdict::TooBig(place);
            }
        }
        Verdict::HasBin
    }

    /// `\\?\Volume{guid}\` → `{guid}`, the name Explorer files a volume's bin settings under.
    pub(super) fn guid_of(volume_name: &str) -> Option<String> {
        let start = volume_name.find('{')?;
        let end = start + volume_name[start..].find('}')?;
        Some(volume_name[start..=end].to_string())
    }

    /// The bytes under `path` (itself if a file), counted until they pass `budget`. Folder links
    /// are not entered (the bin moves the link, not what it points at); unreadable entries count
    /// as nothing.
    pub(super) fn walk_size(path: &Path, budget: u64) -> u64 {
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            return 0;
        };
        if !meta.is_dir() || super::is_dir_link(&meta) {
            return meta.len();
        }
        let mut total = 0u64;
        let mut stack = vec![path.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                    continue;
                };
                if meta.is_dir() {
                    if !super::is_dir_link(&meta) {
                        stack.push(entry.path());
                    }
                } else {
                    total = total.saturating_add(meta.len());
                    if total > budget {
                        return total;
                    }
                }
            }
        }
        total
    }

    /// What the bin check asks Windows. A seam: a mapped drive, a USB stick mounted into a
    /// folder or a path Windows cannot resolve cannot be made in a test, so tests pass a fake.
    pub(super) trait System {
        /// `GetDriveTypeW` on a volume root (`C:\`, `\\?\Volume{…}\`)
        fn drive_type(&self, root: &str) -> u32;
        /// where the folder really is (`std::fs::canonicalize` = `GetFinalPathNameByHandleW`)
        fn resolve(&self, folder: &Path) -> Result<PathBuf>;
        /// `GetVolumePathNameW`: the root of the volume `path` is on — a drive (`\\?\C:\`),
        /// a folder another volume is mounted into (`\\?\C:\mnt\usb\`) or a GUID path
        fn volume_root(&self, path: &str) -> Option<String>;
        /// `GetVolumeNameForVolumeMountPointW` on a volume root, as its `{guid}`
        fn volume_guid(&self, root: &str) -> Option<String>;
        /// a `REG_DWORD` (`registry::read_dword_in`); `None` when missing
        fn dword(&self, hive: Hive, key: &str, name: &str) -> Result<Option<u32>>;
        /// the bytes under `path`, counted until they pass `budget` ([`walk_size`])
        fn size_up_to(&self, path: &Path, budget: u64) -> u64;
    }

    /// The real machine.
    pub(super) struct Live;

    impl System for Live {
        fn drive_type(&self, root: &str) -> u32 {
            use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call.
            unsafe { GetDriveTypeW(wide.as_ptr()) }
        }

        fn resolve(&self, folder: &Path) -> Result<PathBuf> {
            std::fs::canonicalize(folder)
        }

        fn volume_root(&self, path: &str) -> Option<String> {
            use windows_sys::Win32::Storage::FileSystem::GetVolumePathNameW;
            let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
            // the root is never longer than the path plus a trailing `\`
            let mut buf = vec![0u16; wide.len() + 64];
            // SAFETY: `wide` is NUL-terminated and outlives the call; `buf` holds the
            // `buf.len()` UTF-16 units passed as its length.
            let ok =
                unsafe { GetVolumePathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
            if ok == 0 {
                return None;
            }
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..len]))
        }

        fn volume_guid(&self, root: &str) -> Option<String> {
            use windows_sys::Win32::Storage::FileSystem::GetVolumeNameForVolumeMountPointW;
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            // a volume GUID path is 49 characters plus the NUL
            let mut buf = vec![0u16; 64];
            // SAFETY: `wide` is NUL-terminated and outlives the call; `buf` holds the
            // `buf.len()` UTF-16 units passed as its length.
            let ok = unsafe {
                GetVolumeNameForVolumeMountPointW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32)
            };
            if ok == 0 {
                return None;
            }
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            guid_of(&String::from_utf16_lossy(&buf[..len]))
        }

        fn dword(&self, hive: Hive, key: &str, name: &str) -> Result<Option<u32>> {
            crate::core::registry::read_dword_in(hive, key, name)
        }

        fn size_up_to(&self, path: &Path, budget: u64) -> u64 {
            walk_size(path, budget)
        }
    }

    /// The folder as written, then — if that looks local — where it really is: a junction,
    /// a directory symlink or a `subst` drive can lead from `C:` onto a share. `canonicalize`
    /// follows all three (a `subst` of a local folder comes back as that local folder).
    ///
    /// ⛔ Only a folder that is not there (`NotFound`) keeps the verdict as written: then there
    /// is no link to follow and the trash call names the missing path itself. Any other failure
    /// to resolve (access denied on a link, a share that does not answer, a volume Windows
    /// cannot name) means the real place is unknown — and an unknown place is refused, never
    /// assumed local, or a link on `C:` onto a share would be "trashed" and deleted for good.
    #[cfg(test)]
    pub(super) fn verdict_of(folder: &Path, sys: &dyn System) -> Verdict {
        match located(folder, sys) {
            Ok(_) => Verdict::HasBin,
            Err(v) => v,
        }
    }

    /// Like [`verdict_of`], but a folder on a fixed disk comes back as that volume's root (as
    /// Windows names it) and its place (as a person would), so its bin settings can be read.
    pub(super) fn located(
        folder: &Path,
        sys: &dyn System,
    ) -> std::result::Result<(String, String), Verdict> {
        let written = judged(spot(folder, sys, ByLetter), sys)?;
        match sys.resolve(folder) {
            Ok(real) => judged(spot(&real, sys, Strict), sys),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(written),
            Err(_) => Err(Verdict::Unknown(folder.display().to_string())),
        }
    }

    /// The verdict from the path alone (no link followed), with `sys` standing in for Windows.
    /// A drive letter Windows will not place (a `subst` drive: `GetVolumePathNameW` fails
    /// there, error 87) is judged by its letter, here only — `verdict_of` then follows it to
    /// where it really is and judges that strictly.
    #[cfg(test)]
    pub(super) fn lexical(path: &Path, sys: &dyn System) -> Verdict {
        match judged(spot(path, sys, ByLetter), sys) {
            Ok(_) => Verdict::HasBin,
            Err(v) => v,
        }
    }

    fn judged(spot: Spot, sys: &dyn System) -> std::result::Result<(String, String), Verdict> {
        match spot {
            Spot::Volume { root, place } => match by_type(sys.drive_type(&root), place.clone()) {
                Verdict::HasBin => Ok((root, place)),
                v => Err(v),
            },
            Spot::Not(verdict) => Err(verdict),
        }
    }

    /// What a drive-letter path with no volume root is: judged by its letter (as written, before
    /// links are followed) or unknown (where the path really is).
    #[derive(Clone, Copy, PartialEq, Eq)]
    pub(super) enum Unplaced {
        ByLetter,
        Strict,
    }
    use Unplaced::{ByLetter, Strict};

    /// Where a path sits: on a volume (its root as Windows names it, and the place as a person
    /// would), or somewhere the verdict is already plain (a share, a device Trove cannot read).
    pub(super) enum Spot {
        Volume { root: String, place: String },
        Not(Verdict),
    }

    pub(super) fn spot(path: &Path, sys: &dyn System, unplaced: Unplaced) -> Spot {
        let mut parts = path.components();
        let Some(Component::Prefix(prefix)) = parts.next() else {
            return Spot::Not(Verdict::Unknown(path.display().to_string()));
        };
        match prefix.kind() {
            Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                Spot::Not(Verdict::NoBin(share_place(
                    &server.to_string_lossy(),
                    &share.to_string_lossy(),
                )))
            }
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                on_disk(letter, parts, sys, unplaced)
            }
            // `\\.\UNC\server\share\…` parses as the device `UNC` followed by plain names
            Prefix::DeviceNS(name) if name.eq_ignore_ascii_case("UNC") => {
                let mut names = parts.filter_map(|c| match c {
                    Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
                    _ => None,
                });
                let server = names.next().unwrap_or_default();
                let share = names.next().unwrap_or_default();
                Spot::Not(Verdict::NoBin(share_place(&server, &share)))
            }
            // `\\.\C:\…`
            Prefix::DeviceNS(name) => match name.to_str().map(str::as_bytes) {
                Some([letter, b':']) if letter.is_ascii_alphabetic() => {
                    on_disk(*letter, parts, sys, unplaced)
                }
                _ => Spot::Not(Verdict::Unknown(path.display().to_string())),
            },
            // `\\?\Volume{guid}\…`: a volume can be mounted inside another one here too
            Prefix::Verbatim(name) if name.to_string_lossy().starts_with("Volume{") => {
                match sys.volume_root(&path.to_string_lossy()) {
                    Some(root) => Spot::Volume {
                        place: place_of(&root),
                        root,
                    },
                    None => Spot::Not(Verdict::Unknown(path.display().to_string())),
                }
            }
            Prefix::Verbatim(_) => Spot::Not(Verdict::Unknown(path.display().to_string())),
        }
    }

    /// A path on a drive letter. ⛔ Not simply `X:\`: a USB stick or a RAM disk can be mounted
    /// into a folder (`C:\mnt\usb`), and below that folder it is that volume, not C:, that
    /// decides. `GetVolumePathNameW` names the volume a path is really on; it is asked in the
    /// `\\?\` spelling, so a long path is no reason to fail. A path it cannot place is unknown.
    fn on_disk(
        letter: u8,
        rest: std::path::Components,
        sys: &dyn System,
        unplaced: Unplaced,
    ) -> Spot {
        let letter = letter.to_ascii_uppercase() as char;
        let rest: PathBuf = rest.collect();
        let asked = format!(r"\\?\{letter}:{}", rest.display());
        match sys.volume_root(&asked) {
            Some(root) => {
                let root = dos_form(&root);
                Spot::Volume {
                    place: place_of(&root),
                    root,
                }
            }
            None if unplaced == ByLetter => Spot::Volume {
                root: format!(r"{letter}:\"),
                place: format!("{letter}:"),
            },
            None => Spot::Not(Verdict::Unknown(format!("{letter}:"))),
        }
    }

    /// `\\?\C:\mnt\usb\` → `C:\mnt\usb\`: GetDriveTypeW and a person both read the DOS form.
    fn dos_form(root: &str) -> String {
        match root.strip_prefix(r"\\?\") {
            Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
            _ => root.to_string(),
        }
    }

    /// `C:\` → `C:`, `C:\mnt\usb\` → `C:\mnt\usb`, a volume GUID path stays as it is.
    fn place_of(root: &str) -> String {
        if root.starts_with(r"\\?\Volume{") {
            root.to_string()
        } else {
            root.trim_end_matches('\\').to_string()
        }
    }

    /// Only a fixed disk keeps a Recycle Bin. A USB stick (removable), a network drive, a CD
    /// and a RAM disk do not: Windows deletes there for good.
    fn by_type(kind: u32, place: String) -> Verdict {
        match kind {
            DRIVE_FIXED => Verdict::HasBin,
            DRIVE_REMOVABLE | DRIVE_REMOTE | DRIVE_CDROM | DRIVE_RAMDISK => Verdict::NoBin(place),
            // DRIVE_UNKNOWN (0), DRIVE_NO_ROOT_DIR (1), anything newer
            _ => Verdict::Unknown(place),
        }
    }

    fn share_place(server: &str, share: &str) -> String {
        if server.eq_ignore_ascii_case("wsl.localhost") || server.eq_ignore_ascii_case("wsl$") {
            WSL_PLACE.to_string()
        } else {
            format!(r"\\{server}\{share}")
        }
    }
}

/// On a case-insensitive filesystem `Readme` → `README` targets "itself"; allow it, so
/// `rename` does not mistake the file for its own obstacle. On a case-sensitive one `README`
/// is *another* file, and saying "same file" there would walk `rename` straight past its
/// overwrite guard and destroy it — so the host decides, like `watch::key_of` does.
fn same_file_case_change(from: &Path, to: &Path) -> bool {
    same_file_case_change_on(from, to, host_is_case_insensitive(from, to))
}

/// Windows is case-insensitive by default, so it is taken as read. Everywhere else the answer
/// is PROBED, never assumed from the OS name: `to` is the same directory entry as `from` exactly
/// when both names resolve to one inode on one device. That is true on a default macOS (APFS)
/// volume, and false on Linux ext4 and on a case-sensitive APFS volume — where `README` beside
/// `readme` is a second file that the overwrite guard must still protect.
///
/// ⛔ Found 2026-10-02 by a `cargo test` on a Mac: `cfg!(windows)` alone made `readme` → `README`
/// a refused collision on APFS, so a case-only rename failed there. The tempting fix,
/// `cfg!(windows) || cfg!(target_os = "macos")`, trades that for silent data loss on a
/// case-sensitive Mac volume; the probe cannot make that trade. (Two hard links to one inode also
/// pass the probe, and renaming one over the other is a no-op that destroys nothing.)
#[cfg(windows)]
fn host_is_case_insensitive(_from: &Path, _to: &Path) -> bool {
    true
}

#[cfg(unix)]
fn host_is_case_insensitive(from: &Path, to: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(from), std::fs::metadata(to)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

/// `case_insensitive_host` is `host_is_case_insensitive` in production. It is a parameter only because the
/// case-sensitive branch cannot be reached through the real filesystem on Windows, where two
/// case-differing names can never exist side by side for a test to set up.
fn same_file_case_change_on(from: &Path, to: &Path, case_insensitive_host: bool) -> bool {
    allows_case_only_rename(from, case_insensitive_host)
        && from.file_name().zip(to.file_name()).is_some_and(|(a, b)| {
            a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
        })
        && from.parent() == to.parent()
}

/// A WSL share is a case-sensitive Linux filesystem reached from a case-insensitive Windows,
/// so the host's answer is overruled for those paths however we got here.
fn allows_case_only_rename(from: &Path, case_insensitive_host: bool) -> bool {
    case_insensitive_host && !super::wsl::is_wsl_path(&from.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trove-ops-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn names_follow_explorers_rules() {
        assert!(validate_name("notes.txt").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err());
        assert!(validate_name("...").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a:b").is_err());
        assert!(validate_name("what?").is_err());
    }

    /// Windows drops a trailing dot or space without a word, so `rename` to `notes.` would
    /// hand back a path that does not exist. Refused instead, like a control character.
    #[test]
    fn a_trailing_dot_or_space_and_control_characters_are_refused() {
        for bad in ["notes.", "notes ", "notes. .", "a\tb", "a\nb", "\u{1}x"] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
        for ok in [".env", "a.b.c", " leading", "a b"] {
            assert!(validate_name(ok).is_ok(), "{ok:?}");
        }
        let dir = scratch("trailing");
        fs::write(dir.join("a.txt"), b"a").unwrap();
        assert!(rename(&dir.join("a.txt"), "b.").is_err());
        assert!(dir.join("a.txt").exists());
        assert!(create_file(&dir, "x", "txt.").is_err());
        assert!(create_file(&dir, "x ", "").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rename_moves_within_the_folder_and_refuses_to_overwrite() {
        let dir = scratch("rename");
        fs::write(dir.join("a.txt"), b"a").unwrap();
        fs::write(dir.join("b.txt"), b"b").unwrap();

        let to = rename(&dir.join("a.txt"), "c.txt").unwrap();
        assert_eq!(to, dir.join("c.txt"));
        assert!(!dir.join("a.txt").exists());
        assert!(dir.join("c.txt").exists());

        let err = rename(&dir.join("c.txt"), "b.txt").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::AlreadyExists);
        assert_eq!(fs::read(dir.join("b.txt")).unwrap(), b"b");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unique_name_counts_before_a_files_extension() {
        let dir = scratch("unique");
        assert_eq!(unique_name(&dir, "report.txt", false), "report.txt");
        fs::write(dir.join("report.txt"), b"").unwrap();
        assert_eq!(unique_name(&dir, "report.txt", false), "report (2).txt");
        fs::write(dir.join("report (2).txt"), b"").unwrap();
        assert_eq!(unique_name(&dir, "report.txt", false), "report (3).txt");
        fs::create_dir(dir.join("v1.2")).unwrap();
        assert_eq!(unique_name(&dir, "v1.2", true), "v1.2 (2)");
        fs::write(dir.join(".env"), b"").unwrap();
        assert_eq!(unique_name(&dir, ".env", false), ".env (2)");
        fs::remove_dir_all(dir).unwrap();
    }

    /// ⛔ (G.2 review 6, 4) A link that points nowhere took `exists()` for "free": the name was
    /// picked again every time. A broken link holds its name.
    #[test]
    fn a_broken_link_holds_its_name() {
        let dir = scratch("unique-broken-link");
        let link = dir.join("a.txt");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(dir.join("nowhere"), &link);
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(dir.join("nowhere"), &link);
        if let Err(e) = made {
            eprintln!("skipped: this system will not make a symlink here: {e}");
            fs::remove_dir_all(dir).unwrap();
            return;
        }
        assert!(!link.exists(), "the link points nowhere");
        assert_eq!(unique_name(&dir, "a.txt", false), "a (2).txt");
        assert_eq!(unique_child_name(&dir, "a.txt"), "a.txt (2)");
        // a copy name held by a broken link is passed over too
        assert_eq!(copy_name(&dir, "a", false, CopyStyle::Linux), "a (copy)");
        fs::rename(&link, dir.join("a (copy)")).unwrap();
        assert_eq!(copy_name(&dir, "a", false, CopyStyle::Linux), "a (copy 2)");
        fs::remove_dir_all(dir).unwrap();
    }

    /// Explorer's, Finder's and Nautilus's names for a paste into the original's own folder:
    /// each style counts on from the first copy, never returns the original's own name, and
    /// puts the copy word before a file's extension but after a whole folder name.
    #[test]
    fn copy_name_follows_each_platforms_file_manager() {
        for (style, file1, file2, folder1, dotfile, app1) in [
            (
                CopyStyle::Windows,
                "report - Copy.txt",
                "report - Copy (2).txt",
                "v1.2 - Copy",
                ".env - Copy",
                "Safari.app - Copy",
            ),
            (
                CopyStyle::Mac,
                "report copy.txt",
                "report copy 2.txt",
                "v1.2 copy",
                ".env copy",
                "Safari copy.app",
            ),
            (
                CopyStyle::Linux,
                "report (copy).txt",
                "report (copy 2).txt",
                "v1.2 (copy)",
                ".env (copy)",
                "Safari.app (copy)",
            ),
        ] {
            let dir = scratch("copy-name");
            fs::write(dir.join("report.txt"), b"").unwrap();
            assert_eq!(copy_name(&dir, "report.txt", false, style), file1);
            fs::write(dir.join(file1), b"").unwrap();
            assert_eq!(copy_name(&dir, "report.txt", false, style), file2);
            fs::write(dir.join(file2), b"").unwrap();
            let third = copy_name(&dir, "report.txt", false, style);
            assert!(third.contains('3') && third.ends_with(".txt"), "{third}");
            fs::create_dir(dir.join("v1.2")).unwrap();
            assert_eq!(copy_name(&dir, "v1.2", true, style), folder1);
            fs::write(dir.join(".env"), b"").unwrap();
            assert_eq!(copy_name(&dir, ".env", false, style), dotfile);
            fs::create_dir(dir.join("Safari.app")).unwrap();
            assert_eq!(copy_name(&dir, "Safari.app", true, style), app1);
            fs::remove_dir_all(dir).unwrap();
        }
        let host = if cfg!(windows) {
            CopyStyle::Windows
        } else if cfg!(target_os = "macos") {
            CopyStyle::Mac
        } else {
            CopyStyle::Linux
        };
        assert_eq!(CopyStyle::HOST, host);
    }

    #[test]
    fn rename_allows_a_case_only_change() {
        let dir = scratch("case");
        fs::write(dir.join("readme"), b"").unwrap();
        let to = rename(&dir.join("readme"), "README").unwrap();
        assert_eq!(to.file_name().unwrap(), "README");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn case_only_rename_is_not_a_self_rename_on_a_wsl_share() {
        let wsl = Path::new(r"\\wsl.localhost\Ubuntu\home\alex\readme");
        assert!(!allows_case_only_rename(wsl, true));
        assert!(!same_file_case_change_on(
            wsl,
            Path::new(r"\\wsl.localhost\Ubuntu\home\alex\README"),
            true
        ));
        let local = Path::new(r"C:\Users\alex\readme");
        assert!(allows_case_only_rename(local, true));
        assert!(same_file_case_change_on(
            local,
            Path::new(r"C:\Users\alex\README"),
            true
        ));
        // and the wrapper feeds it this host, so Windows keeps the allowance and nothing else does
        assert_eq!(
            same_file_case_change(local, Path::new(r"C:\Users\alex\README")),
            cfg!(windows)
        );
    }

    /// ⛔ Measured on ext4 (Ubuntu, 2026-09-26): in a fresh directory `touch readme; touch README`
    /// leaves **two files**. So on a case-sensitive host `readme` → `README` is a rename *onto a
    /// different file*, and `rename` skips its overwrite guard only for a same-file case change —
    /// calling this one "the same file" would silently destroy the pre-existing `README`.
    ///
    /// The host is a parameter because this branch is unreachable through the real filesystem
    /// here: Windows cannot hold `readme` and `README` in one directory for the test to stage.
    #[test]
    fn a_case_only_rename_hits_the_overwrite_guard_on_a_case_sensitive_host() {
        let from = Path::new("/home/alex/readme");
        let to = Path::new("/home/alex/README");
        // false here is what makes `rename`'s `to.exists() && !same_file_case_change(..)` fire
        assert!(!same_file_case_change_on(from, to, false));
        assert!(!allows_case_only_rename(from, false));
        // …while the same pair on a case-insensitive host is still the one file it always was
        assert!(same_file_case_change_on(from, to, true));
    }

    #[test]
    fn new_folders_are_numbered_like_explorer() {
        let dir = scratch("newfolder");
        assert_eq!(unique_child_name(&dir, "New folder"), "New folder");
        let first = create_folder(&dir).unwrap();
        assert_eq!(first.file_name().unwrap(), "New folder");
        let second = create_folder(&dir).unwrap();
        assert_eq!(second.file_name().unwrap(), "New folder (2)");
        let third = create_folder(&dir).unwrap();
        assert_eq!(third.file_name().unwrap(), "New folder (3)");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn device_names_are_refused_with_or_without_an_extension() {
        for bad in ["CON", "con", "Nul.txt", "COM1", "lpt9.tar.gz", "AUX "] {
            let err = validate_name(bad).unwrap_err();
            assert_eq!(
                err.to_string(),
                "The specified device name is invalid.",
                "{bad}"
            );
        }
        for ok in ["CONsole", "COM10", "lpt", "com1x.txt", "nul-file"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn new_files_are_numbered_before_the_extension_and_empty() {
        let dir = scratch("newfile");
        let first = create_file(&dir, "New Text Document", "txt").unwrap();
        assert_eq!(first.file_name().unwrap(), "New Text Document.txt");
        assert_eq!(fs::metadata(&first).unwrap().len(), 0);
        let second = create_file(&dir, "New Text Document", "txt").unwrap();
        assert_eq!(second.file_name().unwrap(), "New Text Document (2).txt");
        assert!(create_file(&dir, "CON", "txt").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn permanent_delete_removes_files_and_trees_and_names_the_failure() {
        let dir = scratch("permdel");
        let file = dir.join("a.txt");
        let tree = dir.join("tree");
        fs::write(&file, b"x").unwrap();
        fs::create_dir_all(tree.join("inner")).unwrap();
        fs::write(tree.join("inner/b.txt"), b"y").unwrap();
        delete_permanently(&[file.clone(), tree.clone()]).unwrap();
        assert!(!file.exists() && !tree.exists());
        let missing = dir.join("missing.txt");
        let err = delete_permanently(std::slice::from_ref(&missing)).unwrap_err();
        assert!(err.to_string().contains("missing.txt"));
        fs::remove_dir_all(dir).unwrap();
    }

    /// `mklink /J` needs no admin or Developer Mode, unlike a symlink, so the test can make one.
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

    /// A junction reports neither a file nor a folder to `symlink_metadata`; `remove_file` on
    /// it is "Access is denied". It goes with `remove_dir` — and only the link goes.
    #[cfg(windows)]
    #[test]
    fn permanent_delete_removes_a_junction_and_leaves_its_target() {
        let dir = scratch("permdel-junction");
        let real = dir.join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("keep.txt"), b"k").unwrap();
        let link = dir.join("link");
        junction(&link, &real);
        delete_permanently(std::slice::from_ref(&link)).unwrap();
        assert!(fs::symlink_metadata(&link).is_err(), "the junction is gone");
        assert_eq!(fs::read(real.join("keep.txt")).unwrap(), b"k");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn permanent_delete_carries_on_past_a_failure_and_names_every_one() {
        let dir = scratch("permdel-batch");
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        let err = delete_permanently(&[dir.join("gone1"), a.clone(), dir.join("gone2"), b.clone()])
            .unwrap_err();
        assert!(!a.exists() && !b.exists(), "the ones that could go, went");
        let text = err.to_string();
        assert!(text.contains("gone1") && text.contains("gone2"), "{text}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_compress_leaves_no_half_written_archive() {
        let dir = scratch("zip-fail");
        let file = dir.join("report.txt");
        fs::write(&file, b"hello").unwrap();
        assert!(zip_entries(&[file.clone(), dir.join("missing.txt")]).is_err());
        let left: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, vec![std::ffi::OsString::from("report.txt")]);
        fs::remove_dir_all(dir).unwrap();
    }

    /// An unpaired UTF-16 surrogate is a legal NTFS name and not valid UTF-8. It used to turn
    /// into an empty path component, so `Photos/<odd>` went into the archive as `Photos` itself.
    #[cfg(windows)]
    #[test]
    fn a_name_that_is_not_utf8_is_kept_not_dropped() {
        use std::os::windows::ffi::OsStringExt;
        let dir = scratch("zip-lossy");
        let tree = dir.join("Photos");
        fs::create_dir(&tree).unwrap();
        let odd = std::ffi::OsString::from_wide(&[0x61, 0xD800, 0x62]);
        fs::write(tree.join(&odd), b"x").unwrap();
        let zip = zip_entries(std::slice::from_ref(&tree)).unwrap();
        let mut archive = zip::ZipArchive::new(fs::File::open(&zip).unwrap()).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(
            names.contains(&"Photos/a\u{FFFD}b".to_string()),
            "{names:?}"
        );
        drop(archive);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn compress_names_the_archive_after_the_item_and_keeps_the_tree() {
        let dir = scratch("zip");
        let file = dir.join("report.txt");
        let tree = dir.join("Photos");
        fs::write(&file, b"hello").unwrap();
        fs::create_dir_all(tree.join("2024")).unwrap();
        fs::create_dir_all(tree.join("empty")).unwrap();
        fs::write(tree.join("2024/a.jpg"), b"jpg").unwrap();

        let one = zip_entries(std::slice::from_ref(&file)).unwrap();
        assert_eq!(one.file_name().unwrap(), "report.zip");
        let both = zip_entries(&[file.clone(), tree.clone()]).unwrap();
        assert_eq!(both.file_name().unwrap(), "Archive.zip");
        let again = zip_entries(std::slice::from_ref(&file)).unwrap();
        assert_eq!(again.file_name().unwrap(), "report (2).zip");

        let mut archive = zip::ZipArchive::new(fs::File::open(&both).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "Photos/",
                "Photos/2024/",
                "Photos/2024/a.jpg",
                "Photos/empty/",
                "report.txt"
            ]
        );
        let mut text = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("report.txt").unwrap(), &mut text)
            .unwrap();
        assert_eq!(text, "hello");
        fs::remove_dir_all(dir).unwrap();
    }

    /// A junction on Windows, a symlink elsewhere.
    fn link_folder(target: &Path, link: &Path) {
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap()
            .status
            .success());
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    fn zip_names(zip: &Path) -> Vec<String> {
        let mut archive = zip::ZipArchive::new(fs::File::open(zip).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn compress_stores_a_selected_folder_link_as_an_empty_folder_not_its_target() {
        let dir = scratch("zip-toplink");
        let real = dir.join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("secret.txt"), b"x").unwrap();
        let link = dir.join("linked");
        link_folder(&real, &link);

        let zip = zip_entries(std::slice::from_ref(&link)).unwrap();
        assert_eq!(zip_names(&zip), ["linked/"]);
        fs::remove_dir_all(&real).ok();
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn compress_stores_a_folder_link_inside_the_tree_as_an_empty_folder() {
        let dir = scratch("zip-innerlink");
        let real = dir.join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("secret.txt"), b"x").unwrap();
        let tree = dir.join("tree");
        fs::create_dir(&tree).unwrap();
        fs::write(tree.join("a.txt"), b"a").unwrap();
        link_folder(&real, &tree.join("linked"));

        let zip = zip_entries(std::slice::from_ref(&tree)).unwrap();
        assert_eq!(zip_names(&zip), ["tree/", "tree/a.txt", "tree/linked/"]);
        fs::remove_dir_all(&real).ok();
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn trash_refuses_wsl_paths_in_every_spelling() {
        for p in [
            r"\\wsl.localhost\Ubuntu\home\alex\a.txt",
            r"\\WSL.LOCALHOST\Ubuntu\a.txt",
            r"\\wsl$\Ubuntu\a.txt",
            r"\\Wsl$\Debian\tmp",
            "//wsl.localhost/Ubuntu/home/alex/a.txt",
            "//WSL$/Ubuntu/a.txt",
        ] {
            let err = trash(&[PathBuf::from(p)]).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::Unsupported, "{p}");
            assert!(
                err.to_string().contains("WSL folders have no Recycle Bin"),
                "{p}"
            );
        }
    }

    #[test]
    fn a_wsl_path_anywhere_in_the_batch_refuses_all_of_it() {
        let dir = scratch("trash-wsl-mixed");
        let local = dir.join("keep.txt");
        fs::write(&local, b"x").unwrap();
        let err = trash(&[local.clone(), PathBuf::from(r"\\wsl$\Ubuntu\a.txt")]).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Unsupported);
        assert!(
            local.exists(),
            "the Windows file in the batch must be untouched"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ordinary_and_lookalike_paths_are_not_wsl() {
        assert!(!is_wsl_share(Path::new(r"C:\Users\alex\wsl.localhost")));
        assert!(!is_wsl_share(Path::new(r"\\server\wsl.localhost\x")));
        assert!(!is_wsl_share(Path::new("/home/alex/wsl$/x")));
    }

    #[test]
    fn a_wsl_refusal_carries_its_place_for_the_frontend() {
        let err = trash(&[PathBuf::from(r"\\wsl$\Ubuntu\a.txt")]).unwrap_err();
        let why = no_recycle_bin(&err).expect("a no-bin refusal");
        assert_eq!(why.place, "WSL");
        assert!(no_recycle_bin(&Error::other("x")).is_none());
    }

    /// A batch with paths that can go to a bin and paths that cannot names only the stuck
    /// ones, so the caller can send the rest to the bin. Nothing is deleted.
    #[test]
    fn a_mixed_refusal_lists_only_the_paths_with_no_bin() {
        let dir = scratch("trash-mixed");
        let local = dir.join("keep.txt");
        fs::write(&local, b"keep me").unwrap();
        let wsl_a = PathBuf::from(r"\\wsl$\Ubuntu\a.txt");
        let wsl_b = PathBuf::from(r"\\wsl.localhost\Ubuntu\b.txt");
        let err = trash(&[wsl_a.clone(), local.clone(), wsl_b.clone()]).unwrap_err();
        let why = no_recycle_bin(&err).expect("a no-bin refusal");
        assert_eq!(why.paths, [wsl_a.clone(), wsl_b]);
        assert_eq!(why.path, wsl_a);
        assert!(local.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    /// `C:\Users\…\Temp\trove-…` as `\\localhost\C$\Users\…`: a real SMB path to this disk.
    #[cfg(windows)]
    fn via_admin_share(local: &Path, verbatim: bool) -> PathBuf {
        let s = local.to_string_lossy();
        let (drive, rest) = s.split_once(":\\").expect("a drive path");
        let lead = if verbatim { r"\\?\UNC\" } else { r"\\" };
        PathBuf::from(format!(r"{lead}localhost\{drive}$\{rest}"))
    }

    /// The bug, live: `trash 5.2.9` on `\\localhost\C$\…` returned Ok and deleted for good.
    /// Writes only to %TEMP%; the share path is that same file seen over SMB.
    #[cfg(windows)]
    #[test]
    fn trash_refuses_a_network_path_in_every_unc_spelling_and_the_file_stays() {
        let dir = scratch("trash-unc");
        let local = dir.join("x.txt");
        fs::write(&local, b"keep me").unwrap();
        let dotted =
            via_admin_share(&local, false)
                .to_string_lossy()
                .replacen(r"\\", r"\\.\UNC\", 1);
        for p in [
            via_admin_share(&local, false),
            via_admin_share(&local, true),
            PathBuf::from(dotted),
        ] {
            let err = trash(std::slice::from_ref(&p)).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::Unsupported, "{}", p.display());
            let why = no_recycle_bin(&err).expect("names the place");
            let drive = &local.to_string_lossy()[..1];
            assert_eq!(why.place, format!(r"\\localhost\{drive}$"));
            assert!(
                err.to_string()
                    .contains("has no Recycle Bin, so nothing was deleted"),
                "{err}"
            );
            assert!(local.exists(), "{} must not be deleted", p.display());
        }
        // one share path refuses the whole batch: the local file beside it stays too
        let local2 = dir.join("y.txt");
        fs::write(&local2, b"keep me too").unwrap();
        let err = trash(&[local2.clone(), via_admin_share(&local, false)]).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Unsupported);
        assert!(local.exists() && local2.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    /// The bin said yes but the file is still in its folder (seen live 2026-10-23: two Retries
    /// after a held x.docx was let go cleared the selection, and x.docx stayed): that is an error
    /// naming the file, never a silent success.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_bin_that_says_ok_but_leaves_the_file_is_an_error() {
        let dir = scratch("trash-silent-ok");
        let stays = dir.join("x.docx");
        let goes = dir.join("y.txt");
        fs::write(&stays, b"still here").unwrap();
        fs::write(&goes, b"bin me").unwrap();
        let paths = vec![stays.clone(), goes.clone()];
        // a bin that moves only y.txt and still answers Ok
        let err = bin_then_check(&paths, |_| {
            fs::remove_file(&goes).unwrap();
            Ok(())
        })
        .expect_err("a file left in place must not count as binned");
        let text = err.to_string();
        assert!(
            text.contains("x.docx"),
            "names the file that stayed: {text}"
        );
        assert!(
            !text.contains("y.txt"),
            "does not name the one that went: {text}"
        );
        assert!(stays.exists());
        // every path gone: Ok, as before
        fs::write(&goes, b"bin me").unwrap();
        let one = vec![goes.clone()];
        bin_then_check(&one, |p| {
            fs::remove_file(&p[0]).unwrap();
            Ok(())
        })
        .unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    /// Local stays local: a file in %TEMP% on C: goes to the real bin (found there, then purged).
    #[cfg(windows)]
    #[test]
    fn trash_on_a_local_fixed_disk_still_goes_to_the_bin() {
        use crate::core::recycle::{list, purge};
        let dir = scratch("trash-local");
        let name = format!("trove-bin-probe-{}.txt", std::process::id());
        let path = dir.join(&name);
        fs::write(&path, b"bin me").unwrap();
        trash(std::slice::from_ref(&path)).unwrap();
        assert!(!path.exists());
        let ids: Vec<String> = list()
            .unwrap()
            .into_iter()
            .filter(|i| i.name == name)
            .map(|i| i.id)
            .collect();
        assert_eq!(ids.len(), 1, "the file should be in the Recycle Bin once");
        purge(&ids).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    mod bin_places {
        use super::super::bin_check::*;

        const DRIVE_UNKNOWN: u32 = 0;
        const DRIVE_NO_ROOT_DIR: u32 = 1;
        use crate::core::registry::Hive;
        use std::io::{Error, ErrorKind, Result};
        use std::path::{Path, PathBuf};

        /// Windows as a table. GetDriveTypeW: C/S fixed, N/Z/W network, E a USB stick, Q unknown,
        /// V none. `resolve` answers with `resolved`, or as the folder itself when unset.
        #[derive(Default)]
        struct Fake {
            resolved: Option<fn() -> Result<PathBuf>>,
            /// the registry: `(hive, key, value name, data)`; anything missing is `None`
            reg: Vec<(Hive, String, &'static str, u32)>,
            /// every registry read fails
            reg_fails: bool,
            /// a volume Windows gives no GUID
            no_guid: bool,
            /// what every path weighs
            size: u64,
        }

        /// The key Fake files C:'s bin settings under (its GUID is `{c}`).
        fn c_key() -> String {
            format!(r"{BIT_BUCKET}\{{c}}")
        }

        impl System for Fake {
            fn drive_type(&self, root: &str) -> u32 {
                match root {
                    r"C:\mnt\usb\" => return DRIVE_REMOVABLE,
                    r"C:\mnt\ram\" => return DRIVE_RAMDISK,
                    _ => {}
                }
                match root.chars().next() {
                    Some('C' | 'S') => DRIVE_FIXED,
                    Some('N' | 'Z' | 'W') => DRIVE_REMOTE,
                    Some('E') => DRIVE_REMOVABLE,
                    Some('Q') => DRIVE_UNKNOWN,
                    Some('\\') if root.contains("Volume{local}") => DRIVE_FIXED,
                    _ => DRIVE_NO_ROOT_DIR,
                }
            }

            fn resolve(&self, folder: &Path) -> Result<PathBuf> {
                match self.resolved {
                    Some(answer) => answer(),
                    None => Ok(folder.to_path_buf()),
                }
            }

            /// GetVolumePathNameW: a USB stick mounted at `C:\mnt\usb`, a RAM disk at
            /// `C:\mnt\ram`, no root for V: (nothing there) or S: (a subst), every other letter
            /// its own root.
            fn volume_root(&self, path: &str) -> Option<String> {
                if path.contains("Volume{local}") {
                    return Some(r"\\?\Volume{local}\".into());
                }
                let lower = path.to_ascii_lowercase();
                for mount in [r"\\?\c:\mnt\usb", r"\\?\c:\mnt\ram"] {
                    if lower == mount || lower.starts_with(&format!(r"{mount}\")) {
                        return Some(format!(r"\\?\C:{}\", &mount[6..]));
                    }
                }
                let letter = path.strip_prefix(r"\\?\")?.chars().next()?;
                (letter != 'V' && letter != 'S').then(|| format!(r"\\?\{letter}:\"))
            }

            fn volume_guid(&self, root: &str) -> Option<String> {
                let letter = root.chars().next()?.to_ascii_lowercase();
                (!self.no_guid).then(|| format!("{{{letter}}}"))
            }

            fn dword(&self, hive: Hive, key: &str, name: &str) -> Result<Option<u32>> {
                if self.reg_fails {
                    return Err(Error::from(ErrorKind::PermissionDenied));
                }
                Ok(self
                    .reg
                    .iter()
                    .find(|(h, k, n, _)| *h == hive && k == key && *n == name)
                    .map(|(.., v)| *v))
            }

            fn size_up_to(&self, _path: &Path, _budget: u64) -> u64 {
                self.size
            }
        }

        /// A USB stick or a RAM disk mounted into a folder on C: is that volume, not C:.
        #[test]
        fn a_volume_mounted_into_a_folder_on_c_decides_for_itself() {
            let usb = no_bin(r"C:\mnt\usb");
            assert_eq!(verdict(r"C:\mnt\usb\photos\a.jpg"), usb);
            assert_eq!(verdict(r"c:\MNT\USB\a.jpg"), usb);
            assert_eq!(verdict(r"\\?\C:\mnt\usb\a.jpg"), usb);
            assert_eq!(verdict(r"\\.\C:\mnt\usb\a.jpg"), usb);
            assert_eq!(verdict(r"C:\mnt\usb"), usb);
            assert_eq!(verdict(r"C:\mnt\ram\scratch"), no_bin(r"C:\mnt\ram"));
            // beside the mount, and a lookalike name, are still C:
            assert_eq!(verdict(r"C:\mnt\a.txt"), Verdict::HasBin);
            assert_eq!(verdict(r"C:\mnt\usbx\a.txt"), Verdict::HasBin);
            // a link on C: that resolves into the mount is judged where it lands
            let into_usb = Fake {
                resolved: Some(|| Ok(PathBuf::from(r"\\?\C:\mnt\usb\x"))),
                ..Fake::default()
            };
            assert_eq!(verdict_of(Path::new(r"C:\Users\alex\link"), &into_usb), usb);
        }

        /// A `subst` drive has no volume root of its own: as written it is judged by its
        /// letter, and where it really is must be placed, or it is unknown.
        #[test]
        fn a_letter_windows_will_not_place_is_judged_by_its_letter_only_as_written() {
            // S: is a fixed letter with no volume root (a subst); resolved onto C: it keeps the bin
            let onto_c = Fake {
                resolved: Some(|| Ok(PathBuf::from(r"\\?\C:\Users\alex"))),
                ..Fake::default()
            };
            assert_eq!(verdict(r"S:\a"), Verdict::HasBin);
            assert_eq!(verdict_of(Path::new(r"S:\a"), &onto_c), Verdict::HasBin);
            // a folder whose real place Windows will not place is unknown, not judged by letter
            let onto_unplaced = Fake {
                resolved: Some(|| Ok(PathBuf::from(r"\\?\S:\a"))),
                ..Fake::default()
            };
            assert_eq!(
                verdict_of(Path::new(r"C:\x"), &onto_unplaced),
                Verdict::Unknown("S:".into())
            );
        }

        fn verdict(p: &str) -> Verdict {
            lexical(Path::new(p), &Fake::default())
        }

        /// The folder as written is on C:; where it really is cannot be read. Only "it is not
        /// there" keeps C:'s verdict; anything else is a place Trove cannot vouch for.
        #[test]
        fn an_unresolvable_folder_is_unknown_unless_it_is_simply_gone() {
            let folder = Path::new(r"C:\Users\alex\link");
            let gone = Fake {
                resolved: Some(|| Err(Error::from(ErrorKind::NotFound))),
                ..Fake::default()
            };
            assert_eq!(verdict_of(folder, &gone), Verdict::HasBin);
            let failures: [fn() -> Result<PathBuf>; 3] = [
                || Err(Error::from(ErrorKind::PermissionDenied)),
                || Err(Error::other("the share did not answer")),
                || Err(Error::from_raw_os_error(1005)), // ERROR_UNRECOGNIZED_VOLUME
            ];
            for failure in failures {
                let fake = Fake {
                    resolved: Some(failure),
                    ..Fake::default()
                };
                assert_eq!(
                    verdict_of(folder, &fake),
                    Verdict::Unknown(folder.display().to_string()),
                    "{:?}",
                    failure()
                );
            }
            // resolved onto a share: the real place decides
            let to_share = Fake {
                resolved: Some(|| Ok(PathBuf::from(r"\\?\UNC\nas\home\x"))),
                ..Fake::default()
            };
            assert_eq!(verdict_of(folder, &to_share), no_bin(r"\\nas\home"));
        }

        fn no_bin(p: &str) -> Verdict {
            Verdict::NoBin(p.to_string())
        }

        /// What `verdicts` says of `C:\x\a` and `C:\x\b` together.
        fn on_c(sys: &Fake) -> Vec<Verdict> {
            let paths = [PathBuf::from(r"C:\x\a"), PathBuf::from(r"C:\x\b")];
            verdicts(&paths, sys).into_iter().map(|(_, v)| v).collect()
        }

        #[test]
        fn a_bin_left_alone_takes_the_batch() {
            assert_eq!(on_c(&Fake::default()), [Verdict::HasBin, Verdict::HasBin]);
        }

        #[test]
        fn the_no_recycle_files_policy_turns_the_bin_off_in_either_hive() {
            for hive in [Hive::CurrentUser, Hive::LocalMachine] {
                let sys = Fake {
                    reg: vec![(hive, POLICY.into(), "NoRecycleFiles", 1)],
                    ..Fake::default()
                };
                assert_eq!(on_c(&sys)[0], Verdict::Off("C:".into()), "{hive:?}");
            }
            let zero = Fake {
                reg: vec![(Hive::CurrentUser, POLICY.into(), "NoRecycleFiles", 0)],
                ..Fake::default()
            };
            assert_eq!(on_c(&zero)[0], Verdict::HasBin);
        }

        #[test]
        fn nuke_on_delete_turns_that_volume_s_bin_off() {
            let sys = Fake {
                reg: vec![(Hive::CurrentUser, c_key(), "NukeOnDelete", 1)],
                ..Fake::default()
            };
            assert_eq!(
                on_c(&sys),
                [Verdict::Off("C:".into()), Verdict::Off("C:".into())]
            );
        }

        #[test]
        fn a_batch_bigger_than_the_bin_is_too_big_counted_across_the_volume() {
            // 1 MB bin; each path weighs 0.6 MB: one fits, both together do not
            let sys = Fake {
                reg: vec![(Hive::CurrentUser, c_key(), "MaxCapacity", 1)],
                size: 600 * 1024,
                ..Fake::default()
            };
            let one = verdicts(&[PathBuf::from(r"C:\x\a")], &sys);
            assert_eq!(one[0].1, Verdict::HasBin);
            assert_eq!(
                on_c(&sys),
                [Verdict::TooBig("C:".into()), Verdict::TooBig("C:".into())]
            );
            // no MaxCapacity: the size is not checked (an assumption, see `settings`)
            let unset = Fake {
                size: u64::MAX,
                ..Fake::default()
            };
            assert_eq!(on_c(&unset)[0], Verdict::HasBin);
        }

        /// A Replace bins the old file over a bin with no size set: a file above
        /// `REPLACE_BIN_GUESS` there is "too big" (overwritten, with the warning) rather than
        /// risk Windows deleting it for good behind a "Binned"; one at or below it still goes.
        #[test]
        fn a_replace_takes_an_unset_bin_size_to_be_one_gib() {
            let path = [PathBuf::from(r"C:\x\a")];
            let big = Fake {
                size: super::super::REPLACE_BIN_GUESS + 1,
                ..Fake::default()
            };
            let guess = Some(super::super::REPLACE_BIN_GUESS);
            assert_eq!(
                verdicts_capped(&path, &big, guess)[0].1,
                Verdict::TooBig("C:".into())
            );
            assert_eq!(
                verdicts(&path, &big)[0].1,
                Verdict::HasBin,
                "Delete unchanged"
            );
            let fits = Fake {
                size: super::super::REPLACE_BIN_GUESS,
                ..Fake::default()
            };
            assert_eq!(verdicts_capped(&path, &fits, guess)[0].1, Verdict::HasBin);
        }

        #[test]
        fn a_registry_that_will_not_answer_or_a_volume_with_no_guid_is_unknown() {
            let fails = Fake {
                reg_fails: true,
                ..Fake::default()
            };
            assert_eq!(on_c(&fails)[0], Verdict::Unknown("C:".into()));
            let no_guid = Fake {
                no_guid: true,
                ..Fake::default()
            };
            assert_eq!(on_c(&no_guid)[0], Verdict::Unknown("C:".into()));
            // a place with no bin is never asked about settings
            let n = verdicts(&[PathBuf::from(r"N:\a")], &fails);
            assert_eq!(n[0].1, no_bin("N:"));
        }

        #[test]
        fn guid_of_reads_the_braces() {
            assert_eq!(
                guid_of(r"\\?\Volume{4c1b-77}\").as_deref(),
                Some("{4c1b-77}")
            );
            assert_eq!(guid_of("nothing"), None);
        }

        /// The real walk, in %TEMP%: files are counted, a folder link is not entered, and it
        /// stops once past the budget.
        #[test]
        fn the_size_walk_counts_files_and_stops_past_the_budget() {
            let dir = super::scratch("trash-size-walk");
            std::fs::create_dir_all(dir.join("sub")).unwrap();
            std::fs::write(dir.join("a"), vec![0u8; 1000]).unwrap();
            std::fs::write(dir.join("sub").join("b"), vec![0u8; 500]).unwrap();
            assert_eq!(walk_size(&dir, u64::MAX), 1500);
            assert_eq!(walk_size(&dir.join("a"), u64::MAX), 1000);
            assert!(walk_size(&dir, 100) > 100);
            let outside = super::scratch("trash-size-walk-outside");
            std::fs::write(outside.join("big"), vec![0u8; 4000]).unwrap();
            if std::os::windows::fs::symlink_dir(&outside, dir.join("link")).is_ok() {
                assert_eq!(walk_size(&dir, u64::MAX), 1500);
                std::fs::remove_dir(dir.join("link")).unwrap();
            }
            std::fs::remove_dir_all(dir).unwrap();
            std::fs::remove_dir_all(outside).unwrap();
        }

        #[test]
        fn mapped_and_removable_drives_have_no_bin() {
            assert_eq!(verdict(r"N:\Home\a.txt"), no_bin("N:"));
            assert_eq!(verdict(r"z:\share\a"), no_bin("Z:"));
            assert_eq!(verdict(r"W:\home\alex"), no_bin("W:"));
            assert_eq!(verdict(r"\\?\N:\a"), no_bin("N:"));
            assert_eq!(verdict(r"\\.\Z:\a"), no_bin("Z:"));
            assert_eq!(verdict(r"E:\photo.jpg"), no_bin("E:"));
        }

        #[test]
        fn every_unc_spelling_has_no_bin() {
            let home = no_bin(r"\\10.0.0.5\Home");
            assert_eq!(verdict(r"\\10.0.0.5\Home\a.txt"), home);
            assert_eq!(verdict(r"\\?\UNC\10.0.0.5\Home\a.txt"), home);
            assert_eq!(verdict(r"\\.\UNC\10.0.0.5\Home\a.txt"), home);
            assert_eq!(verdict(r"\\nas\share"), no_bin(r"\\nas\share"));
            assert_eq!(verdict(r"\\?\UNC\wsl.localhost\Ubuntu\tmp"), no_bin("WSL"));
            assert_eq!(verdict(r"\\WSL$\Ubuntu\tmp"), no_bin("WSL"));
        }

        #[test]
        fn a_local_fixed_disk_has_a_bin_in_every_spelling() {
            assert_eq!(verdict(r"C:\Users\alex\a.txt"), Verdict::HasBin);
            assert_eq!(verdict(r"c:\Users"), Verdict::HasBin);
            assert_eq!(verdict(r"\\?\C:\Users\alex"), Verdict::HasBin);
            assert_eq!(verdict(r"\\.\C:\Users\alex"), Verdict::HasBin);
            assert_eq!(verdict(r"\\?\Volume{local}\a"), Verdict::HasBin);
        }

        #[test]
        fn a_volume_windows_cannot_classify_is_not_assumed_local() {
            assert_eq!(verdict(r"Q:\a"), Verdict::Unknown("Q:".into()));
            assert_eq!(verdict(r"V:\a"), Verdict::Unknown("V:".into()));
            assert!(matches!(
                verdict(r"\\?\GLOBALROOT\Device\HarddiskVolume3\a"),
                Verdict::Unknown(_)
            ));
            assert!(matches!(verdict(r"\\.\PIPE\x"), Verdict::Unknown(_)));
        }

        /// A directory symlink on C: that leads to a share: the folder as written looks local,
        /// where it really is does not. Skips when this account may not make symlinks.
        #[test]
        fn a_link_on_c_that_leads_to_a_share_has_no_bin() {
            let dir = super::scratch("trash-link-to-share");
            let target = dir.join("target");
            std::fs::create_dir(&target).unwrap();
            let link = dir.join("link");
            let share = super::via_admin_share(&target, false);
            if let Err(e) = std::os::windows::fs::symlink_dir(&share, &link) {
                eprintln!("skip: cannot make a symlink here: {e}");
                std::fs::remove_dir_all(dir).ok();
                return;
            }
            assert_eq!(verdict_of(&dir, &Live), Verdict::HasBin);
            assert!(matches!(verdict_of(&link, &Live), Verdict::NoBin(_)));
            std::fs::remove_dir(&link).unwrap();
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    /// `subst T: %TEMP%\…` is the same fixed disk: still local. Makes a drive letter for a moment,
    /// so it is opt-in: `cargo test -- --ignored a_subst_drive`.
    #[cfg(windows)]
    #[test]
    #[ignore = "creates and removes a subst drive letter"]
    fn a_subst_drive_of_a_local_folder_keeps_its_bin() {
        let dir = scratch("trash-subst");
        let name = format!("trove-subst-probe-{}.txt", std::process::id());
        fs::write(dir.join(&name), b"bin me").unwrap();
        let Some(letter) = ('H'..='Y')
            .rev()
            .find(|l| !Path::new(&format!(r"{l}:\")).exists())
        else {
            eprintln!("skip: no free drive letter");
            return;
        };
        let drive = format!("{letter}:");
        let made = std::process::Command::new("subst")
            .arg(&drive)
            .arg(&dir)
            .status()
            .unwrap();
        assert!(made.success());
        let via_subst = PathBuf::from(format!(r"{drive}\{name}"));
        let result = trash(std::slice::from_ref(&via_subst));
        let _ = std::process::Command::new("subst")
            .args([&drive, "/D"])
            .status();
        result.unwrap();
        assert!(!dir.join(&name).exists());
        let ids: Vec<String> = crate::core::recycle::list()
            .unwrap()
            .into_iter()
            .filter(|i| i.name == name)
            .map(|i| i.id)
            .collect();
        assert_eq!(ids.len(), 1, "the file should be in the Recycle Bin once");
        crate::core::recycle::purge(&ids).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    /// A Linux directory symlink over the WSL share (`is_symlink`, attributes 0x400, no
    /// DIRECTORY bit): `remove_entry` takes the link and leaves the folder it points at.
    /// `cargo test -- --ignored a_linux_dir_symlink`.
    #[test]
    #[ignore = "needs an installed WSL distro; writes to its /tmp over the share"]
    fn a_linux_dir_symlink_on_a_wsl_share_is_removed_as_a_link() {
        let Some(distro) = first_wsl_distro() else {
            eprintln!("skip: no WSL distro installed");
            return;
        };
        let tag = format!("trove-link-{}", std::process::id());
        let made = std::process::Command::new("wsl.exe")
            .args(["-d", &distro, "--", "sh", "-c"])
            .arg(format!(
                "mkdir -p /tmp/{tag}/target && echo canary > /tmp/{tag}/target/canary && ln -s /tmp/{tag}/target /tmp/{tag}/link"
            ))
            .status()
            .unwrap();
        assert!(made.success());
        let root = PathBuf::from(format!(r"\\wsl.localhost\{distro}\tmp\{tag}"));
        let link = root.join("link");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        let result = remove_entry(&link);
        let link_gone = fs::symlink_metadata(&link).is_err();
        let canary = root.join("target").join("canary").exists();
        let _ = std::process::Command::new("wsl.exe")
            .args(["-d", &distro, "--", "rm", "-rf", &format!("/tmp/{tag}")])
            .status();
        result.unwrap();
        assert!(link_gone, "the link must be gone");
        assert!(canary, "the folder the link points at must survive");
    }

    /// Real share, real file: `cargo test -- --ignored trash_on_a_live_wsl_share`.
    /// Passes as a skip when no distro is installed or its `/tmp` cannot be written.
    #[test]
    #[ignore = "needs an installed WSL distro; writes to its /tmp over the share"]
    fn trash_on_a_live_wsl_share_is_refused_and_the_file_stays() {
        let Some(distro) = first_wsl_distro() else {
            eprintln!("skip: no WSL distro installed");
            return;
        };
        let probe = PathBuf::from(format!(r"\\wsl.localhost\{distro}\tmp\trove-probe"));
        if let Err(e) = fs::write(&probe, b"probe") {
            eprintln!("skip: cannot write {}: {e}", probe.display());
            return;
        }
        let result = trash(std::slice::from_ref(&probe));
        let still_there = probe.exists();
        let _ = fs::remove_file(&probe);
        let err = result.unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Unsupported);
        assert!(still_there, "trash() must not touch a WSL file");
    }

    /// `wsl.exe -l -q` prints UTF-16LE names, one per line; the first one is enough.
    fn first_wsl_distro() -> Option<String> {
        let out = std::process::Command::new("wsl.exe")
            .args(["-l", "-q"])
            .output()
            .ok()?;
        let (pairs, _odd_byte) = out.stdout.as_chunks::<2>();
        let wide: Vec<u16> = pairs.iter().map(|&p| u16::from_le_bytes(p)).collect();
        String::from_utf16_lossy(&wide)
            .lines()
            .map(|l| {
                l.trim_matches(|c: char| c.is_whitespace() || c == '\0')
                    .to_string()
            })
            .find(|l| !l.is_empty())
    }
}

#[cfg(all(test, unix))]
mod case_probe_tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("trove-ops-probe-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The inverse of the macOS fix, and the one that matters: on a case-sensitive volume two
    /// names that differ only in case are two FILES, and renaming one onto the other must reach
    /// the overwrite guard instead of being waved through as "the same file".
    #[test]
    fn two_different_files_are_not_a_case_only_rename() {
        let dir = scratch("distinct");
        fs::write(dir.join("readme"), b"mine").unwrap();
        fs::write(dir.join("README"), b"someone else's").unwrap();
        // ext4 keeps both; a case-insensitive volume cannot hold the second write, so this
        // test only has something to say where the two really are two files
        if fs::read(dir.join("readme")).unwrap() == b"mine" {
            assert!(!host_is_case_insensitive(
                &dir.join("readme"),
                &dir.join("README")
            ));
            assert!(!same_file_case_change(
                &dir.join("readme"),
                &dir.join("README")
            ));
            assert!(rename(&dir.join("readme"), "README").is_err());
            assert_eq!(fs::read(dir.join("README")).unwrap(), b"someone else's");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    /// Two names for one inode is exactly what a case-insensitive volume looks like from the
    /// outside. On a case-sensitive one a hard link makes that shape; on a case-insensitive one
    /// (a default Mac) the link is refused because `README` already IS `readme`, and the volume
    /// itself is the shape. Either way the probe must say "one file", so the link's result is
    /// not asserted, only what the probe makes of the two names.
    #[test]
    fn two_names_for_one_inode_are_a_case_only_rename() {
        let dir = scratch("inode");
        fs::write(dir.join("readme"), b"x").unwrap();
        let _ = fs::hard_link(dir.join("readme"), dir.join("README"));
        assert!(host_is_case_insensitive(
            &dir.join("readme"),
            &dir.join("README")
        ));
        assert!(same_file_case_change(
            &dir.join("readme"),
            &dir.join("README")
        ));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_target_that_does_not_exist_is_not_case_insensitive() {
        let dir = scratch("absent");
        fs::write(dir.join("readme"), b"x").unwrap();
        // a name that differs by more than case, so it is absent on a case-insensitive volume too
        assert!(!host_is_case_insensitive(
            &dir.join("readme"),
            &dir.join("elsewhere")
        ));
        fs::remove_dir_all(dir).unwrap();
    }
}

/// Plan 19 Q3 / 3.2 (Joy 2026-10-19): a notice about the bin names it in the "I'm coming from"
/// word. Rust writes the host's word and the frontend renames it at display time
/// (`inBinWords`, `src/lib/utils/platform.ts`), which only finds the bin as a noun after
/// "the", "a" or "no". This keeps every user-facing Rust sentence in that shape, so a new
/// sentence ("Recycle Bin is full") cannot slip past the rename.
#[cfg(test)]
mod bin_word_tests {
    use std::path::Path;

    /// Every string literal in `src`, in order, outside comments and char literals.
    fn literals(src: &str) -> Vec<String> {
        let b = src.as_bytes();
        let (mut i, mut out) = (0, Vec::new());
        while i < b.len() {
            match b[i] {
                b'/' if b.get(i + 1) == Some(&b'/') => {
                    while i < b.len() && b[i] != b'\n' {
                        i += 1;
                    }
                }
                b'/' if b.get(i + 1) == Some(&b'*') => {
                    i += 2;
                    while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                        i += 1;
                    }
                    i += 2;
                }
                // a char literal ('"', '\'', 'x'); a lifetime ('a) is one byte and moves on
                b'\'' if b.get(i + 1) == Some(&b'\\') => {
                    i += 2;
                    while i < b.len() && b[i] != b'\'' {
                        i += 1;
                    }
                    i += 1;
                }
                b'\'' if b.get(i + 2) == Some(&b'\'') => i += 3,
                b'"' => {
                    let start = i + 1;
                    i += 1;
                    while i < b.len() && b[i] != b'"' {
                        i += if b[i] == b'\\' { 2 } else { 1 };
                    }
                    out.push(String::from_utf8_lossy(&b[start..i.min(b.len())]).into_owned());
                    i += 1;
                }
                _ => i += 1,
            }
        }
        out
    }

    /// The bin words in `text` that are not after "the", "a" or "no". Case-sensitive: the noun is
    /// "Recycle Bin" / "Trash"; a lower-case "trash" is a log tag or the verb ("trash purge:").
    /// A literal that is only the word (`BIN_WORD`'s value) and a path segment (`.Trash`,
    /// `.Trashes`) are not sentences.
    fn unrenamed(text: &str) -> Vec<String> {
        if ["Recycle Bin", "Trash"].contains(&text) {
            return Vec::new();
        }
        let mut bad = Vec::new();
        for word in ["Recycle Bin", "Trash", "{BIN_WORD}"] {
            for (at, _) in text.match_indices(word) {
                let before = text[..at].to_lowercase();
                let prev = before.chars().last();
                let after = text[at + word.len()..].chars().next();
                let inside_a_word = prev
                    .is_some_and(|c| c.is_alphanumeric() || c == '.' || c == '_')
                    || after.is_some_and(|c| c.is_alphanumeric() || c == '_');
                if inside_a_word {
                    continue;
                }
                let named = [" the ", " a ", " no "]
                    .iter()
                    .any(|a| format!(" {before}").ends_with(a));
                if !named {
                    bad.push(text.to_string());
                }
            }
        }
        bad
    }

    /// The part of a source file that ships: everything before its `#[cfg(test)]` modules.
    fn shipped(src: &str) -> &str {
        let end = ["\n#[cfg(test)]\nmod ", "\n#[cfg(all(test"]
            .iter()
            .filter_map(|m| src.find(m))
            .min()
            .unwrap_or(src.len());
        &src[..end]
    }

    fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    #[test]
    fn the_check_finds_a_bare_bin_word_and_passes_the_ones_the_frontend_renames() {
        assert_eq!(unrenamed("Recycle Bin is full: C:\\a").len(), 1);
        assert_eq!(unrenamed("Trash could not be read").len(), 1);
        assert_eq!(unrenamed("now in {BIN_WORD}").len(), 1);
        assert!(unrenamed("The Recycle Bin is turned off for {place}").is_empty());
        assert!(unrenamed("{place} has no Recycle Bin, so nothing was deleted").is_empty());
        assert!(unrenamed("whether {place} has a Recycle Bin").is_empty());
        assert!(unrenamed("could not go to the {BIN_WORD}, so").is_empty());
        assert!(unrenamed("Trash").is_empty());
        assert!(unrenamed(".Trashes").is_empty());
        assert!(unrenamed("trash purge: {} item(s)").is_empty());
        assert_eq!(
            literals("// \"Trash is\"\nlet c = '\"'; f(\"no Trash\", 'a'); /* \"x\" */ \"y\""),
            vec!["no Trash".to_string(), "y".to_string()]
        );
    }

    #[test]
    fn every_shipped_rust_sentence_names_the_bin_where_the_frontend_renames_it() {
        let mut files = Vec::new();
        rust_files(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        assert!(files.len() > 20, "found only {} .rs files", files.len());
        let mut bad = Vec::new();
        let mut seen = 0;
        for file in &files {
            let src = std::fs::read_to_string(file).unwrap();
            for lit in literals(shipped(&src)) {
                let lower = lit.to_lowercase();
                if lower.contains("recycle bin")
                    || lower.contains("trash")
                    || lower.contains("{bin_word}")
                {
                    seen += 1;
                }
                for b in unrenamed(&lit) {
                    bad.push(format!("{}: {b}", file.display()));
                }
            }
        }
        // the check reads real sentences, not nothing: ops, recycle, transfer, recycle_mac, uninstall
        assert!(seen > 20, "only {seen} literals name the bin");
        assert!(
            bad.is_empty(),
            "the frontend cannot rename these:\n{}",
            bad.join("\n")
        );
    }
}

/// The attribute bits `SetFileAttributesW` accepts back. A placeholder also carries the recall,
/// reparse and directory bits, which the OS sets itself and refuses to have written.
#[cfg_attr(not(windows), allow(dead_code))] // only Windows pins cloud files; tested everywhere
const SETTABLE_ATTRS: u32 = 0x1 | 0x2 | 0x4 | 0x20 | 0x100 | 0x1000 | 0x2000;

/// The word "Always keep on this device" (`keep`) or "Free up space" writes: keep sets PINNED and
/// drops UNPINNED, free does the reverse, the rest of `current` stays. The cloud provider sees
/// the bits and downloads or frees the bytes itself, as it does for `attrib +P` / `attrib +U`.
#[cfg_attr(not(windows), allow(dead_code))] // only Windows pins cloud files; tested everywhere
pub fn cloud_pin_attrs(current: u32, keep: bool) -> u32 {
    use crate::core::fs::{FILE_ATTRIBUTE_PINNED as PINNED, FILE_ATTRIBUTE_UNPINNED as UNPINNED};
    let base = current & SETTABLE_ATTRS;
    if keep {
        (base | PINNED) & !UNPINNED
    } else {
        (base | UNPINNED) & !PINNED
    }
}

/// Pin or free one cloud file or folder (plan 05 5.4). Reads the attributes off the link itself,
/// as the listing does, so asking never downloads the file.
#[cfg(windows)]
pub fn set_cloud_pin(path: &Path, keep: bool) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::SetFileAttributesW;

    let current = std::fs::symlink_metadata(path)?.file_attributes();
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call; the word is plain
    // attribute bits. The function reads the string and touches nothing else of ours.
    let ok = unsafe { SetFileAttributesW(wide.as_ptr(), cloud_pin_attrs(current, keep)) };
    if ok == 0 {
        Err(Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Only Windows has the Cloud Files pin bits; the menu never offers this elsewhere.
#[cfg(not(windows))]
pub fn set_cloud_pin(_path: &Path, _keep: bool) -> Result<()> {
    Err(Error::new(
        ErrorKind::Unsupported,
        "Keeping files on this device is a Windows feature",
    ))
}

#[cfg(test)]
mod cloud_pin_tests {
    use super::*;
    use crate::core::fs::{
        cloud_state_of, CloudState, FILE_ATTRIBUTE_PINNED, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
        FILE_ATTRIBUTE_UNPINNED,
    };

    const ARCHIVE: u32 = 0x20;
    const REPARSE: u32 = 0x400;
    const DIRECTORY: u32 = 0x10;

    #[test]
    fn keep_pins_and_free_unpins() {
        let online =
            ARCHIVE | REPARSE | FILE_ATTRIBUTE_UNPINNED | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
        let kept = cloud_pin_attrs(online, true);
        assert_eq!(kept, ARCHIVE | FILE_ATTRIBUTE_PINNED);
        assert_eq!(cloud_state_of(kept), Some(CloudState::Pinned));
        let freed = cloud_pin_attrs(ARCHIVE | FILE_ATTRIBUTE_PINNED, false);
        assert_eq!(freed, ARCHIVE | FILE_ATTRIBUTE_UNPINNED);
    }

    #[test]
    fn the_os_owned_bits_are_never_written_back() {
        let word = cloud_pin_attrs(
            DIRECTORY | REPARSE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
            false,
        );
        assert_eq!(
            word & (DIRECTORY | REPARSE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS),
            0
        );
        assert_eq!(word, FILE_ATTRIBUTE_UNPINNED);
    }

    #[test]
    fn hidden_and_read_only_survive_a_pin() {
        assert_eq!(
            cloud_pin_attrs(0x1 | 0x2, true),
            0x1 | 0x2 | FILE_ATTRIBUTE_PINNED
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_it_says_why() {
        let e = set_cloud_pin(Path::new("/tmp/x"), true).unwrap_err();
        assert_eq!(e.kind(), ErrorKind::Unsupported);
    }
}

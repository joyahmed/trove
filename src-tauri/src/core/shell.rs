//! What the sidebar needs from the OS: the user's known folders and the mounted drives.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// What the place that holds the known folders and the drives is called on this OS: Joy's
/// decision of 2026-09-25 (plan 10, B.2). ⛔ A display label only. Its key is `this-pc` on every
/// platform, in the type, in `settings.json` (`startPlace`, `sidebarCollapsed`) and in the
/// palette (B.2.1), and the frontend's parser accepts all three spellings (B.2.2).
pub const THIS_PC_LABEL: &str = if cfg!(windows) {
    "This PC"
} else if cfg!(target_os = "macos") {
    "This Mac"
} else {
    "This Computer"
};

/// The OS-dependent facts the frontend needs before its first line runs, as a script Tauri
/// injects into every window ahead of the page (plan 10, B.2.3). ⭐ Rust sends the label, not
/// just the platform, so the strings stay owned here like `KnownFolder.label`; and an init
/// script rather than a command, because `paletteActions` and `PLACE_LABEL` are evaluated at
/// import time — an awaited answer would arrive after them.
pub fn platform_init_script() -> String {
    let facts = serde_json::json!({
        "os": std::env::consts::OS,
        "thisPcLabel": THIS_PC_LABEL,
        // which store this build ships through (plan 22): Settings hides what the store breaks
        "channel": crate::core::channel::CURRENT.as_str(),
        // whether this build updates itself (plan 22.5): false hides every update line
        "updater": crate::core::channel::UPDATER,
        // whether this build reads RAR (cargo feature `rar`, plan 16 phase 5): false keeps every
        // RAR row off, so a distro build without UnRAR never offers what it cannot do
        "rar": cfg!(feature = "rar"),
    });
    format!("window.__TROVE_PLATFORM__ = Object.freeze({facts});")
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownFolder {
    /// Stable id the frontend maps to an icon: "desktop", "downloads", …
    pub key: &'static str,
    pub label: &'static str,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    /// `C:\` on Windows; `/` or `/Volumes/<name>` on macOS; `/`, `/media/<user>/<name>`,
    /// `/run/media/<user>/<name>` or `/mnt/<name>` on Linux.
    pub path: String,
    /// Volume label, "Local Disk" when the volume has none (Windows). Off Windows: the mount
    /// point's last component, and for `/` the boot volume's own name (macOS) or
    /// "File System" (Linux).
    pub label: String,
    /// `None` when the OS would not say (a failed `statvfs` / `GetDiskFreeSpaceExW`): unknown is
    /// not zero, and the frontend shows no caption and no bar for it (plan 10, B.2.4).
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    /// A network share (SMB, AFP, NFS, WebDAV, sshfs ...). Never measured: its sizes are `None`
    /// and nothing walks it until the person opens it - touching it is what makes macOS ask
    /// "Trove would like to access files on a network volume" (`core/mounts.rs`). Always
    /// `false` on Windows.
    pub network: bool,
}

/// `(key, label, folder under the profile)`. ⛔ The key is persisted (`hiddenKnownFolders`) and
/// mirrored as `KnownFolderKey`, so it never changes per platform; only the label and the
/// folder do — macOS calls Videos `Movies` (plan 10, B.2.5).
const KNOWN: [(&str, &str, &str); 6] = [
    ("desktop", "Desktop", "Desktop"),
    ("downloads", "Downloads", "Downloads"),
    ("documents", "Documents", "Documents"),
    ("pictures", "Pictures", "Pictures"),
    ("music", "Music", "Music"),
    #[cfg(not(target_os = "macos"))]
    ("videos", "Videos", "Videos"),
    #[cfg(target_os = "macos")]
    ("videos", "Movies", "Movies"),
];

/// The user's known folders, asked of the shell (`SHGetKnownFolderPath`) so a redirected
/// Documents (OneDrive Known Folder Move) resolves to where it really is; `USERPROFILE\<name>`
/// when the shell has no answer. On Linux the "shell" is `~/.config/user-dirs.dirs`, whose
/// names are localised; on macOS the folders are fixed English names under `$HOME`. Only
/// folders that exist are listed.
pub fn known_folders(profile: &Path) -> Vec<KnownFolder> {
    #[cfg(target_os = "linux")]
    {
        let dirs = read_user_dirs(profile);
        known_folders_with(profile, move |key| {
            dirs.iter().find(|(k, _)| *k == key).map(|(_, p)| p.clone())
        })
    }
    #[cfg(not(target_os = "linux"))]
    known_folders_with(profile, shell_known_folder)
}

/// `$XDG_CONFIG_HOME/user-dirs.dirs` (else `~/.config/…`), parsed. Empty when it is missing,
/// so every folder falls back to its English name under `$HOME` — and is still listed only if
/// that exists.
#[cfg(target_os = "linux")]
fn read_user_dirs(home: &Path) -> Vec<(&'static str, PathBuf)> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".config"));
    match std::fs::read_to_string(config.join("user-dirs.dirs")) {
        Ok(text) => crate::core::places_unix::parse_user_dirs(&text, home),
        Err(e) => {
            log::info!("known_folders: no user-dirs.dirs ({e}); using the English names");
            Vec::new()
        }
    }
}

/// The same, with the shell lookup injected so a test can run against a scratch profile.
fn known_folders_with(
    profile: &Path,
    lookup: impl Fn(&'static str) -> Option<PathBuf>,
) -> Vec<KnownFolder> {
    KNOWN
        .iter()
        .map(|(key, label, dir)| KnownFolder {
            key,
            label,
            path: lookup(key)
                .unwrap_or_else(|| profile.join(dir))
                .to_string_lossy()
                .into_owned(),
        })
        .filter(|f| Path::new(&f.path).is_dir())
        .collect()
}

#[cfg(windows)]
pub fn user_profile() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

/// ⛔ `USERPROFILE` does not exist off Windows; `HOME` is the same thing (plan 10, B.1).
#[cfg(not(windows))]
pub fn user_profile() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// The OneDrive root when the client is set up: the `OneDrive` environment variable, else
/// `HKCU\Software\Microsoft\OneDrive\UserFolder`; only if the folder exists.
pub fn one_drive_root() -> Option<String> {
    let from_env = std::env::var_os("OneDrive").map(PathBuf::from);
    let from_registry = || {
        crate::core::registry::read_sz("Software\\Microsoft\\OneDrive", "UserFolder")
            .ok()
            .flatten()
            .map(PathBuf::from)
    };
    from_env
        .or_else(from_registry)
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn shell_known_folder(key: &'static str) -> Option<PathBuf> {
    use windows_sys::core::GUID;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music,
        FOLDERID_Pictures, FOLDERID_Videos, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
    };

    let id: &GUID = match key {
        "desktop" => &FOLDERID_Desktop,
        "downloads" => &FOLDERID_Downloads,
        "documents" => &FOLDERID_Documents,
        "pictures" => &FOLDERID_Pictures,
        "music" => &FOLDERID_Music,
        "videos" => &FOLDERID_Videos,
        _ => return None,
    };
    let mut out: *mut u16 = std::ptr::null_mut();
    // SAFETY: `id` is a static GUID; a null token means the current user; `out` receives a
    // CoTaskMem string we free below on every path.
    let hr =
        unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT as u32, std::ptr::null_mut(), &mut out) };
    if hr < 0 || out.is_null() {
        return None;
    }
    // SAFETY: on success `out` is a NUL-terminated UTF-16 string owned by us until freed.
    let path = unsafe {
        let mut len = 0usize;
        while *out.add(len) != 0 {
            len += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(out, len));
        CoTaskMemFree(out.cast());
        s
    };
    Some(PathBuf::from(path))
}

/// macOS has no lookup worth asking: the folders are `~/Desktop` … `~/Movies`, in English
/// whatever the system language (Finder localises only their display names).
#[cfg(not(any(windows, target_os = "linux")))]
fn shell_known_folder(_key: &'static str) -> Option<PathBuf> {
    None
}

/// Past this, a drive letter is the reason This PC looked broken, so it is a warning and lands
/// in a release build's log too. A healthy local disk answers in single-digit milliseconds.
const SLOW_DRIVE_MS: u128 = 2000;

/// How long the listing waits for a drive's label and sizes. A healthy disk answers in
/// milliseconds; a dead network mapping answers after the redirector's timeout (21-64 s in
/// `trove.log`), and C: and D: must not wait that long for it.
const DRIVE_WAIT: std::time::Duration = std::time::Duration::from_millis(1500);

/// What a drive that did not answer in `DRIVE_WAIT` is called. On Windows that is in practice a
/// mapped share whose server is gone; off Windows only a local drive is ever asked, and its
/// mount point already names it.
#[cfg(windows)]
fn unanswered_label(_root: &str) -> String {
    "Network drive".into()
}

#[cfg(not(windows))]
fn unanswered_label(root: &str) -> String {
    crate::core::places_unix::mount_leaf(root)
}

/// Every mounted drive letter, with its label and sizes.
///
/// One thread per letter: a letter mapped to a share that is not there answers
/// `GetVolumeInformationW` only after the redirector's timeout (tens of seconds), and doing
/// the letters in a row made that the sum instead of the longest. Waiting for the longest still
/// held the whole sidebar for it, so the wait is now capped too (`list_drives`).
pub fn drives() -> Vec<DriveInfo> {
    list_drives(drive_list(), volume_info, DRIVE_WAIT)
}

/// `volume_info`'s shape: a drive's root in, its label, total and free bytes out.
type VolumeProbe = fn(&str) -> (String, Option<u64>, Option<u64>);

/// The listing behind `drives`, with the probe and the wait as parameters so a test can make a
/// drive slow without a network. ⛔ It never waits more than `wait` in all: a drive that has
/// not answered by then is listed with what is known without asking it (its path,
/// `unanswered_label`, sizes `None` so no bar), and its thread is left to finish on its own and
/// log how long it really took. Rows come back in the order of `roots`.
fn list_drives(
    roots: Vec<crate::core::places_unix::DriveRoot>,
    query: VolumeProbe,
    wait: std::time::Duration,
) -> Vec<DriveInfo> {
    let deadline = std::time::Instant::now() + wait;
    let (tx, rx) = std::sync::mpsc::channel();
    for (i, root) in roots.iter().cloned().enumerate() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            // ⚠️ Per letter, because the whole list is only as slow as its worst one and the
            // log could not say which. `trove.log` measured this call at 21 s on one cold
            // start and 64 s on another, then under a second on a third — a dead network
            // mapping waiting out the SMB redirector, intermittently. This is the line that
            // names the letter. `debug`, so a release build does not record it (A.4), and
            // because a drive letter plus a timing is diagnostic, not something to ship.
            let started = std::time::Instant::now();
            let info = describe(root, query);
            let ms = started.elapsed().as_millis();
            let root = &info.path;
            if ms > SLOW_DRIVE_MS {
                log::warn!("drives: {root} took {ms} ms to answer");
            } else {
                log::debug!("drives: {root} took {ms} ms");
            }
            // the listing may have stopped waiting for this one; then nobody receives it
            let _ = tx.send((i, info));
        });
    }
    drop(tx);
    let mut answers: Vec<Option<DriveInfo>> = vec![None; roots.len()];
    let mut all_finished = false;
    while answers.iter().any(Option::is_none) {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok((i, info)) => answers[i] = Some(info),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                all_finished = true;
                break;
            }
        }
    }
    // ⚠️ A thread that panicked used to vanish here with no trace: `join().ok()` turned a dead
    // drive into one that simply was not in the list, which is the same silent-empty shape as
    // the This PC bug (`docs/plans/07`, "Found while verifying"). It still does not fail the
    // whole listing — one bad drive must not cost the sidebar every other one — but it now
    // says so. Every thread finished and this one sent nothing: a panic, not a slow drive.
    roots
        .into_iter()
        .zip(answers)
        .filter_map(|(root, answer)| match answer {
            Some(info) => Some(info),
            None if all_finished => {
                log::error!("drives: {}'s thread panicked and was dropped", root.path);
                None
            }
            None => {
                log::warn!(
                    "drives: {} did not answer in {} ms; listed without its sizes",
                    root.path,
                    wait.as_millis()
                );
                Some(DriveInfo {
                    label: unanswered_label(&root.path),
                    path: root.path,
                    total_bytes: None,
                    free_bytes: None,
                    network: root.network,
                })
            }
        })
        .collect()
}

/// One drive's row. A local one is asked for its label and sizes (`query`, which is
/// `volume_info`). A network one is not asked anything: its label is its mount point's last
/// component and its sizes are unknown, so the sidebar draws no bar for it. A `statvfs` on a
/// share is exactly what raises macOS's network-volume prompt, and on Linux it hangs on a
/// dead server. `query` is a parameter so a test can prove it is never called for a share.
fn describe(
    root: crate::core::places_unix::DriveRoot,
    query: impl FnOnce(&str) -> (String, Option<u64>, Option<u64>),
) -> DriveInfo {
    if root.network {
        return DriveInfo {
            label: crate::core::places_unix::mount_leaf(&root.path),
            path: root.path,
            total_bytes: None,
            free_bytes: None,
            network: true,
        };
    }
    let (label, total_bytes, free_bytes) = query(&root.path);
    DriveInfo {
        path: root.path,
        label,
        total_bytes,
        free_bytes,
        network: false,
    }
}

/// The drives to list. Windows' letters are all local here: its own code is unchanged.
#[cfg(windows)]
fn drive_list() -> Vec<crate::core::places_unix::DriveRoot> {
    drive_roots()
        .iter()
        .map(|r| crate::core::places_unix::DriveRoot::local(r))
        .collect()
}

#[cfg(not(windows))]
fn drive_list() -> Vec<crate::core::places_unix::DriveRoot> {
    drive_roots()
}

/// The mounted letters. `GetLogicalDrives` is one bitmask the kernel already has; the
/// `Path::is_dir` probe it replaces opened each letter in turn, which on a disconnected
/// network mapping blocked for the SMB timeout before the window had painted once.
#[cfg(windows)]
fn drive_roots() -> Vec<String> {
    use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;

    // SAFETY: no arguments, no out-params — the bitmask is the return value.
    let mask = unsafe { GetLogicalDrives() };
    (0u32..26)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| format!("{}:\\", (b'A' + i as u8) as char))
        .collect()
}

/// `/` and the real mounts under the media paths — not the letter grid, which off Windows is a
/// correct empty answer (plan 10, B.2.4).
#[cfg(target_os = "linux")]
fn drive_roots() -> Vec<crate::core::places_unix::DriveRoot> {
    let table = std::fs::read_to_string("/proc/self/mounts")
        .or_else(|_| std::fs::read_to_string("/proc/mounts"))
        .unwrap_or_else(|e| {
            log::error!("drives: cannot read the mount table ({e}); listing only /");
            String::new()
        });
    crate::core::places_unix::linux_drive_roots(&table, &login_name())
}

/// Whose `/media/<user>` to list: `USER`, else `LOGNAME`, else the home folder's name.
#[cfg(target_os = "linux")]
fn login_name() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()
        .filter(|u| !u.is_empty())
        .or_else(|| {
            user_profile().and_then(|h| h.file_name().map(|n| n.to_string_lossy().into_owned()))
        })
        .unwrap_or_default()
}

/// `/` and the volumes in `/Volumes`, from `mount`'s table, minus attached disk images
/// (`hdiutil info`). Either command failing degrades, never empties: no table → just `/`;
/// no image list → a `.dmg` shows as a drive.
#[cfg(target_os = "macos")]
fn drive_roots() -> Vec<crate::core::places_unix::DriveRoot> {
    use crate::core::places_unix::{mac_drive_roots, parse_hdiutil_mount_points, parse_mac_mount};
    let run = |cmd: &str, args: &[&str]| match std::process::Command::new(cmd).args(args).output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        Ok(o) => {
            log::warn!("drives: {cmd} exited {}", o.status);
            String::new()
        }
        Err(e) => {
            log::warn!("drives: cannot run {cmd} ({e})");
            String::new()
        }
    };
    let mounts = parse_mac_mount(&run("/sbin/mount", &[]));
    let images = parse_hdiutil_mount_points(&run("/usr/bin/hdiutil", &["info"]));
    mac_drive_roots(&mounts, &images)
}

/// Neither Windows, Linux nor macOS: `/` alone, honest rather than empty.
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn drive_roots() -> Vec<crate::core::places_unix::DriveRoot> {
    vec![crate::core::places_unix::DriveRoot::local("/")]
}

/// Ask about a volume without Windows putting a modal in front of the user: an empty optical
/// drive or card reader answers `GetVolumeInformationW` with the "There is no disk in the
/// drive" box, which blocks this thread until someone clicks it. `SEM_FAILCRITICALERRORS`
/// turns that into an error return. Restored on the way out so nothing else inherits it.
#[cfg(windows)]
struct QuietDriveErrors(u32);

#[cfg(windows)]
impl QuietDriveErrors {
    fn set() -> Self {
        use windows_sys::Win32::System::Diagnostics::Debug::{
            SetThreadErrorMode, SEM_FAILCRITICALERRORS,
        };
        let mut previous = 0u32;
        // SAFETY: `previous` is a live u32 the call fills in; the flag is a documented one.
        unsafe { SetThreadErrorMode(SEM_FAILCRITICALERRORS, &mut previous) };
        Self(previous)
    }
}

#[cfg(windows)]
impl Drop for QuietDriveErrors {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Diagnostics::Debug::SetThreadErrorMode;
        // SAFETY: puts back exactly what `set` read out of the thread.
        unsafe { SetThreadErrorMode(self.0, std::ptr::null_mut()) };
    }
}

#[cfg(windows)]
fn volume_info(root: &str) -> (String, Option<u64>, Option<u64>) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetVolumeInformationW};

    let _quiet = QuietDriveErrors::set();
    let wide: Vec<u16> = std::ffi::OsStr::new(root)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut name = [0u16; 261];
    let mut label = String::from("Local Disk");
    // SAFETY: every pointer is to a live local buffer of the stated length; the nullable
    // out-params we do not need are null, as the API allows.
    let ok = unsafe {
        GetVolumeInformationW(
            wide.as_ptr(),
            name.as_mut_ptr(),
            name.len() as u32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    if ok != 0 {
        let end = name.iter().position(|&c| c == 0).unwrap_or(0);
        let s = String::from_utf16_lossy(&name[..end]);
        if !s.is_empty() {
            label = s;
        }
    }
    let (mut free, mut total) = (0u64, 0u64);
    // SAFETY: out-params point to live u64s; the caller-free-bytes param may be null.
    let sized =
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), std::ptr::null_mut(), &mut total, &mut free) };
    if sized == 0 {
        return (label, None, None);
    }
    (label, Some(total), Some(free))
}

/// The label (the mount point's last component; `/` gets the platform's name for it) and
/// `(total, free)` from `statvfs`. ⚠️ Free is what an ordinary user can write (`f_bavail`, df's
/// "Avail"), not the root-reserved total. A failed `statvfs` is logged and reads unknown
/// (`None` / `None`), never 0 / 0.
#[cfg(unix)]
fn volume_info(root: &str) -> (String, Option<u64>, Option<u64>) {
    let label = if root == "/" {
        root_label()
    } else {
        crate::core::places_unix::mount_leaf(root)
    };
    let (total, free) = match statvfs_sizes(root) {
        Ok((total, free)) => (Some(total), Some(free)),
        Err(e) => {
            log::warn!("drives: statvfs({root}) failed: {e}");
            (None, None)
        }
    };
    (label, total, free)
}

#[cfg(unix)]
fn statvfs_sizes(root: &str) -> std::io::Result<(u64, u64)> {
    let c = std::ffi::CString::new(root)?;
    // SAFETY: an all-zero `statvfs` is a valid value of a plain C struct; the call only writes
    // into it, and `c` is a live NUL-terminated string for the whole call.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: as above — both pointers are live for the call.
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // The field widths differ per OS (u32/c_ulong on macOS, u64 on Linux): widen first.
    #[allow(clippy::unnecessary_cast)]
    let (frsize, blocks, avail) = (st.f_frsize as u64, st.f_blocks as u64, st.f_bavail as u64);
    Ok((blocks.saturating_mul(frsize), avail.saturating_mul(frsize)))
}

/// What `/` is called on Linux: "File System".
#[cfg(target_os = "linux")]
fn root_label() -> String {
    crate::core::places_unix::LINUX_ROOT_LABEL.to_string()
}

/// What `/` is called on a Mac: the boot volume's own name, read from the `/Volumes` entry
/// that links back to `/` — ⛔ never the literal `Macintosh HD`.
#[cfg(target_os = "macos")]
fn root_label() -> String {
    use crate::core::places_unix::{mac_boot_volume_name, MAC_ROOT_FALLBACK_LABEL};
    // `read_link` only on what the directory listing itself says is a link (`d_type`, no
    // stat). Every other entry in /Volumes is a mount point, and `readlink` on one steps onto
    // that volume: on an SMB share that is macOS's "access files on a network volume" prompt,
    // which this loop could raise at every launch for anyone with a share mounted.
    let entries: Vec<(String, Option<PathBuf>)> = std::fs::read_dir("/Volumes")
        .map(|rd| {
            rd.flatten()
                .map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let is_link = e.file_type().is_ok_and(|t| t.is_symlink());
                    let target = if is_link {
                        std::fs::read_link(e.path()).ok()
                    } else {
                        None
                    };
                    (name, target)
                })
                .collect()
        })
        .unwrap_or_default();
    mac_boot_volume_name(&entries).unwrap_or_else(|| MAC_ROOT_FALLBACK_LABEL.to_string())
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn root_label() -> String {
    "/".to_string()
}

#[cfg(not(any(windows, unix)))]
fn volume_info(_root: &str) -> (String, Option<u64>, Option<u64>) {
    ("Local Disk".into(), None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn known_folders_lists_only_what_exists() {
        let dir = std::env::temp_dir().join(format!("trove-known-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Desktop")).unwrap();
        fs::create_dir_all(dir.join("Music")).unwrap();

        // no shell answer → USERPROFILE\<name>
        let keys: Vec<_> = known_folders_with(&dir, |_| None)
            .into_iter()
            .map(|f| f.key)
            .collect();
        assert_eq!(keys, ["desktop", "music"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_redirected_known_folder_wins_over_the_profile_path() {
        let dir = std::env::temp_dir().join(format!("trove-kfm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Documents")).unwrap();
        let moved = dir.join("OneDrive").join("Documents");
        fs::create_dir_all(&moved).unwrap();

        let redirected = moved.clone();
        let docs = known_folders_with(&dir, move |key| {
            (key == "documents").then(|| redirected.clone())
        })
        .into_iter()
        .find(|f| f.key == "documents")
        .expect("documents is listed");
        assert_eq!(docs.path, moved.to_string_lossy());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_init_script_carries_this_platforms_label() {
        let script = platform_init_script();
        assert!(script.starts_with("window.__TROVE_PLATFORM__ = Object.freeze({"));
        assert!(script.contains(&format!("\"thisPcLabel\":\"{THIS_PC_LABEL}\"")));
        assert!(script.contains(&format!("\"os\":\"{}\"", std::env::consts::OS)));
        assert!(script.contains(&format!(
            "\"channel\":\"{}\"",
            crate::core::channel::CURRENT.as_str()
        )));
        assert!(script.contains(&format!("\"updater\":{}", crate::core::channel::UPDATER)));
        #[cfg(windows)]
        assert_eq!(THIS_PC_LABEL, "This PC");
        #[cfg(target_os = "macos")]
        assert_eq!(THIS_PC_LABEL, "This Mac");
        #[cfg(target_os = "linux")]
        assert_eq!(THIS_PC_LABEL, "This Computer");
    }

    #[test]
    #[cfg(windows)]
    fn the_shell_knows_the_desktop() {
        let p = shell_known_folder("desktop").expect("the shell answers for Desktop");
        assert!(p.is_dir(), "{}", p.display());
        assert!(shell_known_folder("nope").is_none());
    }

    #[test]
    #[cfg(windows)]
    fn the_system_drive_is_listed_with_a_size() {
        let c = drives()
            .into_iter()
            .find(|d| d.path == "C:\\")
            .expect("C:\\ exists");
        let (total, free) = (c.total_bytes.expect("total"), c.free_bytes.expect("free"));
        assert!(total > 0);
        assert!(free <= total);
        assert!(!c.label.is_empty());
    }

    #[test]
    fn a_network_drive_is_never_asked_for_its_sizes() {
        use crate::core::places_unix::DriveRoot;
        let share = DriveRoot {
            path: "/Volumes/media".into(),
            network: true,
        };
        let d = describe(share, |root| panic!("volume_info was called for {root}"));
        assert_eq!(d.label, "media");
        assert_eq!((d.total_bytes, d.free_bytes), (None, None));
        assert!(d.network);
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["network"], serde_json::Value::Bool(true), "{v}");
    }

    /// A probe whose `N:\` is a dead share: it answers, but only after 3 s.
    fn slow_n(root: &str) -> (String, Option<u64>, Option<u64>) {
        if root == "N:\\" {
            std::thread::sleep(std::time::Duration::from_secs(3));
        }
        ("Disk".into(), Some(10), Some(4))
    }

    #[test]
    fn a_slow_drive_does_not_hold_up_the_others() {
        use crate::core::places_unix::DriveRoot;
        let roots = ["C:\\", "N:\\", "D:\\"].map(DriveRoot::local).to_vec();
        let started = std::time::Instant::now();
        let d = list_drives(roots, slow_n, std::time::Duration::from_millis(200));
        let took = started.elapsed();
        assert!(took < std::time::Duration::from_secs(1), "waited {took:?}");
        let paths: Vec<_> = d.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(paths, ["C:\\", "N:\\", "D:\\"]);
        assert_eq!((d[0].total_bytes, d[2].free_bytes), (Some(10), Some(4)));
        assert_eq!((d[1].total_bytes, d[1].free_bytes), (None, None));
        assert_eq!(d[1].label, unanswered_label("N:\\"));
        assert!(!d[1].network);
    }

    #[test]
    fn fast_drives_come_back_without_waiting_out_the_limit() {
        use crate::core::places_unix::DriveRoot;
        let roots = ["C:\\", "D:\\"].map(DriveRoot::local).to_vec();
        let started = std::time::Instant::now();
        let d = list_drives(roots, slow_n, std::time::Duration::from_secs(10));
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert!(d.len() == 2 && d.iter().all(|d| d.total_bytes == Some(10)));
    }

    #[test]
    fn a_drive_whose_probe_panics_is_dropped_and_the_rest_come_back_at_once() {
        use crate::core::places_unix::DriveRoot;
        fn panics_on_e(root: &str) -> (String, Option<u64>, Option<u64>) {
            assert_ne!(root, "E:\\", "a probe that panics");
            ("Disk".into(), None, None)
        }
        let roots = ["C:\\", "E:\\"].map(DriveRoot::local).to_vec();
        let started = std::time::Instant::now();
        let d = list_drives(roots, panics_on_e, std::time::Duration::from_secs(10));
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        let paths: Vec<_> = d.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(paths, ["C:\\"]);
    }

    #[test]
    fn a_local_drive_is_asked_once() {
        use crate::core::places_unix::DriveRoot;
        let mut asked = Vec::new();
        let d = describe(DriveRoot::local("/Volumes/Stick"), |root| {
            asked.push(root.to_string());
            ("Stick".into(), Some(10), Some(4))
        });
        assert_eq!(asked, ["/Volumes/Stick"]);
        assert_eq!(
            (d.total_bytes, d.free_bytes, d.network),
            (Some(10), Some(4), false)
        );
    }

    #[test]
    fn an_unknown_size_serialises_as_null_not_zero() {
        let d = DriveInfo {
            path: "/".into(),
            label: "File System".into(),
            total_bytes: None,
            free_bytes: None,
            network: false,
        };
        let v = serde_json::to_value(&d).unwrap();
        assert!(v["totalBytes"].is_null() && v["freeBytes"].is_null(), "{v}");
        let known = DriveInfo {
            total_bytes: Some(10),
            free_bytes: Some(4),
            ..d
        };
        let v = serde_json::to_value(&known).unwrap();
        assert_eq!(v["totalBytes"].as_u64(), Some(10));
        assert_eq!(v["freeBytes"].as_u64(), Some(4));
    }

    #[test]
    #[cfg(unix)]
    fn a_failed_statvfs_reads_unknown() {
        let (_, total, free) = volume_info("/definitely/not/a/mount");
        assert_eq!((total, free), (None, None));
    }
}

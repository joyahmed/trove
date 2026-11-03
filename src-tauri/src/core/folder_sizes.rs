//! Folder sizes for the list's Size column (plan 21 A): which kind of drive a folder is on, so
//! the frontend can leave network, removable and WSL folders blank, and a job that sizes many
//! folders on a few threads. No tauri types; the command layer wires the sink to an event.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::core::props::{self, Cap, FolderTotals};

/// At most this many folders are walked at once, across every job in the process: one disk
/// read by four threads is about as fast as it gets, and more only starves the listing.
pub const MAX_WALKS: usize = 4;

/// Where a folder lives, as far as counting its size goes. The frontend's setting decides
/// which kinds are counted (`state/folder-sizes.svelte.ts`).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DriveKind {
    /// a fixed disk or a RAM disk
    Local,
    /// a mapped drive, a `\\server\share`, an NFS / SMB mount
    Network,
    /// a USB stick, an SD card, a CD; a volume Windows cannot classify is put here too
    Removable,
    /// `\\wsl.localhost\…` / `\\wsl$\…`: a 9P walk is slow (plan 08 C)
    Wsl,
}

/// The kind of drive `path` is on. Reads the drive type only, never the folder itself.
pub fn drive_kind(path: &Path) -> DriveKind {
    let text = path.to_string_lossy().replace('/', "\\");
    if crate::core::wsl::is_wsl_path(&text) {
        return DriveKind::Wsl;
    }
    platform_kind(path)
}

/// GetDriveTypeW's answers (WinBase.h).
#[cfg(any(windows, test))]
mod drive_type {
    pub const REMOVABLE: u32 = 2;
    pub const FIXED: u32 = 3;
    pub const REMOTE: u32 = 4;
    pub const RAMDISK: u32 = 6;
}

/// A `GetDriveTypeW` answer as a kind. ⚠️ A USB hard disk says FIXED and so counts as local.
#[cfg(any(windows, test))]
fn kind_of_drive_type(t: u32) -> DriveKind {
    match t {
        drive_type::FIXED | drive_type::RAMDISK => DriveKind::Local,
        drive_type::REMOTE => DriveKind::Network,
        drive_type::REMOVABLE => DriveKind::Removable,
        // CD-ROM, unknown, no root
        _ => DriveKind::Removable,
    }
}

#[cfg(windows)]
fn platform_kind(path: &Path) -> DriveKind {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumePathNameW};
    let text = path.to_string_lossy();
    // a `\\server\share` is a share whatever GetVolumePathNameW makes of it; `\\?\C:\` is not
    if text.starts_with("\\\\") && !text.starts_with("\\\\?\\") {
        return DriveKind::Network;
    }
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let mut root = vec![0u16; wide.len() + 64];
    // SAFETY: `wide` is NUL-terminated and outlives the call; `root` holds the `root.len()`
    // UTF-16 units passed as its length.
    let ok = unsafe { GetVolumePathNameW(wide.as_ptr(), root.as_mut_ptr(), root.len() as u32) };
    if ok == 0 {
        return DriveKind::Removable;
    }
    // SAFETY: `root` is the NUL-terminated volume root just written.
    kind_of_drive_type(unsafe { GetDriveTypeW(root.as_ptr()) })
}

/// Off Windows: a network mount by the mount table, a stick under the usual mount folders.
#[cfg(not(windows))]
fn platform_kind(path: &Path) -> DriveKind {
    let table = crate::core::mounts::mount_table();
    if crate::core::mounts::network_share_of(path, &table).is_some() {
        return DriveKind::Network;
    }
    let removable = ["/Volumes", "/media", "/run/media", "/mnt"]
        .iter()
        .any(|root| path.starts_with(root) && path != Path::new(root));
    if removable {
        DriveKind::Removable
    } else {
        DriveKind::Local
    }
}

/// One folder's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderSize {
    pub path: String,
    pub bytes: u64,
    /// stopped at `Cap::LIST`: `bytes` is a floor
    pub capped: bool,
}

/// The process-wide limit on walks running at once (`MAX_WALKS`).
struct Permits {
    free: Mutex<usize>,
    freed: Condvar,
}

static PERMITS: Permits = Permits {
    free: Mutex::new(MAX_WALKS),
    freed: Condvar::new(),
};

/// Held while one folder is walked; gives the permit back when dropped.
struct Permit;

impl Drop for Permit {
    fn drop(&mut self) {
        *PERMITS.free.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        PERMITS.freed.notify_one();
    }
}

/// Waits for a free walk, looking at `cancel` every 50 ms; `None` once cancelled.
fn take_permit(cancel: &AtomicBool) -> Option<Permit> {
    let mut free = PERMITS.free.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        if *free > 0 {
            *free -= 1;
            return Some(Permit);
        }
        free = PERMITS
            .freed
            .wait_timeout(free, Duration::from_millis(50))
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
}

/// Size every folder in `paths`, on up to `MAX_WALKS` threads, handing each answer to `sink`
/// as it is known. Returns once every folder is done or `cancel` is set; a folder whose walk
/// was cancelled part-way is never handed over (a short number is not its size).
pub fn size_folders(
    paths: Vec<String>,
    cancel: &AtomicBool,
    cap: Cap,
    sink: &(dyn Fn(FolderSize) + Sync),
) {
    let protected = props::walk_skip_list();
    let queue = Mutex::new(paths.into_iter().collect::<VecDeque<_>>());
    let workers = MAX_WALKS.min(queue.lock().map(|q| q.len()).unwrap_or(0));
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let Some(path) = queue.lock().ok().and_then(|mut q| q.pop_front()) else {
                    return;
                };
                let Some(_permit) = take_permit(cancel) else {
                    return;
                };
                let t: FolderTotals = props::folder_size(Path::new(&path), cancel, cap, &protected);
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                sink(FolderSize {
                    path,
                    bytes: t.bytes,
                    capped: t.capped,
                });
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as stdfs;
    use std::path::PathBuf;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = stdfs::remove_dir_all(&self.0);
        }
    }

    fn scratch(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("trove-fsizes-{name}-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn strings(paths: &[PathBuf]) -> Vec<String> {
        paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }

    fn collect(paths: Vec<String>, cancel: &AtomicBool, cap: Cap) -> Vec<FolderSize> {
        let got = Mutex::new(Vec::new());
        size_folders(paths, cancel, cap, &|s| got.lock().unwrap().push(s));
        let mut got = got.into_inner().unwrap();
        got.sort_by(|a, b| a.path.cmp(&b.path));
        got
    }

    #[test]
    fn every_folder_is_sized_hidden_files_included() {
        let s = scratch("many");
        let mut dirs = Vec::new();
        for i in 0..6u8 {
            let d = s.0.join(format!("d{i}"));
            stdfs::create_dir_all(d.join("deep")).unwrap();
            stdfs::write(d.join("a.bin"), vec![1u8; usize::from(i) * 10]).unwrap();
            let hidden = d.join("deep").join(".hidden");
            stdfs::write(&hidden, b"12345").unwrap();
            // a dotfile on Unix; on Windows the hidden bit too, as Explorer's Properties counts it
            props::set_attributes(&hidden, None, Some(true)).unwrap();
            dirs.push(d);
        }
        let cancel = AtomicBool::new(false);
        let got = collect(strings(&dirs), &cancel, Cap::NONE);
        assert_eq!(got.len(), 6);
        for (i, g) in got.iter().enumerate() {
            assert_eq!(g.bytes, i as u64 * 10 + 5, "{}", g.path);
            assert!(!g.capped);
        }
    }

    #[test]
    fn a_folder_past_the_entry_cap_is_a_floor_marked_capped() {
        let s = scratch("cap");
        let big = s.0.join("big");
        stdfs::create_dir(&big).unwrap();
        for i in 0..50 {
            stdfs::write(big.join(format!("f{i}")), b"xx").unwrap();
        }
        let cancel = AtomicBool::new(false);
        let cap = Cap {
            entries: 10,
            time: Duration::MAX,
        };
        let got = collect(strings(std::slice::from_ref(&big)), &cancel, cap);
        assert_eq!(got.len(), 1);
        assert!(got[0].capped);
        assert_eq!(got[0].bytes, 20, "ten files of two bytes");
        // under the cap the same folder is exact
        let got = collect(strings(&[big]), &cancel, Cap::NONE);
        assert_eq!((got[0].bytes, got[0].capped), (100, false));
    }

    #[test]
    fn a_zero_time_cap_stops_at_once() {
        let s = scratch("timecap");
        stdfs::write(s.0.join("a"), b"123").unwrap();
        let cancel = AtomicBool::new(false);
        let cap = Cap {
            entries: u64::MAX,
            time: Duration::ZERO,
        };
        let got = collect(strings(std::slice::from_ref(&s.0)), &cancel, cap);
        assert_eq!((got[0].bytes, got[0].capped), (0, true));
    }

    /// A folder link: a symlink on Unix.
    #[cfg(unix)]
    fn link_dir(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    /// A folder link: a junction on Windows (no privilege needed, unlike a symlink).
    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success())
    }

    #[test]
    fn a_link_inside_is_never_followed_so_nothing_is_counted_twice_or_loops() {
        let s = scratch("links");
        let real = s.0.join("real");
        stdfs::create_dir(&real).unwrap();
        stdfs::write(real.join("big.bin"), vec![0u8; 1000]).unwrap();
        let outer = s.0.join("outer");
        stdfs::create_dir(&outer).unwrap();
        stdfs::write(outer.join("own.txt"), b"1234").unwrap();
        assert!(link_dir(&real, &outer.join("to-real")));
        // a link back to its own parent would loop forever if it were walked
        assert!(link_dir(&outer, &outer.join("loop")));
        let cancel = AtomicBool::new(false);
        let got = collect(strings(&[outer, real]), &cancel, Cap::NONE);
        // outer: own.txt only; real: big.bin. The 1000 bytes are counted once, in `real`.
        let bytes: Vec<u64> = got.iter().map(|g| g.bytes).collect();
        assert_eq!(bytes, vec![4, 1000]);
    }

    #[test]
    fn a_selected_link_is_sized_as_nothing() {
        let s = scratch("sellink");
        let real = s.0.join("real");
        stdfs::create_dir(&real).unwrap();
        stdfs::write(real.join("a.bin"), b"123456").unwrap();
        let link = s.0.join("link");
        assert!(link_dir(&real, &link));
        let cancel = AtomicBool::new(false);
        let got = collect(strings(&[link]), &cancel, Cap::NONE);
        assert_eq!(got[0].bytes, 0);
    }

    #[test]
    fn cancel_before_start_hands_nothing_over() {
        let s = scratch("cancel");
        let dirs: Vec<PathBuf> = (0..8).map(|i| s.0.join(format!("d{i}"))).collect();
        for d in &dirs {
            stdfs::create_dir(d).unwrap();
            stdfs::write(d.join("x"), b"x").unwrap();
        }
        let cancel = AtomicBool::new(true);
        assert!(collect(strings(&dirs), &cancel, Cap::NONE).is_empty());
    }

    #[test]
    fn cancel_mid_job_stops_the_rest() {
        let s = scratch("cancel-mid");
        let dirs: Vec<PathBuf> = (0..40).map(|i| s.0.join(format!("d{i:02}"))).collect();
        for d in &dirs {
            stdfs::create_dir(d).unwrap();
            stdfs::write(d.join("x"), b"x").unwrap();
        }
        let cancel = AtomicBool::new(false);
        let got = Mutex::new(0usize);
        size_folders(strings(&dirs), &cancel, Cap::NONE, &|_| {
            *got.lock().unwrap() += 1;
            cancel.store(true, Ordering::Relaxed);
        });
        let n = got.into_inner().unwrap();
        // the first answer cancels; the threads already mid-walk may finish theirs at most
        assert!((1..=MAX_WALKS).contains(&n), "{n} answers after cancel");
    }

    #[test]
    fn drive_types_map_to_kinds() {
        assert_eq!(kind_of_drive_type(drive_type::FIXED), DriveKind::Local);
        assert_eq!(kind_of_drive_type(drive_type::RAMDISK), DriveKind::Local);
        assert_eq!(kind_of_drive_type(drive_type::REMOTE), DriveKind::Network);
        assert_eq!(
            kind_of_drive_type(drive_type::REMOVABLE),
            DriveKind::Removable
        );
        assert_eq!(kind_of_drive_type(5), DriveKind::Removable);
        assert_eq!(kind_of_drive_type(0), DriveKind::Removable);
    }

    #[test]
    fn wsl_and_shares_are_told_apart_from_the_temp_folder() {
        assert_eq!(
            drive_kind(Path::new(r"\\wsl.localhost\Ubuntu\home\alex")),
            DriveKind::Wsl
        );
        assert_eq!(drive_kind(Path::new(r"\\wsl$\Ubuntu")), DriveKind::Wsl);
        #[cfg(windows)]
        assert_eq!(
            drive_kind(Path::new(r"\\server\share\docs")),
            DriveKind::Network
        );
        assert_eq!(drive_kind(&std::env::temp_dir()), DriveKind::Local);
    }
}

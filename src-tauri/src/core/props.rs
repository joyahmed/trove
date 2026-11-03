//! What the Properties panel shows: one item's name, type, sizes, three timestamps and its
//! attribute bits, the two bits the user may flip (read-only, hidden), and a folder's
//! contents counted in the background. No tauri types; the command layer wires the totals
//! sink to an event.

use std::fs::Metadata;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::core::search::is_reparse_point;
use crate::core::{icons, ops};

const FILE_ATTRIBUTE_READONLY: u32 = 0x1;
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
const FILE_ATTRIBUTE_ARCHIVE: u32 = 0x20;

/// Running totals are handed to the sink at most this often.
pub const TOTALS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Props {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    /// Explorer's Type line: the shell's name for the extension, "File folder" for a folder.
    pub type_name: String,
    /// File length; 0 for a folder (its contents are counted by `folder_totals`).
    pub size: u64,
    /// Allocated on disk (compressed / sparse aware); 0 for a folder.
    pub size_on_disk: u64,
    pub created_ms: Option<u64>,
    pub modified_ms: Option<u64>,
    pub accessed_ms: Option<u64>,
    pub read_only: bool,
    pub hidden: bool,
    pub system: bool,
    pub archive: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderTotals {
    pub files: u64,
    pub folders: u64,
    pub bytes: u64,
    pub size_on_disk: u64,
    /// Folders counted as one item but not walked, so their bytes are NOT in `bytes`: on a
    /// Mac, a media library package and the privacy-protected folders (`walk_skips`). The
    /// pane says "size not counted" for them instead of showing a short number as the truth.
    pub not_counted: u64,
    /// The walk stopped at its `Cap` (too many entries, or too long), so `bytes` is a floor:
    /// the list's Size column says "≥ 12.3 GB". Never set by the Properties count.
    pub capped: bool,
}

/// Where a walk gives up. The Properties panel counts to the end (`Cap::NONE`); the list's
/// Size column stops a folder at `Cap::LIST`, so one huge folder does not hold a worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cap {
    pub entries: u64,
    pub time: Duration,
}

impl Cap {
    pub const NONE: Cap = Cap {
        entries: u64::MAX,
        time: Duration::MAX,
    };
    /// 1,000,000 entries or 10 s per folder, whichever comes first.
    pub const LIST: Cap = Cap {
        entries: 1_000_000,
        time: Duration::from_secs(10),
    };
}

/// How many entries pass between two clock reads of the time cap.
const CAP_CLOCK_EVERY: u64 = 256;

/// A Mac's media libraries: one thing to the person, and reading inside one raises the Photos /
/// Music privacy prompt that blocks the read until answered (the Gallery froze on it, on a Mac,
/// 16a32d4). The same names as the Gallery's `PACKAGE_EXTS` (core/gallery.rs), the library
/// half only: an `.app` or `.bundle` is still sized (/System/Applications' 1.2 GB).
pub(crate) const LIBRARY_EXTS: [&str; 7] = [
    "photoslibrary",
    "photolibrary",
    "migratedphotolibrary",
    "aplibrary",
    "musiclibrary",
    "tvlibrary",
    "imovielibrary",
];

/// The privacy-protected folders under a Mac home: `~/Music`, `~/Movies/TV`, `~/Library` (the
/// Gallery's `protected_dirs`). Empty off a Mac and when there is no home.
fn protected_dirs(home: Option<&Path>, macos: bool) -> Vec<std::path::PathBuf> {
    match home {
        Some(home) if macos => vec![
            home.join("Music"),
            home.join("Movies").join("TV"),
            home.join("Library"),
        ],
        _ => Vec::new(),
    }
}

/// Whether the size walk must not go into this folder (see `FolderTotals::not_counted`).
/// `protected` holds the network mount points on every OS, and the privacy folders on a Mac.
fn walk_skips(path: &Path, protected: &[std::path::PathBuf], macos: bool) -> bool {
    if protected.iter().any(|p| p == path) {
        return true;
    }
    if !macos {
        return false;
    }
    let is_library = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .is_some_and(|e| LIBRARY_EXTS.contains(&e.as_str()));
    is_library
}

/// Everything the panel shows for one item, from one `metadata` call plus the shell's type
/// name and the on-disk size.
pub fn props(path: &Path) -> io::Result<Props> {
    let meta = std::fs::symlink_metadata(path)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    // a link to a folder is a folder, as the listing says (`fs::entry_from`); not followed
    let is_dir = meta.is_dir()
        || ops::is_dir_link(&meta)
        || (!cfg!(windows)
            && meta.file_type().is_symlink()
            && std::fs::metadata(path).is_ok_and(|m| m.is_dir()));
    let ext = if is_dir {
        None
    } else {
        path.extension().map(|e| e.to_string_lossy().to_lowercase())
    };
    let attrs = attributes(path, &meta);
    let size = if is_dir { 0 } else { meta.len() };
    let type_name = if is_dir {
        crate::core::fs::dir_type_name(&name).into()
    } else {
        icons::type_name(ext.as_deref())
    };
    Ok(Props {
        path: path.to_string_lossy().into_owned(),
        name,
        is_dir,
        type_name,
        size,
        size_on_disk: if is_dir { 0 } else { size_on_disk(path, size) },
        created_ms: meta.created().ok().and_then(to_ms),
        modified_ms: meta.modified().ok().and_then(to_ms),
        accessed_ms: meta.accessed().ok().and_then(to_ms),
        read_only: attrs & FILE_ATTRIBUTE_READONLY != 0,
        hidden: attrs & FILE_ATTRIBUTE_HIDDEN != 0,
        system: attrs & FILE_ATTRIBUTE_SYSTEM != 0,
        archive: attrs & FILE_ATTRIBUTE_ARCHIVE != 0,
    })
}

/// Flip only the bits that are given; the rest of the attribute word is kept as is.
pub fn set_attributes(
    path: &Path,
    read_only: Option<bool>,
    hidden: Option<bool>,
) -> io::Result<()> {
    let current = attributes(path, &std::fs::symlink_metadata(path)?);
    let mut next = current;
    if let Some(ro) = read_only {
        next = set_bit(next, FILE_ATTRIBUTE_READONLY, ro);
    }
    if let Some(h) = hidden {
        next = set_bit(next, FILE_ATTRIBUTE_HIDDEN, h);
    }
    if next == current {
        return Ok(());
    }
    write_attributes(path, next)
}

/// Count a folder's contents. The sink sees the running totals at most every
/// `TOTALS_INTERVAL`; the final figure is returned (and is also the last thing the sink saw
/// only if the caller sends it — the command layer does). Per-entry errors are skipped and
/// `cancel` is checked per entry. A link inside the folder counts once, as a folder when it
/// points at one and as a file otherwise (broken included), so the total matches the rows the
/// list shows; links and reparse points are never walked into.
pub fn folder_totals(
    root: &Path,
    cancel: &AtomicBool,
    sink: &mut dyn FnMut(&FolderTotals),
) -> FolderTotals {
    let macos = cfg!(target_os = "macos");
    let protected = walk_skip_list();
    folder_totals_skipping(
        root,
        cancel,
        TOTALS_INTERVAL,
        Cap::NONE,
        &protected,
        macos,
        sink,
    )
}

/// The folders a walk counts once and never enters, read once so a job sizing many folders
/// asks the mount table once rather than per folder.
pub fn walk_skip_list() -> Vec<std::path::PathBuf> {
    let macos = cfg!(target_os = "macos");
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let mut protected = protected_dirs(home.as_deref(), macos);
    // ⛔ and every privacy-guarded folder the person has not opened yet (Desktop, Documents,
    // Downloads...): a Size column over the home folder must not walk into one and raise its
    // prompt before the person has asked for it (`core/privacy_folders.rs`). Empty off a Mac.
    protected.extend(crate::core::privacy_folders::unopened());
    // ⛔ a network share inside the folder is not walked either (`core/mounts.rs`): sizing `/`
    // or a folder with a share mounted in it must not raise macOS's network-volume prompt
    protected.extend(crate::core::mounts::network_mount_points());
    protected
}

/// One folder's totals for the list's Size column: the same walk as `folder_totals` (links and
/// junctions never entered, hidden and system files counted), no running totals, stopped at
/// `cap` with `capped` set. `protected` is `walk_skip_list()`, read once by the caller.
pub fn folder_size(
    root: &Path,
    cancel: &AtomicBool,
    cap: Cap,
    protected: &[std::path::PathBuf],
) -> FolderTotals {
    let macos = cfg!(target_os = "macos");
    folder_totals_skipping(
        root,
        cancel,
        Duration::MAX,
        cap,
        protected,
        macos,
        &mut |_| {},
    )
}

/// `folder_totals` with the sink interval as a parameter, so a test can watch every step.
#[cfg(test)]
pub fn folder_totals_every(
    root: &Path,
    cancel: &AtomicBool,
    interval: Duration,
    sink: &mut dyn FnMut(&FolderTotals),
) -> FolderTotals {
    folder_totals_skipping(root, cancel, interval, Cap::NONE, &[], false, sink)
}

/// The walk itself. With `macos`, a media library or a `protected` folder is counted as one
/// folder and never entered (the selected folder itself included: selecting ~/Library must not
/// raise the prompt either), and `not_counted` says how many. Past `cap` the walk stops and
/// says `capped`.
fn folder_totals_skipping(
    root: &Path,
    cancel: &AtomicBool,
    interval: Duration,
    cap: Cap,
    protected: &[std::path::PathBuf],
    macos: bool,
    sink: &mut dyn FnMut(&FolderTotals),
) -> FolderTotals {
    let mut totals = FolderTotals::default();
    if walk_skips(root, protected, macos) {
        totals.not_counted = 1;
        return totals;
    }
    // a selected link is not walked (walkdir follows a link given as the start path): it counts
    // for nothing, as in Explorer's Properties
    if std::fs::symlink_metadata(root).is_ok_and(|m| m.file_type().is_symlink()) {
        return totals;
    }
    let started = Instant::now();
    let mut last = started;
    let mut seen: u64 = 0;
    let mut walker = walkdir::WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .into_iter();
    while let Some(entry) = walker.next() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if seen >= cap.entries
            || (seen.is_multiple_of(CAP_CLOCK_EVERY) && started.elapsed() >= cap.time)
        {
            totals.capped = true;
            break;
        }
        seen += 1;
        let Ok(entry) = entry else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        match kind_of(entry.path(), &meta) {
            Counted::Folder if walk_skips(entry.path(), protected, macos) => {
                totals.folders += 1;
                totals.not_counted += 1;
                walker.skip_current_dir();
                continue;
            }
            Counted::Folder => totals.folders += 1,
            Counted::File => {
                let size = meta.len();
                totals.files += 1;
                totals.bytes += size;
                totals.size_on_disk += size_on_disk(entry.path(), size);
            }
            Counted::Link { to_folder } => {
                // every row the list shows is counted, so the total adds up to the list; a
                // link's target is not added (it lives elsewhere, and may be counted already)
                if to_folder {
                    totals.folders += 1;
                } else {
                    totals.files += 1;
                }
            }
        }
        // never walk into a link or other reparse point (loops, other volumes, cloud stubs)
        if meta.is_dir() && is_reparse_point(Some(&meta)) {
            walker.skip_current_dir();
        }
        if last.elapsed() >= interval {
            sink(&totals);
            last = Instant::now();
        }
    }
    totals
}

/// How one entry of a counted folder adds to the totals.
enum Counted {
    File,
    Folder,
    /// A symlink or junction: a folder if its target is one, else a file (a broken link too).
    Link {
        to_folder: bool,
    },
}

fn kind_of(path: &Path, meta: &Metadata) -> Counted {
    if meta.file_type().is_symlink() {
        let to_folder = ops::is_dir_link(meta) || std::fs::metadata(path).is_ok_and(|m| m.is_dir());
        Counted::Link { to_folder }
    } else if meta.is_dir() {
        Counted::Folder
    } else {
        Counted::File
    }
}

fn to_ms(t: SystemTime) -> Option<u64> {
    let d = t.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(d.as_millis()).ok()
}

fn set_bit(word: u32, bit: u32, on: bool) -> u32 {
    if on {
        word | bit
    } else {
        word & !bit
    }
}

#[cfg(windows)]
fn attributes(_path: &Path, meta: &Metadata) -> u32 {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes()
}

/// Off Windows the one bit is "may I write it": `access(W_OK)` for the current user, which
/// counts owner / group / other, root, ACLs and a read-only mount. ⛔ Not
/// `permissions().readonly()`, which is "no write bit for anyone" and ignores who is asking.
#[cfg(not(windows))]
fn attributes(path: &Path, _meta: &Metadata) -> u32 {
    if writable_by_me(path) {
        0
    } else {
        FILE_ATTRIBUTE_READONLY
    }
}

#[cfg(not(windows))]
fn writable_by_me(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `c` is a NUL-terminated path that outlives the call; access reads it only.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(windows)]
fn write_attributes(path: &Path, attrs: u32) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::SetFileAttributesW;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call; `attrs` is a
    // plain attribute word. The function reads the string and touches nothing else of ours.
    let ok = unsafe { SetFileAttributesW(wide.as_ptr(), attrs) };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Lock: drop every write bit. Unlock: give the owner write back, and nothing more. ⛔ Not
/// `set_readonly(false)`, which on Unix sets all three write bits (a world-writable 0o777).
#[cfg(not(windows))]
fn write_attributes(path: &Path, attrs: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(path)?.permissions().mode();
    let next = if attrs & FILE_ATTRIBUTE_READONLY != 0 {
        mode & !0o222
    } else {
        mode | 0o200
    };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(next))
}

/// Bytes allocated for a file: what Explorer calls "Size on disk". The raw allocation from
/// `GetCompressedFileSizeW` (the real footprint of compressed and sparse files) is rounded up to
/// the volume's cluster size; a raw 0 stays 0 (tiny files live in the MFT and Explorer shows 0).
/// Falls back to `len` when the call fails.
#[cfg(windows)]
fn size_on_disk(path: &Path, len: u64) -> u64 {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{GetLastError, NO_ERROR};
    use windows_sys::Win32::Storage::FileSystem::{GetCompressedFileSizeW, INVALID_FILE_SIZE};

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut high: u32 = 0;
    // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call and `high` is a
    // valid out-pointer for the upper 32 bits; the function writes only there.
    let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
    // SAFETY: reading the thread's last-error value has no preconditions.
    if low == INVALID_FILE_SIZE && unsafe { GetLastError() } != NO_ERROR {
        return len;
    }
    let raw = (u64::from(high) << 32) | u64::from(low);
    round_up_to_cluster(raw, cluster_bytes(&wide))
}

/// `raw` rounded up to a whole number of clusters; 0 stays 0 and an unknown cluster (0) leaves
/// `raw` as is.
#[cfg(any(windows, test))]
fn round_up_to_cluster(raw: u64, cluster: u64) -> u64 {
    if raw == 0 || cluster == 0 {
        return raw;
    }
    raw.div_ceil(cluster).saturating_mul(cluster)
}

/// Cluster size per volume root, so a folder walk asks the drive once, not once per file.
#[cfg(windows)]
static CLUSTER_CACHE: std::sync::Mutex<Option<std::collections::HashMap<Vec<u16>, u64>>> =
    std::sync::Mutex::new(None);

/// How many times the drive was actually asked (cache misses). Read by the tests.
#[cfg(windows)]
static CLUSTER_LOOKUPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Cluster size of the volume holding `wide_path` (NUL-terminated UTF-16); 0 when unknown.
#[cfg(windows)]
fn cluster_bytes(wide_path: &[u16]) -> u64 {
    use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceW, GetVolumePathNameW};

    let mut root = vec![0u16; 1024];
    // SAFETY: `wide_path` is NUL-terminated and `root` is a writable buffer of the length given.
    let ok =
        unsafe { GetVolumePathNameW(wide_path.as_ptr(), root.as_mut_ptr(), root.len() as u32) };
    if ok == 0 {
        return 0;
    }
    let end = root.iter().position(|&c| c == 0).unwrap_or(root.len());
    root.truncate(end + 1);
    let mut cache = CLUSTER_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let map = cache.get_or_insert_with(Default::default);
    if let Some(&c) = map.get(&root) {
        return c;
    }
    CLUSTER_LOOKUPS.fetch_add(1, Ordering::Relaxed);
    let (mut spc, mut bps, mut free, mut total) = (0u32, 0u32, 0u32, 0u32);
    // SAFETY: `root` is a NUL-terminated volume root and the four out-pointers are valid u32s.
    let ok = unsafe { GetDiskFreeSpaceW(root.as_ptr(), &mut spc, &mut bps, &mut free, &mut total) };
    let cluster = if ok == 0 {
        0
    } else {
        u64::from(spc) * u64::from(bps)
    };
    map.insert(root, cluster);
    cluster
}

#[cfg(all(not(windows), unix))]
fn size_on_disk(path: &Path, len: u64) -> u64 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).map_or(len, |m| m.blocks() * 512)
}

#[cfg(all(not(windows), not(unix)))]
fn size_on_disk(_path: &Path, len: u64) -> u64 {
    len
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
        let dir = std::env::temp_dir().join(format!("trove-props-{name}-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    #[test]
    fn a_file_reports_size_type_times_and_clear_flags() {
        let s = scratch("file");
        let path = s.0.join("notes.txt");
        stdfs::write(&path, b"hello world").unwrap();
        let p = props(&path).unwrap();
        assert_eq!(p.name, "notes.txt");
        assert!(!p.is_dir);
        assert_eq!(p.size, 11);
        assert!(p.size_on_disk >= 11 || p.size_on_disk == 0);
        assert!(!p.type_name.is_empty());
        assert!(p.created_ms.is_some());
        assert!(p.modified_ms.is_some());
        assert!(!p.read_only);
        assert!(!p.hidden);
        assert!(!p.system);
    }

    #[test]
    fn rounding_goes_up_to_the_cluster_and_keeps_zero() {
        assert_eq!(round_up_to_cluster(0, 4096), 0);
        assert_eq!(round_up_to_cluster(1, 4096), 4096);
        assert_eq!(round_up_to_cluster(4096, 4096), 4096);
        assert_eq!(round_up_to_cluster(5000, 4096), 8192);
        assert_eq!(round_up_to_cluster(5000, 0), 5000);
    }

    #[cfg(windows)]
    fn real_cluster(path: &Path) -> u64 {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        cluster_bytes(&wide)
    }

    #[cfg(windows)]
    #[test]
    fn size_on_disk_is_a_whole_number_of_clusters() {
        let s = scratch("sod");
        let cluster = real_cluster(&s.0);
        assert!(cluster >= 512);
        let tiny = s.0.join("tiny.bin");
        stdfs::write(&tiny, b"x").unwrap();
        let t = size_on_disk(&tiny, 1);
        assert!(
            t == 0 || t.is_multiple_of(cluster),
            "tiny {t} cluster {cluster}"
        );
        let mid = s.0.join("mid.bin");
        stdfs::write(&mid, vec![7u8; 5000]).unwrap();
        let m = size_on_disk(&mid, 5000);
        assert!(m.is_multiple_of(cluster));
        assert!(m >= 5000);
        assert_eq!(m, 5000u64.div_ceil(cluster) * cluster);
        if cluster == 4096 {
            assert!(m >= 8192);
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_drive_is_asked_once_per_volume() {
        let s = scratch("sodcache");
        for i in 0..20 {
            stdfs::write(s.0.join(format!("f{i}")), vec![1u8; 100]).unwrap();
        }
        let _ = size_on_disk(&s.0.join("f0"), 100); // warm this volume
        let before = CLUSTER_LOOKUPS.load(Ordering::Relaxed);
        for i in 0..20 {
            let _ = size_on_disk(&s.0.join(format!("f{i}")), 100);
        }
        assert_eq!(CLUSTER_LOOKUPS.load(Ordering::Relaxed), before);
    }

    #[test]
    fn a_folder_is_a_file_folder_with_no_size() {
        let s = scratch("dir");
        let p = props(&s.0).unwrap();
        assert!(p.is_dir);
        assert_eq!(p.type_name, crate::core::fs::FOLDER_TYPE);
        assert_eq!(p.size, 0);
        assert_eq!(p.size_on_disk, 0);
    }

    #[test]
    fn an_app_folder_is_an_application_on_a_mac_as_in_the_listing() {
        let s = scratch("app");
        let app = s.0.join("Calculator.app");
        stdfs::create_dir(&app).unwrap();
        let p = props(&app).unwrap();
        assert!(p.is_dir);
        let want = if cfg!(target_os = "macos") {
            "Application"
        } else {
            crate::core::fs::FOLDER_TYPE
        };
        assert_eq!(p.type_name, want);
    }

    #[test]
    fn a_link_to_a_folder_is_a_folder_with_no_size() {
        let s = scratch("props-link");
        let real = s.0.join("real");
        stdfs::create_dir(&real).unwrap();
        let link = s.0.join("linked");
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .unwrap()
            .status
            .success());
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let p = props(&link).unwrap();
        assert!(p.is_dir);
        assert_eq!(p.type_name, crate::core::fs::FOLDER_TYPE);
        assert_eq!(p.size, 0);
    }

    #[test]
    fn read_only_round_trips() {
        let s = scratch("ro");
        let path = s.0.join("a.txt");
        stdfs::write(&path, b"x").unwrap();
        set_attributes(&path, Some(true), None).unwrap();
        // root may write a locked file, so off Windows the locked read holds for a normal user
        #[cfg(unix)]
        // SAFETY: geteuid has no preconditions.
        let root = unsafe { libc::geteuid() } == 0;
        #[cfg(not(unix))]
        let root = false;
        assert!(root || props(&path).unwrap().read_only);
        set_attributes(&path, Some(false), None).unwrap();
        assert!(!props(&path).unwrap().read_only);
    }

    /// the Mac: ~/.cocoapods, drwxr-xr-x and hers, read "Locked (read-only)". Writable by
    /// the owner is not read-only, for a folder and a file; no write bit for us is.
    #[cfg(unix)]
    #[test]
    fn read_only_is_whether_the_current_user_may_write() {
        use std::os::unix::fs::PermissionsExt;
        let s = scratch("ro-unix");
        let dir = s.0.join("pods");
        stdfs::create_dir(&dir).unwrap();
        stdfs::set_permissions(&dir, stdfs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            !props(&dir).unwrap().read_only,
            "a 755 folder I own is writable"
        );
        let file = s.0.join("a.txt");
        stdfs::write(&file, b"x").unwrap();
        stdfs::set_permissions(&file, stdfs::Permissions::from_mode(0o644)).unwrap();
        assert!(!props(&file).unwrap().read_only);
        // root may write anything, so the locked half only holds for a normal user
        // SAFETY: geteuid has no preconditions.
        if unsafe { libc::geteuid() } != 0 {
            stdfs::set_permissions(&dir, stdfs::Permissions::from_mode(0o555)).unwrap();
            assert!(props(&dir).unwrap().read_only);
            stdfs::set_permissions(&dir, stdfs::Permissions::from_mode(0o755)).unwrap();
            // a write bit for the group only: someone may write, but not me (the owner's bits
            // rule). `permissions().readonly()` said writable here.
            stdfs::set_permissions(&file, stdfs::Permissions::from_mode(0o464)).unwrap();
            assert!(props(&file).unwrap().read_only);
        }
    }

    /// Unlocking gives the owner write back and nothing more: 644 → 444 → 644, never 666/777.
    #[cfg(unix)]
    #[test]
    fn unlock_does_not_make_a_file_world_writable() {
        use std::os::unix::fs::PermissionsExt;
        let s = scratch("ro-mode");
        let file = s.0.join("a.txt");
        stdfs::write(&file, b"x").unwrap();
        stdfs::set_permissions(&file, stdfs::Permissions::from_mode(0o644)).unwrap();
        set_attributes(&file, Some(true), None).unwrap();
        assert_eq!(
            stdfs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o444
        );
        set_attributes(&file, Some(false), None).unwrap();
        assert_eq!(
            stdfs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    #[cfg(windows)]
    #[test]
    fn hidden_is_set_without_touching_read_only() {
        let s = scratch("hidden");
        let path = s.0.join("b.txt");
        stdfs::write(&path, b"x").unwrap();
        set_attributes(&path, Some(true), None).unwrap();
        set_attributes(&path, None, Some(true)).unwrap();
        let p = props(&path).unwrap();
        assert!(p.hidden);
        assert!(p.read_only);
        set_attributes(&path, Some(false), Some(false)).unwrap();
        let p = props(&path).unwrap();
        assert!(!p.hidden && !p.read_only);
    }

    #[test]
    fn missing_path_is_an_error() {
        let s = scratch("missing");
        assert!(props(&s.0.join("nope")).is_err());
        assert!(set_attributes(&s.0.join("nope"), Some(true), None).is_err());
    }

    #[test]
    fn folder_totals_count_files_folders_and_bytes() {
        let s = scratch("totals");
        stdfs::create_dir_all(s.0.join("a").join("b")).unwrap();
        stdfs::write(s.0.join("one.txt"), b"1234").unwrap();
        stdfs::write(s.0.join("a").join("two.txt"), b"56").unwrap();
        stdfs::write(s.0.join("a").join("b").join("three.txt"), b"789").unwrap();
        let cancel = AtomicBool::new(false);
        let mut seen = 0;
        let totals = folder_totals_every(&s.0, &cancel, Duration::ZERO, &mut |_| seen += 1);
        assert_eq!(totals.files, 3);
        assert_eq!(totals.folders, 2);
        assert_eq!(totals.bytes, 9);
        assert!(totals.size_on_disk >= 9 || totals.size_on_disk == 0);
        assert!(seen >= 1);
    }

    #[test]
    fn a_selected_folder_link_counts_as_nothing() {
        let s = scratch("totals-link");
        let real = s.0.join("real");
        stdfs::create_dir(&real).unwrap();
        stdfs::write(real.join("big.bin"), b"123456").unwrap();
        let link = s.0.join("linked");
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .unwrap()
            .status
            .success());
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let cancel = AtomicBool::new(false);
        let totals = folder_totals_every(&link, &cancel, Duration::ZERO, &mut |_| {});
        assert_eq!((totals.files, totals.folders, totals.bytes), (0, 0, 0));
    }

    /// A file link; `false` when this box may not make one (Windows without the privilege).
    fn link_file(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(target, link);
        made.is_ok()
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
    fn links_inside_count_as_what_they_point_at_and_are_not_walked() {
        // the Mac folder: 12 rows, 2 of them links, said "9 files, 1 folder"
        let s = scratch("totals-links");
        let outside = scratch("totals-links-target");
        stdfs::create_dir(outside.0.join("deep")).unwrap();
        stdfs::write(outside.0.join("deep").join("big.bin"), b"123456789").unwrap();
        stdfs::write(outside.0.join("far.txt"), b"12345").unwrap();
        stdfs::write(s.0.join("one.txt"), b"1234").unwrap();
        stdfs::create_dir(s.0.join("sub")).unwrap();
        assert!(link_dir(&outside.0.join("deep"), &s.0.join("to-folder")));
        // a link back to the counted folder itself would loop if it were walked
        assert!(link_dir(&s.0, &s.0.join("sub").join("loop")));
        let cancel = AtomicBool::new(false);
        if !link_file(&outside.0.join("far.txt"), &s.0.join("to-file")) {
            eprintln!("skipped the file-link half: this box may not create file symlinks");
            let t = folder_totals_every(&s.0, &cancel, Duration::ZERO, &mut |_| {});
            // files: one.txt; folders: sub, to-folder, sub/loop
            assert_eq!((t.files, t.folders, t.bytes), (1, 3, 4));
            return;
        }
        assert!(link_file(&outside.0.join("gone.txt"), &s.0.join("broken")));
        let t = folder_totals_every(&s.0, &cancel, Duration::ZERO, &mut |_| {});
        // files: one.txt, to-file, broken; folders: sub, to-folder, sub/loop. The targets'
        // bytes (9 and 5) are not added: only one.txt's 4.
        assert_eq!((t.files, t.folders, t.bytes), (3, 3, 4));
    }

    #[test]
    fn a_mac_walk_counts_a_library_and_a_protected_folder_once_and_never_enters_them() {
        let s = scratch("totals-skip");
        let home = s.0.join("home");
        stdfs::create_dir_all(home.join("Library").join("Caches")).unwrap();
        stdfs::write(home.join("Library").join("Caches").join("c.bin"), b"123").unwrap();
        let lib = home.join("Pictures").join("Photos Library.photoslibrary");
        stdfs::create_dir_all(lib.join("originals")).unwrap();
        stdfs::write(lib.join("originals").join("p.jpg"), b"12345").unwrap();
        let app = home.join("Applications").join("Calc.app");
        stdfs::create_dir_all(&app).unwrap();
        stdfs::write(app.join("bin"), b"1234567").unwrap();
        stdfs::write(home.join("a.txt"), b"12").unwrap();
        let protected = protected_dirs(Some(&home), true);
        let cancel = AtomicBool::new(false);
        let t = folder_totals_skipping(
            &home,
            &cancel,
            Duration::ZERO,
            Cap::NONE,
            &protected,
            true,
            &mut |_| {},
        );
        // files: a.txt and Calc.app/bin (an .app is still sized); folders: Library, Pictures,
        // the library, Applications, Calc.app. Not entered: Library/Caches, the library's inside.
        assert_eq!((t.files, t.folders, t.bytes, t.not_counted), (2, 5, 9, 2));
        // selecting ~/Library itself does not walk it either
        let t = folder_totals_skipping(
            &home.join("Library"),
            &cancel,
            Duration::ZERO,
            Cap::NONE,
            &protected,
            true,
            &mut |_| {},
        );
        assert_eq!((t.files, t.folders, t.not_counted), (0, 0, 1));
        // off a Mac nothing is skipped
        let t = folder_totals_skipping(
            &home,
            &cancel,
            Duration::ZERO,
            Cap::NONE,
            &[],
            false,
            &mut |_| {},
        );
        assert_eq!((t.files, t.not_counted), (4, 0));
    }

    #[test]
    fn a_network_share_inside_the_folder_is_counted_once_and_never_entered() {
        let s = scratch("totals-net");
        let share = s.0.join("nas");
        stdfs::create_dir_all(share.join("deep")).unwrap();
        stdfs::write(share.join("deep").join("big.bin"), b"123456").unwrap();
        stdfs::write(s.0.join("a.txt"), b"12").unwrap();
        let cancel = AtomicBool::new(false);
        // off a Mac too: a dead NFS server must not hang the walk
        let t = folder_totals_skipping(
            &s.0,
            &cancel,
            Duration::ZERO,
            Cap::NONE,
            std::slice::from_ref(&share),
            false,
            &mut |_| {},
        );
        assert_eq!((t.files, t.folders, t.bytes, t.not_counted), (1, 1, 2, 1));
    }

    #[test]
    fn cancel_stops_the_count_early() {
        let s = scratch("cancel");
        for i in 0..40 {
            stdfs::write(s.0.join(format!("f{i}.txt")), b"x").unwrap();
        }
        let cancel = AtomicBool::new(false);
        let mut sink = |_: &FolderTotals| cancel.store(true, Ordering::Relaxed);
        let totals = folder_totals_every(&s.0, &cancel, Duration::ZERO, &mut sink);
        assert!(totals.files < 40, "{}", totals.files);
        assert!(totals.files >= 1);
    }
}

//! Whether a drop stays on one volume — a move there is a rename — decided from what the OS
//! says about the device, not from the drive list. The list leaves things out on purpose (a
//! Mac disk image under `/Volumes`, any Linux mount the sidebar hides), and a path it does not
//! claim used to count as "the root volume", so a drop onto a disk image moved the file.
//!
//! Unix compares `st_dev`; Windows compares the volume root `GetVolumePathNameW` names. A
//! dragged entry is judged where it LIVES (its own entry, a symlink not followed: a move renames
//! the link), the target folder where it really is (links followed: the files land there).
//! Anything that cannot be read answers "not the same", which makes the drop a copy — the
//! choice that never loses the original.

use std::path::Path;

/// Every source sits on the volume of `target`. False on no sources or on any error.
pub fn same_volume<S: AsRef<Path>>(sources: &[S], target: &Path) -> bool {
    let Some(goal) = folder_volume(target) else {
        return false;
    };
    !sources.is_empty()
        && sources
            .iter()
            .all(|s| entry_volume(s.as_ref()).is_some_and(|v| v == goal))
}

/// The device an entry is on, the entry itself, not what a symlink points at.
#[cfg(unix)]
fn entry_volume(path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path).ok().map(|m| m.dev())
}

/// The device the folder's contents are on, links followed.
#[cfg(unix)]
fn folder_volume(path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| m.dev())
}

/// An entry lives in its parent folder: that folder's real place names its volume (a link or
/// junction as the entry itself stays where it is). A drive root is its own volume.
#[cfg(windows)]
fn entry_volume(path: &Path) -> Option<String> {
    std::fs::symlink_metadata(path).ok()?;
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => folder_volume(parent),
        _ => folder_volume(path),
    }
}

/// The volume root (`\\?\C:\`, `\\?\C:\mnt\usb\`, `\\?\UNC\server\share\`) of where the
/// folder really is, case folded. `canonicalize` follows junctions, symlinks and `subst`.
#[cfg(windows)]
fn folder_volume(path: &Path) -> Option<String> {
    use windows_sys::Win32::Storage::FileSystem::GetVolumePathNameW;
    let real = std::fs::canonicalize(path).ok()?;
    let wide: Vec<u16> = real
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // the root is never longer than the path plus a trailing `\`
    let mut buf = vec![0u16; wide.len() + 64];
    // SAFETY: `wide` is NUL-terminated and outlives the call; `buf` holds the `buf.len()`
    // UTF-16 units passed as its length.
    let ok = unsafe { GetVolumePathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
    if ok == 0 {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]).to_lowercase())
}

/// The room left on the volume that really holds a folder, and where that volume is mounted —
/// for the status bar. The drive list cannot answer it: it leaves a Mac disk image and hidden
/// Linux mounts out, and a folder there used to show the boot disk's free space.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSpace {
    pub free_bytes: u64,
    pub mount_root: String,
}

/// `None` when the folder or its volume cannot be read. On Windows always `None`: the drive
/// list names every letter, and the status bar keeps answering from it there.
pub fn folder_space(dir: &Path) -> Option<FolderSpace> {
    #[cfg(unix)]
    {
        let real = std::fs::canonicalize(dir).ok()?;
        #[cfg(target_os = "macos")]
        let root = mac_mount_point(&real)?;
        #[cfg(not(target_os = "macos"))]
        let root = mount_root(&real, folder_volume)?
            .to_string_lossy()
            .into_owned();
        Some(FolderSpace {
            free_bytes: crate::core::archive::free_space(&real)?,
            mount_root: root,
        })
    }
    #[cfg(windows)]
    {
        let _ = dir;
        None
    }
}

/// Where the volume holding `real` is mounted, as `statfs` names it. Not the device climb: on
/// macOS `/Users` is on the Data volume while `/` is the sealed System one (joined by
/// firmlinks), so the climb would stop at `/Users`.
#[cfg(target_os = "macos")]
fn mac_mount_point(real: &Path) -> Option<String> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(real.as_os_str().as_bytes()).ok()?;
    // SAFETY: zeroed is a valid statfs; the path is NUL-terminated and outlives the call.
    let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are live for the call.
    if unsafe { libc::statfs(c.as_ptr(), &mut buf) } != 0 {
        return None;
    }
    let point = crate::core::mounts::c_chars(&buf.f_mntonname);
    Some(boot_data_is_root(&point).to_owned())
}

/// The boot disk's Data half (`/System/Volumes/Data`, where `/Users` really lives) is the boot
/// disk the drive list shows as `/`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn boot_data_is_root(point: &str) -> &str {
    if point == "/System/Volumes/Data" {
        "/"
    } else {
        point
    }
}

/// The highest folder above `path` (itself included) on the same device: where its volume is
/// mounted. `dev` names a folder's device; `None` when `path`'s own cannot be read.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
fn mount_root(path: &Path, dev: impl Fn(&Path) -> Option<u64>) -> Option<std::path::PathBuf> {
    let own = dev(path)?;
    let mut root = path;
    while let Some(parent) = root.parent() {
        if parent.as_os_str().is_empty() || dev(parent) != Some(own) {
            break;
        }
        root = parent;
    }
    Some(root.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A fresh folder under the temp dir, unique per test and process.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trove-volume-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_file_and_a_folder_beside_it_are_on_one_volume() {
        let dir = scratch("beside");
        let file = dir.as_path().join("a.txt");
        std::fs::write(&file, b"x").unwrap();
        let sub = dir.as_path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        assert!(same_volume(&[&file], &sub));
        assert!(same_volume(&[&file], dir.as_path()));
        assert!(same_volume(&[&sub, &file], dir.as_path()));
    }

    #[test]
    fn a_missing_path_or_no_sources_is_not_the_same_volume() {
        let dir = scratch("missing");
        let file = dir.as_path().join("a.txt");
        std::fs::write(&file, b"x").unwrap();
        let gone = dir.as_path().join("gone");
        assert!(!same_volume(&[&gone], dir.as_path()));
        assert!(!same_volume(&[&file], &gone));
        assert!(!same_volume(&[&file, &gone], dir.as_path()));
        assert!(!same_volume::<&Path>(&[], dir.as_path()));
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_judged_where_the_link_is() {
        let dir = scratch("link");
        let link = dir.as_path().join("link");
        std::os::unix::fs::symlink("/no/such/target", &link).unwrap();
        assert!(same_volume(&[&link], dir.as_path()));
    }

    #[test]
    fn the_mount_root_is_the_highest_folder_on_the_same_device() {
        // `/` is device 1, the disk image mounted at /Volumes/TroveTest is device 7
        let dev = |p: &Path| {
            Some(if p.starts_with("/Volumes/TroveTest") {
                7
            } else {
                1
            })
        };
        let at = |p: &str| mount_root(Path::new(p), dev).map(|r| r.to_string_lossy().into_owned());
        assert_eq!(
            at("/Volumes/TroveTest/a/b").as_deref(),
            Some("/Volumes/TroveTest")
        );
        assert_eq!(
            at("/Volumes/TroveTest").as_deref(),
            Some("/Volumes/TroveTest")
        );
        assert_eq!(at("/Users/alex/Documents").as_deref(), Some("/"));
        assert_eq!(at("/").as_deref(), Some("/"));
    }

    #[test]
    fn the_mac_boot_data_volume_counts_as_the_boot_disk() {
        assert_eq!(boot_data_is_root("/System/Volumes/Data"), "/");
        assert_eq!(
            boot_data_is_root("/Volumes/TroveTest"),
            "/Volumes/TroveTest"
        );
        assert_eq!(boot_data_is_root("/"), "/");
    }

    #[test]
    fn an_unreadable_folder_has_no_mount_root() {
        assert!(mount_root(Path::new("/gone/x"), |_| None).is_none());
        // a parent that cannot be read stops the climb at the last folder that could
        let dev = |p: &Path| (p != Path::new("/gone")).then_some(3);
        assert_eq!(
            mount_root(Path::new("/gone/x"), dev).as_deref(),
            Some(Path::new("/gone/x"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_temp_folder_reports_its_free_space_and_a_mount_root_above_it() {
        let dir = scratch("space");
        let space = folder_space(dir.as_path()).expect("space");
        assert!(space.free_bytes > 0);
        let real = std::fs::canonicalize(dir.as_path()).unwrap();
        assert!(real.starts_with(&space.mount_root), "{space:?}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_leaves_the_folder_space_to_the_drive_list() {
        assert!(folder_space(&std::env::temp_dir()).is_none());
    }

    // Two devices cannot be made portably in a test (a Mac disk image, a Linux loop mount and a
    // Windows VHD all need privileges). Set TROVE_OTHER_VOLUME to a folder on another volume
    // and run `cargo test -- --ignored other_volume` to check the cross-device answer by hand.
    #[test]
    #[ignore = "needs a folder on another volume in TROVE_OTHER_VOLUME"]
    fn a_folder_on_another_volume_is_not_the_same_volume() {
        let other = std::env::var("TROVE_OTHER_VOLUME").expect("TROVE_OTHER_VOLUME");
        let dir = scratch("other");
        let file = dir.as_path().join("a.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(!same_volume(&[&file], Path::new(&other)));
    }
}

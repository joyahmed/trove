//! Which mounts are network filesystems, read from the kernel's own mount table — never by
//! looking at the mounts themselves.
//!
//! ⛔ Why this exists: on a Mac, the first time an app touches anything on an SMB/AFP/NFS/WebDAV
//! volume, macOS stops and asks "Trove would like to access files on a network volume" (TCC).
//! A tester got that prompt in a release build without ever opening a share (2026-10). So nothing
//! Trove does on its own — the drive list, a size walk, a search from `/`, the Trash — may step
//! onto a network mount; only the person opening it may. On Linux the same rule keeps a dead
//! NFS/CIFS/sshfs server from hanging a `statvfs` or a walk.
//!
//! The table comes from `getfsstat(MNT_NOWAIT)` on macOS (the kernel's cached list, no
//! filesystem is asked anything) and `/proc/self/mounts` on Linux. Windows has none here: its
//! drive code is separate and stays as it is.

use std::path::{Path, PathBuf};

/// Filesystem type names that live on another machine. macOS spells them as `statfs`'s
/// `f_fstypename` (`smbfs`, `afpfs`, `nfs`, `webdav`, `ftp`); Linux as `/proc/mounts`' third
/// field, FUSE ones as `fuse.<helper>`.
/// ⚠️ Not `9p`: under WSL2 that is `/mnt/c`, the Windows disk on the same machine.
const NETWORK_FS: &[&str] = &[
    // macOS
    "smbfs",
    "afpfs",
    "nfs",
    "webdav",
    "ftp",
    // Linux kernel clients
    "nfs4",
    "cifs",
    "smb3",
    "ncpfs",
    "afs",
    "ceph",
    "glusterfs",
    "lustre",
    "gpfs",
    "davfs",
    // Linux FUSE clients
    "sshfs",
    "fuse.sshfs",
    "fuse.rclone",
    "fuse.s3fs",
    "fuse.curlftpfs",
    "fuse.davfs2",
    "fuse.glusterfs",
    "fuse.cephfs",
];

/// Whether a filesystem type names a network filesystem. Case does not matter.
pub fn is_network_fs(fstype: &str) -> bool {
    let t = fstype.trim().to_ascii_lowercase();
    NETWORK_FS.contains(&t.as_str())
}

/// One row of the mount table: where it is mounted and what kind of filesystem it is.
#[derive(Debug, Clone, PartialEq)]
pub struct Mount {
    pub point: String,
    pub fstype: String,
}

/// The mount points of the network filesystems in `table`.
pub fn network_points(table: &[Mount]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = table
        .iter()
        .filter(|m| is_network_fs(&m.fstype))
        .map(|m| PathBuf::from(&m.point))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Whether `path` is exactly one of the network mount points. A walk calls this on each folder
/// it is about to enter, so a share mounted below the start is never stepped into.
pub fn is_network_point(path: &Path, points: &[PathBuf]) -> bool {
    points.iter().any(|p| p == path)
}

/// `/proc/self/mounts`, as rows. Points are unescaped (`\040` is a space).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_proc_mounts(text: &str) -> Vec<Mount> {
    text.lines()
        .filter_map(|line| {
            let mut f = line.split_whitespace();
            let (_source, point, fstype) = (f.next()?, f.next()?, f.next()?);
            Some(Mount {
                point: crate::core::places_unix::unescape_mount(point),
                fstype: fstype.to_string(),
            })
        })
        .collect()
}

/// The mount `path` lives on: the row with the longest mount point that `path` starts with,
/// compared by whole components and by name only, so nothing on the path is touched (no TCC
/// prompt, no hang on a dead server). A local mount below a share wins over the share.
#[cfg_attr(windows, allow(dead_code))]
pub fn mount_of<'a>(path: &Path, table: &'a [Mount]) -> Option<&'a Mount> {
    table
        .iter()
        .filter(|m| path.starts_with(&m.point))
        .max_by_key(|m| Path::new(&m.point).components().count())
}

/// The mount point of the network share `path` is on, or `None` when it is on a local disk.
/// Such a place has no Trash worth trusting: Delete and Replace ask instead of failing oddly.
#[cfg_attr(windows, allow(dead_code))]
pub fn network_share_of(path: &Path, table: &[Mount]) -> Option<String> {
    mount_of(path, table)
        .filter(|m| is_network_fs(&m.fstype))
        .map(|m| m.point.clone())
}

/// The network mount points on this machine right now. Empty when the table cannot be read
/// (logged) and always on Windows.
pub fn network_mount_points() -> Vec<PathBuf> {
    network_points(&mount_table())
}

#[cfg(target_os = "linux")]
pub fn mount_table() -> Vec<Mount> {
    match std::fs::read_to_string("/proc/self/mounts")
        .or_else(|_| std::fs::read_to_string("/proc/mounts"))
    {
        Ok(text) => parse_proc_mounts(&text),
        Err(e) => {
            log::warn!("mounts: cannot read the mount table ({e})");
            Vec::new()
        }
    }
}

/// `getfsstat` with `MNT_NOWAIT`: the kernel's cached `statfs` for every mount, without asking
/// any filesystem — so a network one is named without being touched. ⚠️ Not `getmntinfo`: its
/// buffer is shared and reused per process, and the drive list, a search and a size walk can
/// ask at the same moment on different threads.
#[cfg(target_os = "macos")]
pub fn mount_table() -> Vec<Mount> {
    // SAFETY: a null buffer with size 0 only asks for the count.
    let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if count <= 0 {
        log::warn!(
            "mounts: getfsstat count failed: {}",
            std::io::Error::last_os_error()
        );
        return Vec::new();
    }
    // room for a few mounts that appear between the two calls
    let room = count as usize + 8;
    // SAFETY: `statfs` is a plain C struct; all-zero is a valid value of it.
    let mut buf: Vec<libc::statfs> = vec![unsafe { std::mem::zeroed() }; room];
    let bytes = (room * std::mem::size_of::<libc::statfs>()) as libc::c_int;
    // SAFETY: `buf` holds `room` structs, which is exactly `bytes` long; the call fills at most
    // that many and returns how many it filled.
    let filled = unsafe { libc::getfsstat(buf.as_mut_ptr(), bytes, libc::MNT_NOWAIT) };
    if filled < 0 {
        log::warn!(
            "mounts: getfsstat failed: {}",
            std::io::Error::last_os_error()
        );
        return Vec::new();
    }
    buf.truncate(filled as usize);
    buf.iter()
        .map(|s| Mount {
            point: c_chars(&s.f_mntonname),
            fstype: c_chars(&s.f_fstypename),
        })
        .collect()
}

#[cfg(target_os = "macos")]
pub(crate) fn c_chars(field: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = field
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn mount_table() -> Vec<Mount> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(point: &str, fstype: &str) -> Mount {
        Mount {
            point: point.into(),
            fstype: fstype.into(),
        }
    }

    #[test]
    fn a_path_is_judged_by_its_longest_mount_point() {
        let table = [
            m("/", "ext4"),
            m("/mnt/nas", "cifs"),
            m("/mnt/nas/cache", "ext4"),
            m("/Volumes/docs", "smbfs"),
        ];
        let share = |p: &str| network_share_of(Path::new(p), &table);
        assert_eq!(share("/mnt/nas/a/b.txt").as_deref(), Some("/mnt/nas"));
        assert_eq!(share("/mnt/nas").as_deref(), Some("/mnt/nas"));
        assert_eq!(share("/Volumes/docs/x").as_deref(), Some("/Volumes/docs"));
        // a local mount below a share, a sibling with the same name prefix, and the root
        assert_eq!(share("/mnt/nas/cache/x"), None);
        assert_eq!(share("/mnt/nas2/x"), None);
        assert_eq!(share("/home/me/x"), None);
        assert_eq!(share("relative/x"), None);
        assert_eq!(network_share_of(Path::new("/x"), &[]), None);
    }

    #[test]
    fn a_mounts_line_with_a_share_is_found_through_parse_proc_mounts() {
        let table =
            parse_proc_mounts("//srv/docs /mnt/my\\040docs cifs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n");
        assert_eq!(
            network_share_of(Path::new("/mnt/my docs/a.txt"), &table).as_deref(),
            Some("/mnt/my docs")
        );
    }

    #[test]
    fn network_filesystems_are_named_on_both_oses() {
        for t in [
            "smbfs",
            "afpfs",
            "nfs",
            "webdav",
            "ftp",
            "nfs4",
            "cifs",
            "smb3",
            "fuse.sshfs",
            "fuse.rclone",
            "NFS",
            " cifs ",
        ] {
            assert!(is_network_fs(t), "{t} should be network");
        }
    }

    #[test]
    fn local_and_pseudo_filesystems_are_not_network() {
        for t in [
            "apfs", "hfs", "msdos", "exfat", "ext4", "btrfs", "xfs", "vfat", "ntfs3", "fuseblk",
            "tmpfs", "autofs", "devfs",
            // WSL2's /mnt/c: the Windows disk on this same machine
            "9p", "drvfs", "",
        ] {
            assert!(!is_network_fs(t), "{t} should not be network");
        }
    }

    #[test]
    fn the_network_points_of_a_linux_table() {
        let table = parse_proc_mounts(
            "/dev/nvme0n1p2 / ext4 rw 0 0\n\
             nas:/export /mnt/nas nfs4 rw 0 0\n\
             //nas/media /media/alex/My\\040Share cifs rw 0 0\n\
             alex@box:/ /home/alex/box fuse.sshfs rw 0 0\n\
             /dev/sdb1 /mnt/data ext4 rw 0 0\n\
             C:\\134 /mnt/c 9p rw 0 0\n",
        );
        assert_eq!(table.len(), 6);
        assert_eq!(
            network_points(&table),
            [
                PathBuf::from("/home/alex/box"),
                PathBuf::from("/media/alex/My Share"),
                PathBuf::from("/mnt/nas"),
            ]
        );
    }

    #[test]
    fn a_walk_skips_only_the_exact_mount_point() {
        let points = vec![PathBuf::from("/Volumes/media")];
        assert!(is_network_point(Path::new("/Volumes/media"), &points));
        assert!(!is_network_point(Path::new("/Volumes"), &points));
        assert!(!is_network_point(Path::new("/Volumes/media2"), &points));
        assert!(!is_network_point(Path::new("/Volumes/media/x"), &points));
    }
}

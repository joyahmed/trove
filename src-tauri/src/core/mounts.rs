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
    /// macOS: the kernel flags the mount `MNT_DONTBROWSE` (Finder's `nobrowse`) or
    /// `MNT_AUTOMOUNTED`. Always false on Linux.
    pub hidden: bool,
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
                hidden: false,
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

/// Whether a filesystem type is the automounter. Stepping onto an `autofs` point (`/net`,
/// `/home`, `/Network/Servers` on a Mac; systemd automounts on Linux) mounts whatever it maps,
/// often a network share, so a walk Trove starts on its own never enters one either.
pub fn is_automount_fs(fstype: &str) -> bool {
    fstype.trim().eq_ignore_ascii_case("autofs")
}

/// The points in `table` a walk Trove starts never enters: network shares, automounts, and on a
/// Mac every mount the kernel flags `nobrowse` or automounted (read off `statfs.f_flags`, not
/// guessed from the name).
///
/// ⛔ `/System/Volumes/Data` is one of those: the APFS data volume, which `/Users`,
/// `/Applications`, `/Volumes`… are firmlinked into. A search of This Mac from `/` walked into
/// it and reached `~/Desktop`, `~/Documents` and `~/Downloads` a second time, spelled
/// `/System/Volumes/Data/Users/<me>/…`, a spelling the guarded list did not know, and raised
/// all three prompts before any Allow (Mac test, 2026-11-04). Everything on it is reached
/// through the firmlinks anyway; a ROOT on a skipped mount is still walked.
pub fn skip_points(table: &[Mount]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = table
        .iter()
        .filter(|m| m.hidden || is_network_fs(&m.fstype) || is_automount_fs(&m.fstype))
        .map(|m| PathBuf::from(&m.point))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// `skip_points` of this machine's mount table right now.
pub fn walk_skip_points() -> Vec<PathBuf> {
    skip_points(&mount_table())
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
            hidden: s.f_flags & ((libc::MNT_DONTBROWSE | libc::MNT_AUTOMOUNTED) as u32) != 0,
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

/// How far away a path is, read from its spelling (and on Windows its drive's type). The path
/// itself is never touched, so asking is instant even for a dead server (plan 08 D1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    /// A local disk: no deadline.
    Local,
    /// `\\wsl.localhost\…` or `\\wsl$\…`: spelled like UNC, but the distro is on this machine
    /// (plan 08 C2/C3). No deadline either: a distro that is starting is slow, not gone.
    Wsl,
    /// A UNC share, a mapped network letter, a removable or optical drive: every probe,
    /// listing and icon goes through `workers::guarded` with a deadline.
    Remote,
}

/// `path` with `/` read as `\` and a `\\?\` / `\\?\UNC\` prefix taken off, so the rest of the
/// classifier sees one spelling.
fn plain_windows(path: &str) -> String {
    let p = path.replace('/', "\\");
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p
    }
}

/// `\\server\share` for a UNC path (no trailing slash, case kept), or `None`. A bare
/// `\\server` has no share yet and is `None` too; `\\.\` device paths are not shares.
pub fn share_root(path: &str) -> Option<String> {
    let p = plain_windows(path);
    let rest = p.strip_prefix(r"\\")?;
    let mut parts = rest.split('\\');
    let server = parts
        .next()
        .filter(|s| !s.is_empty() && *s != "." && *s != "?")?;
    let share = parts.next().filter(|s| !s.is_empty())?;
    Some(format!(r"\\{server}\{share}"))
}

/// Whether a UNC host is WSL's own (`wsl.localhost`, `wsl$`), any case.
pub fn is_wsl_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("wsl.localhost") || host.eq_ignore_ascii_case("wsl$")
}

/// `Reach` for `path`; `drive_is_remote` answers for an upper-case drive letter, so a test
/// can stand in for the OS.
pub fn reach_with(path: &str, drive_is_remote: impl Fn(char) -> bool) -> Reach {
    let p = plain_windows(path);
    if let Some(rest) = p.strip_prefix(r"\\") {
        let host = rest.split('\\').next().unwrap_or("");
        return match host {
            "" | "." | "?" => Reach::Local,
            h if is_wsl_host(h) => Reach::Wsl,
            _ => Reach::Remote,
        };
    }
    let mut chars = p.chars();
    match (chars.next(), chars.next()) {
        (Some(letter), Some(':'))
            if letter.is_ascii_alphabetic() && drive_is_remote(letter.to_ascii_uppercase()) =>
        {
            Reach::Remote
        }
        _ => Reach::Local,
    }
}

/// `Reach` for `path` on this machine. Off Windows every path is `Local` here: the mount
/// table above already keeps Trove's own walks off network mounts there.
pub fn reach_of(path: &str) -> Reach {
    reach_with(path, drive_is_remote)
}

/// A mapped network letter, a removable drive or an optical drive. `GetDriveTypeW` reads the
/// mount manager's record of the letter and does not ask the drive itself.
#[cfg(windows)]
fn drive_is_remote(letter: char) -> bool {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;
    let root: Vec<u16> = format!("{letter}:\\").encode_utf16().chain([0]).collect();
    // SAFETY: `root` is a NUL-terminated UTF-16 string that outlives the call.
    let kind = unsafe { GetDriveTypeW(root.as_ptr()) };
    matches!(kind, DRIVE_REMOVABLE | DRIVE_REMOTE | DRIVE_CDROM)
}

#[cfg(not(windows))]
fn drive_is_remote(_letter: char) -> bool {
    false
}

/// The drive letters mapped to a network share (`DRIVE_REMOTE`), as `Z:\`: the sidebar's
/// Network group lists them (plan 05 5.3b). `GetLogicalDrives` + `GetDriveTypeW` read the mount
/// manager's records only, so a dead mapping answers at once. Empty off Windows.
#[cfg(windows)]
pub fn mapped_letters() -> Vec<String> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    const DRIVE_REMOTE: u32 = 4;
    // SAFETY: no arguments; the bitmask is the return value.
    let mask = unsafe { GetLogicalDrives() };
    (0u8..26)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| format!("{}:\\", (b'A' + i) as char))
        .filter(|root| {
            let wide: Vec<u16> = root.encode_utf16().chain([0]).collect();
            // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call.
            unsafe { GetDriveTypeW(wide.as_ptr()) == DRIVE_REMOTE }
        })
        .collect()
}

#[cfg(not(windows))]
pub fn mapped_letters() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(point: &str, fstype: &str) -> Mount {
        Mount {
            point: point.into(),
            fstype: fstype.into(),
            hidden: false,
        }
    }

    /// ⭐ This Mac's "Search everywhere" raised the Desktop, Documents and Downloads prompts:
    /// the walk from `/` entered `/System/Volumes/Data` (a `nobrowse` mount) and met the home
    /// folder again under a spelling the guarded list did not know. Hidden mounts are skipped.
    #[test]
    fn hidden_mac_mounts_are_skipped_but_the_boot_volume_is_not() {
        let hide = |point: &str| Mount {
            hidden: true,
            ..m(point, "apfs")
        };
        let table = [
            m("/", "apfs"),
            hide("/System/Volumes/Data"),
            hide("/dev"),
            m("/Volumes/USB", "msdos"),
        ];
        assert_eq!(
            skip_points(&table),
            [PathBuf::from("/System/Volumes/Data"), PathBuf::from("/dev")]
        );
    }

    #[test]
    fn walks_skip_shares_and_automounts_but_not_local_disks() {
        let table = [
            m("/", "apfs"),
            m("/Volumes/media", "smbfs"),
            m("/System/Volumes/Data/home", "autofs"),
            m("/Volumes/USB", "msdos"),
        ];
        assert_eq!(
            skip_points(&table),
            [
                PathBuf::from("/System/Volumes/Data/home"),
                PathBuf::from("/Volumes/media")
            ]
        );
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

    #[test]
    fn wsl_paths_are_wsl_not_remote() {
        let never = |_| false;
        for p in [
            r"\\wsl.localhost\Ubuntu\home",
            r"\\WSL.LOCALHOST\Ubuntu",
            r"\\wsl$\Debian\etc",
            "//wsl.localhost/Ubuntu/home",
            r"\\?\UNC\wsl$\Ubuntu",
        ] {
            assert_eq!(reach_with(p, never), Reach::Wsl, "{p}");
        }
    }

    #[test]
    fn unc_shares_and_remote_letters_are_remote() {
        let never = |_| false;
        assert_eq!(reach_with(r"\\10.255.255.1\x", never), Reach::Remote);
        assert_eq!(reach_with(r"\\nas\media\film", never), Reach::Remote);
        assert_eq!(reach_with(r"\\?\UNC\nas\media", never), Reach::Remote);
        assert_eq!(reach_with(r"\\wsl.localhost.evil\x", never), Reach::Remote);
        let z_is_mapped = |l| l == 'Z';
        assert_eq!(reach_with(r"z:\work", z_is_mapped), Reach::Remote);
        assert_eq!(reach_with(r"C:\Users", z_is_mapped), Reach::Local);
        assert_eq!(reach_with(r"\\?\C:\long", z_is_mapped), Reach::Local);
        assert_eq!(reach_with(r"\\.\PhysicalDrive0", never), Reach::Local);
        assert_eq!(reach_with("/home/alex", never), Reach::Local);
    }

    #[test]
    fn share_roots() {
        let root = |p: &str| share_root(p);
        assert_eq!(
            root(r"\\nas\media\film\a.mkv").as_deref(),
            Some(r"\\nas\media")
        );
        assert_eq!(root(r"\\nas\media").as_deref(), Some(r"\\nas\media"));
        assert_eq!(root("//nas/media/").as_deref(), Some(r"\\nas\media"));
        assert_eq!(
            root(r"\\?\UNC\nas\media\x").as_deref(),
            Some(r"\\nas\media")
        );
        assert_eq!(root(r"\\nas"), None);
        assert_eq!(root(r"\\nas\"), None);
        assert_eq!(root(r"\\.\pipe\x"), None);
        assert_eq!(root(r"C:\x"), None);
    }
}

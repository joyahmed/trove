//! Pure parsers behind the macOS and Linux sidebar: which folders are the user's known
//! folders, and which mounts are drives. Each takes the text the OS hands over, so every one is
//! tested on any OS; the file reads and process runs that feed them are thin wrappers in
//! `shell.rs`. Compiled everywhere for exactly that reason, so a function unused on the host OS
//! is not dead code, only a twin's.

use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------------------------
// Linux — `~/.config/user-dirs.dirs` (xdg-user-dirs)
// ---------------------------------------------------------------------------------------------

/// `XDG_<NAME>_DIR` → the `KnownFolder.key` it fills. Templates and Public are not known folders.
const XDG_KEYS: [(&str, &str); 6] = [
    ("XDG_DESKTOP_DIR", "desktop"),
    ("XDG_DOWNLOAD_DIR", "downloads"),
    ("XDG_DOCUMENTS_DIR", "documents"),
    ("XDG_PICTURES_DIR", "pictures"),
    ("XDG_MUSIC_DIR", "music"),
    ("XDG_VIDEOS_DIR", "videos"),
];

/// The known folders `user-dirs.dirs` names, as `(key, path)`.
///
/// ⚠️ The file is shell-ish, not INI: `XDG_MUSIC_DIR="$HOME/Musique"`. Per the xdg-user-dirs
/// spec a value is either `"$HOME/<relative>"` or an absolute path, always double-quoted;
/// `#` starts a comment. Localised names (`Bureau`, `Téléchargements`) are the reason this is
/// read at all, so nothing here assumes English. A value that is `$HOME` itself means the
/// folder is disabled, so it is left out, and the caller's fallback applies. Anything else
/// (a relative path, an unknown variable) is skipped rather than guessed at.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_user_dirs(text: &str, home: &Path) -> Vec<(&'static str, PathBuf)> {
    let mut out: Vec<(&'static str, PathBuf)> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let Some(&(_, key)) = XDG_KEYS.iter().find(|(n, _)| *n == name.trim()) else {
            continue;
        };
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .unwrap_or(value);
        let path = if let Some(rest) = value.strip_prefix("$HOME") {
            let rest = rest.trim_start_matches('/');
            if rest.is_empty() {
                continue; // `"$HOME/"`: the folder is disabled
            }
            home.join(rest)
        } else if value.starts_with('/') {
            PathBuf::from(value)
        } else {
            continue;
        };
        // a later line wins, as when the shell sources the file
        out.retain(|(k, _)| *k != key);
        out.push((key, path));
    }
    out
}

/// A drive off Windows: where it is mounted, and whether it is a network share. ⛔ A network
/// one is listed but never measured — no `statvfs`, no walk — until the person opens it (see
/// `core/mounts.rs` for why).
#[derive(Debug, Clone, PartialEq)]
pub struct DriveRoot {
    pub path: String,
    pub network: bool,
}

impl DriveRoot {
    pub fn local(path: &str) -> Self {
        Self {
            path: path.to_string(),
            network: false,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Linux — `/proc/self/mounts`
// ---------------------------------------------------------------------------------------------

/// Filesystems that are never a drive. Most never mount under the media paths at all; this is
/// the second filter, behind the location one, so a bind mount or a container's overlay that
/// lands under `/mnt` still stays out.
const PSEUDO_FS: &[&str] = &[
    "proc",
    "sysfs",
    "tmpfs",
    "devtmpfs",
    "devpts",
    "ramfs",
    "squashfs",
    "overlay",
    "cgroup",
    "cgroup2",
    "autofs",
    "mqueue",
    "debugfs",
    "tracefs",
    "securityfs",
    "pstore",
    "bpf",
    "configfs",
    "fusectl",
    "hugetlbfs",
    "efivarfs",
    "binfmt_misc",
    "nsfs",
    "rpc_pipefs",
    "fuse.gvfsd-fuse",
    "fuse.portal",
    "fuse.snapfuse",
];

/// `/proc/mounts` escapes a space, tab, newline and backslash in a mount point as `\040`,
/// `\011`, `\012` and `\134`.
pub fn unescape_mount(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 3 < b.len() {
            let oct = &b[i + 1..i + 4];
            if oct.iter().all(|c| (b'0'..=b'7').contains(c)) {
                let v = oct
                    .iter()
                    .fold(0u32, |acc, c| acc * 8 + u32::from(c - b'0'));
                if let Ok(v) = u8::try_from(v) {
                    out.push(v);
                    i += 4;
                    continue;
                }
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The drives in a Linux mount table: `/` first, then each real filesystem mounted where a
/// person's drives go — `/media/<user>/<name>` and `/run/media/<user>/<name>` (udisks2, the
/// desktop's removable media), `/media/<name>` and `/mnt/<name>` (fstab, or by hand).
/// ⚠️ `/media/<name>` is measured, not guessed: the second disk is
/// `/dev/sda1 /media/DATADRIVE ext4`, straight under `/media`, and a list built only from
/// `/media/$USER` missed it on the first real run (2026-10-02).
///
/// ⛔ The table is mostly noise, measured on Ubuntu: every snap is a `squashfs` loop mount, plus
/// proc, sysfs, cgroup, docker's overlays. So the list is built from the locations, and the
/// filesystem type and a `/dev/loop` source then reject what still slipped in. A loop mount is
/// a mounted image (an ISO, a snap), the Linux `.dmg`, and nobody calls that a drive.
/// ⚠️ Under WSL `/mnt/c` is the Windows drive showing through; that it appears is correct
/// (plan 10, B.2.4) — WSL is a build loop, not the product.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_drive_roots(mounts: &str, user: &str) -> Vec<DriveRoot> {
    let media = [format!("/media/{user}/"), format!("/run/media/{user}/")];
    let mut out = vec![DriveRoot::local("/")];
    for line in mounts.lines() {
        let mut f = line.split_whitespace();
        let (Some(source), Some(point), Some(fstype)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        let point = unescape_mount(point);
        let leaf_under = |prefix: &str| {
            point
                .strip_prefix(prefix)
                .is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))
        };
        let placed = media.iter().any(|p| !user.is_empty() && leaf_under(p))
            || leaf_under("/media/")
            || leaf_under("/mnt/");
        if !placed || PSEUDO_FS.contains(&fstype) || source.starts_with("/dev/loop") {
            continue;
        }
        if !out.iter().any(|r| r.path == point) {
            out.push(DriveRoot {
                path: point,
                network: crate::core::mounts::is_network_fs(fstype),
            });
        }
    }
    out
}

/// What the sidebar calls `/` on Linux: GNOME's and Thunar's own word for it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const LINUX_ROOT_LABEL: &str = "File System";

// ---------------------------------------------------------------------------------------------
// macOS — `/sbin/mount`, `hdiutil info` and `/Volumes`
// ---------------------------------------------------------------------------------------------

/// One row of macOS `mount` output: `/dev/disk4s1 on /Volumes/Stick (msdos, local, nodev)`.
#[derive(Debug, Clone, PartialEq)]
pub struct MacMount {
    pub source: String,
    pub point: String,
    pub fstype: String,
    pub options: Vec<String>,
}

/// Parses `/sbin/mount` output. A mount point may hold spaces, so the row is split at the first
/// ` on ` and the last ` (`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_mac_mount(text: &str) -> Vec<MacMount> {
    text.lines()
        .filter_map(|line| {
            let (source, rest) = line.split_once(" on ")?;
            let (point, opts) = rest.rsplit_once(" (")?;
            let opts = opts.strip_suffix(')')?;
            let mut it = opts.split(',').map(|o| o.trim().to_string());
            let fstype = it.next()?;
            Some(MacMount {
                source: source.to_string(),
                point: point.to_string(),
                fstype,
                options: it.collect(),
            })
        })
        .collect()
}

/// The mount points of attached disk images, from `hdiutil info`: the rows that start with a
/// `/dev/disk…` node and end with the place it is mounted, tab-separated.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_hdiutil_mount_points(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| l.starts_with("/dev/disk"))
        .filter_map(|l| l.split('\t').map(str::trim).rfind(|f| f.starts_with('/')))
        .filter(|p| !p.starts_with("/dev/"))
        .map(str::to_string)
        .collect()
}

/// Filesystems in `/Volumes` that are not a drive at all: the automounter and devfs. Network
/// shares are listed, marked `network` (`core/mounts.rs`).
const MAC_NOT_A_DRIVE: &[&str] = &["autofs", "devfs"];

/// The drives on a Mac: `/` (the boot volume), then every volume mounted directly in
/// `/Volumes`, minus what nobody calls a drive.
///
/// - ⛔ The boot volume itself also appears as `/Volumes/<its name>`, a symlink (APFS firmlink)
///   back to `/`. It is not a mount, so it is not in this table and cannot be listed twice;
///   a mount whose source is the root's own device is dropped too, in case a release ever
///   makes it one.
/// - `.dmg` mounts (`images`, from `hdiutil info`), Time Machine snapshots and everything else
///   Finder hides (`nobrowse`) are left out, as are hidden (`.`) names.
/// - A network share (`smbfs`, `afpfs`, `nfs`, `webdav`, `ftp`) is listed with `network` set,
///   so nothing measures it: touching it is what raises macOS's network-volume prompt.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_drive_roots(mounts: &[MacMount], images: &[String]) -> Vec<DriveRoot> {
    let root_source = mounts.iter().find(|m| m.point == "/").map(|m| &m.source);
    let mut out = vec![DriveRoot::local("/")];
    for m in mounts {
        let Some(name) = m.point.strip_prefix("/Volumes/") else {
            continue;
        };
        if name.is_empty()
            || name.contains('/')
            || name.starts_with('.')
            || MAC_NOT_A_DRIVE.contains(&m.fstype.as_str())
            || m.options.iter().any(|o| o == "nobrowse")
            || images.iter().any(|i| i == &m.point)
            || Some(&m.source) == root_source
        {
            continue;
        }
        if !out.iter().any(|r| r.path == m.point) {
            out.push(DriveRoot {
                path: m.point.clone(),
                network: crate::core::mounts::is_network_fs(&m.fstype),
            });
        }
    }
    out
}

/// The boot volume's name: the `/Volumes` entry that is a link back to `/`. ⛔ Not the literal
/// `Macintosh HD` — that is only the default, and a renamed boot volume is common.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_boot_volume_name(entries: &[(String, Option<PathBuf>)]) -> Option<String> {
    entries
        .iter()
        .find(|(_, target)| target.as_deref() == Some(Path::new("/")))
        .map(|(name, _)| name.clone())
}

/// What the sidebar calls `/` on a Mac when `/Volumes` has no link back to it — macOS's own
/// term for the boot volume.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MAC_ROOT_FALLBACK_LABEL: &str = "Startup Disk";

/// A drive's label off Windows: the last component of its mount point.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn mount_leaf(point: &str) -> String {
    point
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(point)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Just the mount points, for the tests that are about which drives are listed.
    fn paths(roots: &[DriveRoot]) -> Vec<String> {
        roots.iter().map(|r| r.path.clone()).collect()
    }

    // ---- XDG -----------------------------------------------------------------------------

    /// What xdg-user-dirs-update writes on a French Ubuntu, with an absolute Music, a disabled
    /// Videos, a duplicate key and no Pictures line at all.
    const USER_DIRS_FR: &str = r#"# This file is written by xdg-user-dirs-update
# If you want to change or add directories, just edit the line you're
# interested in. All local changes will be retained on the next run.
# Format is XDG_xxx_DIR="$HOME/yyy", where yyy is a shell-escaped
# homedir-relative path, or XDG_xxx_DIR="/yyy", where /yyy is an
# absolute path. No other format is supported.
#
XDG_DESKTOP_DIR="$HOME/Bureau"
XDG_DOWNLOAD_DIR="$HOME/Téléchargements"
XDG_TEMPLATES_DIR="$HOME/Modèles"
XDG_PUBLICSHARE_DIR="$HOME/Public"
XDG_DOCUMENTS_DIR="$HOME/Documents"
XDG_MUSIC_DIR="/srv/musique"
XDG_VIDEOS_DIR="$HOME/"
XDG_DOCUMENTS_DIR="$HOME/Docs perso"
"#;

    #[test]
    fn user_dirs_reads_localised_names_and_absolute_paths() {
        let home = Path::new("/home/alex");
        let got = parse_user_dirs(USER_DIRS_FR, home);
        assert_eq!(
            got,
            vec![
                ("desktop", home.join("Bureau")),
                ("downloads", home.join("Téléchargements")),
                ("music", PathBuf::from("/srv/musique")),
                // the later line wins
                ("documents", home.join("Docs perso")),
            ]
        );
    }

    #[test]
    fn user_dirs_leaves_out_a_disabled_or_missing_entry() {
        let got = parse_user_dirs(USER_DIRS_FR, Path::new("/home/alex"));
        // `"$HOME/"` is disabled; Pictures has no line; Templates and Public are not known
        // folders
        for key in ["videos", "pictures"] {
            assert!(got.iter().all(|(k, _)| *k != key), "{key} in {got:?}");
        }
        assert_eq!(got.len(), 4);
    }

    #[test]
    fn user_dirs_matches_the_stock_english_file() {
        // exactly what an Ubuntu 24.04 box has, measured 2026-09-26
        let text = "XDG_DESKTOP_DIR=\"$HOME/Desktop\"\nXDG_DOWNLOAD_DIR=\"$HOME/Downloads\"\n\
            XDG_TEMPLATES_DIR=\"$HOME/Templates\"\nXDG_PUBLICSHARE_DIR=\"$HOME/Public\"\n\
            XDG_DOCUMENTS_DIR=\"$HOME/Documents\"\nXDG_MUSIC_DIR=\"$HOME/Music\"\n\
            XDG_PICTURES_DIR=\"$HOME/Pictures\"\nXDG_VIDEOS_DIR=\"$HOME/Videos\"\n";
        let keys: Vec<_> = parse_user_dirs(text, Path::new("/home/alex"))
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(
            keys,
            [
                "desktop",
                "downloads",
                "documents",
                "music",
                "pictures",
                "videos"
            ]
        );
    }

    #[test]
    fn user_dirs_skips_what_it_cannot_read() {
        let text = "garbage\nXDG_DESKTOP_DIR=relative/path\nXDG_MUSIC_DIR=\"$OTHER/x\"\n";
        assert!(parse_user_dirs(text, Path::new("/home/alex")).is_empty());
    }

    // ---- /proc/self/mounts ----------------------------------------------------------------

    /// A stock Ubuntu 24.04 desktop: snaps, docker, a USB stick (with a space in its name),
    /// a second disk under /mnt, a mounted ISO and the usual pseudo filesystems.
    const UBUNTU_MOUNTS: &str = "\
sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
udev /dev devtmpfs rw,nosuid,relatime,size=16303024k,nr_inodes=4075756,mode=755,inode64 0 0
devpts /dev/pts devpts rw,nosuid,noexec,relatime,gid=5,mode=620,ptmxmode=000 0 0
tmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime,size=3267756k,mode=755,inode64 0 0
/dev/nvme0n1p2 / ext4 rw,relatime 0 0
securityfs /sys/kernel/security securityfs rw,nosuid,nodev,noexec,relatime 0 0
tmpfs /dev/shm tmpfs rw,nosuid,nodev,inode64 0 0
cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot 0 0
pstore /sys/fs/pstore pstore rw,nosuid,nodev,noexec,relatime 0 0
efivarfs /sys/firmware/efi/efivars efivarfs rw,nosuid,nodev,noexec,relatime 0 0
bpf /sys/fs/bpf bpf rw,nosuid,nodev,noexec,relatime,mode=700 0 0
systemd-1 /proc/sys/fs/binfmt_misc autofs rw,relatime,fd=32,pgrp=1,timeout=0,minproto=5,maxproto=5,direct,pipe_ino=4425 0 0
/dev/loop0 /snap/bare/5 squashfs ro,nodev,relatime,errors=continue,threads=single 0 0
/dev/loop1 /snap/core22/1663 squashfs ro,nodev,relatime,errors=continue,threads=single 0 0
/dev/loop2 /snap/firefox/5091 squashfs ro,nodev,relatime,errors=continue,threads=single 0 0
/dev/loop3 /snap/gnome-42-2204/176 squashfs ro,nodev,relatime,errors=continue,threads=single 0 0
/dev/loop4 /snap/snapd/21759 squashfs ro,nodev,relatime,errors=continue,threads=single 0 0
/dev/nvme0n1p1 /boot/efi vfat rw,relatime,fmask=0077,dmask=0077,codepage=437,iocharset=iso8859-1 0 0
binfmt_misc /proc/sys/fs/binfmt_misc binfmt_misc rw,nosuid,nodev,noexec,relatime 0 0
tmpfs /run/user/1000 tmpfs rw,nosuid,nodev,relatime,size=3267752k,nr_inodes=816938,mode=700,uid=1000,gid=1000,inode64 0 0
gvfsd-fuse /run/user/1000/gvfs fuse.gvfsd-fuse rw,nosuid,nodev,relatime,user_id=1000,group_id=1000 0 0
portal /run/user/1000/doc fuse.portal rw,nosuid,nodev,relatime,user_id=1000,group_id=1000 0 0
overlay /var/lib/docker/overlay2/3f1c0a/merged overlay rw,relatime,lowerdir=/var/lib/docker/overlay2/l/ABC,upperdir=/var/lib/docker/overlay2/3f1c0a/diff,workdir=/var/lib/docker/overlay2/3f1c0a/work 0 0
nsfs /run/docker/netns/1a2b3c nsfs rw 0 0
/dev/sda1 /media/alex/KINGSTON\\040USB vfat rw,nosuid,nodev,relatime,uid=1000,gid=1000,fmask=0022,dmask=0022,shortname=mixed,showexec,utf8,flush,errors=remount-ro 0 0
/dev/loop5 /media/alex/Ubuntu\\04024.04\\040LTS iso9660 ro,nosuid,nodev,relatime,nojoliet,check=relaxed,map=n,blocksize=2048,uid=1000,gid=1000,dmode=500,fmode=400 0 0
/dev/sdb1 /mnt/data ext4 rw,relatime 0 0
/dev/sdb1 /mnt/data ext4 rw,relatime 0 0
tmpfs /mnt/scratch tmpfs rw,relatime 0 0
/dev/sdc1 /mnt/data/nested ext4 rw,relatime 0 0
/dev/sdd1 /media/sam/HerStick vfat rw,nosuid,nodev,relatime 0 0
/dev/sde1 /run/media/alex/Backup ext4 rw,nosuid,nodev,relatime 0 0
/dev/sdf1 /media/DATADRIVE ext4 rw,relatime 0 0
";

    #[test]
    fn linux_drives_are_root_then_real_media_mounts() {
        assert_eq!(
            paths(&linux_drive_roots(UBUNTU_MOUNTS, "alex")),
            [
                "/",
                "/media/alex/KINGSTON USB",
                "/mnt/data",
                "/run/media/alex/Backup",
                // fstab-style, straight under /media: a real second disk
                "/media/DATADRIVE"
            ]
        );
    }

    #[test]
    fn linux_drives_never_list_a_snap_loop_overlay_or_pseudo_fs() {
        let roots = paths(&linux_drive_roots(UBUNTU_MOUNTS, "alex"));
        for bad in [
            "/snap",
            "/sys",
            "/proc",
            "/run/user",
            "/var/lib/docker",
            "/boot",
        ] {
            assert!(
                roots.iter().all(|r| !r.starts_with(bad)),
                "{bad} in {roots:?}"
            );
        }
        // the mounted ISO is a loop device: an image, not a drive
        assert!(roots.iter().all(|r| !r.contains("Ubuntu")), "{roots:?}");
        // a tmpfs under /mnt is still not a drive
        assert!(!roots.contains(&"/mnt/scratch".to_string()));
    }

    #[test]
    fn linux_drives_are_only_this_users_media() {
        let roots = paths(&linux_drive_roots(UBUNTU_MOUNTS, "sam"));
        assert!(roots.contains(&"/media/sam/HerStick".to_string()));
        assert!(!roots.iter().any(|r| r.starts_with("/media/alex")));
        // no user known → no per-user media, but still /, /mnt and /media/<name>
        assert_eq!(
            paths(&linux_drive_roots(UBUNTU_MOUNTS, "")),
            ["/", "/mnt/data", "/media/DATADRIVE"]
        );
    }

    #[test]
    fn linux_drives_from_an_empty_table_are_just_root() {
        assert_eq!(paths(&linux_drive_roots("", "alex")), ["/"]);
    }

    #[test]
    fn mount_points_are_unescaped() {
        assert_eq!(
            unescape_mount(r"/media/alex/A\040B\011C\134D"),
            "/media/alex/A B\tC\\D"
        );
        assert_eq!(unescape_mount(r"/trailing\04"), r"/trailing\04");
        assert_eq!(unescape_mount(r"/x\999"), r"/x\999");
    }

    // ---- macOS -----------------------------------------------------------------------------

    /// `/sbin/mount` on an Apple-silicon Mac (macOS 15): the sealed system volume at `/`, the
    /// Data volume and its siblings, a USB stick, an external SSD, a mounted `.dmg`, an SMB
    /// share, a Time Machine local snapshot and the automounter.
    const MAC_MOUNT: &str = "\
/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)
/dev/disk3s2 on /System/Volumes/Preboot (apfs, local, journaled, nobrowse)
/dev/disk3s4 on /System/Volumes/Update (apfs, local, journaled, nobrowse)
/dev/disk1s2 on /System/Volumes/xarts (apfs, local, noexec, journaled, noatime, nobrowse)
/dev/disk1s1 on /System/Volumes/iSCPreboot (apfs, local, journaled, nobrowse)
/dev/disk1s3 on /System/Volumes/Hardware (apfs, local, journaled, nobrowse)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)
map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
/dev/disk5s1 on /Volumes/Samsung T7 (apfs, local, nodev, nosuid, journaled, noowners, mounted by alex)
/dev/disk6s1 on /Volumes/NO NAME (msdos, local, nodev, nosuid, noowners, noatime, fskit, mounted by alex)
/dev/disk7s1 on /Volumes/Firefox (hfs, local, nodev, nosuid, read-only, journaled, noowners, quarantine, mounted by alex)
//alex@nas._smb._tcp.local/media on /Volumes/media (smbfs, nodev, nosuid, mounted by alex)
/dev/disk3s5 on /Volumes/com.apple.TimeMachine.localsnapshots/Backups.backupdb/Mac/2026-10-01-101010/Data (apfs, local, read-only, journaled, nobrowse)
/dev/disk8s1 on /Volumes/.timemachine/ABC-123/2026-10-01-101010.backup (apfs, local, nodev, nosuid, read-only, journaled, nobrowse)
/dev/disk9s1 on /Volumes/Recovery (apfs, local, journaled, nobrowse)
";

    /// `hdiutil info` with the Firefox image attached.
    const HDIUTIL_INFO: &str = "\
framework       : 671.140.2
driver          : 671.140.2
================================================
image-path      : /Users/alex/Downloads/Firefox 131.0.dmg
image-alias     : /Users/alex/Downloads/Firefox 131.0.dmg
shadow-path     : <none>
icon-path       : /System/Library/PrivateFrameworks/DiskImages.framework/Resources/CDiskImage.icns
image-type      : UDIF read-only compressed (zlib)
system-image    : false
blockcount      : 290816
blocksize       : 512
writeable       : FALSE
autodiskmount   : TRUE
removable       : TRUE
image-encrypted : false
mounting user   : alex
mounting mode   : <unknown>
process ID      : 1234
/dev/disk7\tGUID_partition_scheme\t
/dev/disk7s1\tApple_HFS\t/Volumes/Firefox
";

    #[test]
    fn mac_mount_rows_parse_with_spaces_in_the_point() {
        let rows = parse_mac_mount(MAC_MOUNT);
        let t7 = rows
            .iter()
            .find(|m| m.point == "/Volumes/Samsung T7")
            .expect("the SSD row parses");
        assert_eq!(t7.source, "/dev/disk5s1");
        assert_eq!(t7.fstype, "apfs");
        assert!(t7.options.contains(&"local".to_string()));
        assert_eq!(rows.len(), 17);
    }

    #[test]
    fn hdiutil_names_the_image_mount_points() {
        assert_eq!(
            parse_hdiutil_mount_points(HDIUTIL_INFO),
            ["/Volumes/Firefox"]
        );
        assert!(parse_hdiutil_mount_points("No disk images attached\n").is_empty());
    }

    #[test]
    fn mac_drives_are_root_then_real_volumes() {
        let images = parse_hdiutil_mount_points(HDIUTIL_INFO);
        assert_eq!(
            paths(&mac_drive_roots(&parse_mac_mount(MAC_MOUNT), &images)),
            [
                "/",
                "/Volumes/Samsung T7",
                "/Volumes/NO NAME",
                "/Volumes/media"
            ]
        );
    }

    #[test]
    fn a_mac_network_share_is_listed_as_network_and_nothing_else_is() {
        let roots = mac_drive_roots(&parse_mac_mount(MAC_MOUNT), &[]);
        let network: Vec<&str> = roots
            .iter()
            .filter(|r| r.network)
            .map(|r| r.path.as_str())
            .collect();
        assert_eq!(network, ["/Volumes/media"]);
    }

    #[test]
    fn linux_network_mounts_are_listed_as_network() {
        let table = "/dev/nvme0n1p2 / ext4 rw 0 0
                     nas:/export /mnt/nas nfs4 rw 0 0
                     //nas/media /media/alex/Share cifs rw 0 0
                     alex@box:/ /mnt/box fuse.sshfs rw 0 0
                     /dev/sdb1 /mnt/data ext4 rw 0 0
";
        let roots = linux_drive_roots(table, "alex");
        let flags: Vec<(&str, bool)> = roots.iter().map(|r| (r.path.as_str(), r.network)).collect();
        assert_eq!(
            flags,
            [
                ("/", false),
                ("/mnt/nas", true),
                ("/media/alex/Share", true),
                ("/mnt/box", true),
                ("/mnt/data", false),
            ]
        );
    }

    #[test]
    fn mac_drives_leave_out_images_snapshots_and_hidden() {
        let roots = paths(&mac_drive_roots(&parse_mac_mount(MAC_MOUNT), &[]));
        // without hdiutil's answer the .dmg is indistinguishable from a stick — so it shows,
        // which is the honest degradation
        assert!(roots.contains(&"/Volumes/Firefox".to_string()));
        for bad in ["/Volumes/Recovery", "/Volumes/com.apple", "/Volumes/."] {
            assert!(
                roots.iter().all(|r| !r.starts_with(bad)),
                "{bad} in {roots:?}"
            );
        }
        assert!(roots.iter().all(|r| !r.starts_with("/System")));
    }

    #[test]
    fn mac_drives_drop_a_mount_of_the_root_device() {
        // if a release ever mounts the boot volume itself in /Volumes, it is still listed once
        let text = "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n\
                    /dev/disk3s1s1 on /Volumes/Macintosh HD (apfs, local, read-only, journaled)\n";
        assert_eq!(paths(&mac_drive_roots(&parse_mac_mount(text), &[])), ["/"]);
    }

    #[test]
    fn the_boot_volume_is_named_by_its_link_back_to_root() {
        // `ls -l /Volumes`: the boot volume's firmlink, a stick, a .dmg, Finder's hidden file
        let listing = vec![
            ("Samsung T7".to_string(), None),
            ("Work SSD".to_string(), Some(PathBuf::from("/"))),
            ("Firefox".to_string(), None),
            (".DS_Store".to_string(), None),
        ];
        assert_eq!(mac_boot_volume_name(&listing).as_deref(), Some("Work SSD"));
        assert_eq!(mac_boot_volume_name(&listing[..1]), None);
    }

    #[test]
    fn a_drive_is_labelled_by_its_mount_leaf() {
        assert_eq!(mount_leaf("/Volumes/Samsung T7"), "Samsung T7");
        assert_eq!(mount_leaf("/media/alex/KINGSTON USB/"), "KINGSTON USB");
        assert_eq!(mount_leaf("/"), "/");
    }
}

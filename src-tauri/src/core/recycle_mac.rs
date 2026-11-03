//! The macOS Trash as plain folders: `~/.Trash`, plus each mounted volume's own Trash
//! (`/Volumes/<name>/.Trashes/<uid>`), read with `std::fs` because `trash 5.2.9` has no
//! `os_limited` module on macOS (see `os_limited.rs`). What it can do there: list what is in
//! them, delete items for good, empty them. What it cannot: restore — the Trash keeps no record
//! of where an item came from (Finder keeps that in its own private store), so `original_parent`
//! is `None` for every item and the view turns Restore off.
//!
//! Every function takes the Trash folders as an argument so the tests can point them at temp
//! dirs on any OS; only `trash_dirs()` (macOS) knows where the real ones are. Compiled on macOS
//! and in tests.
//!
//! ⛔ A purge or an empty deletes only paths that a fresh listing of those folders handed back —
//! never a path built from an id the frontend sent. So nothing outside the Trash can be touched,
//! and a name that is not valid UTF-8 (whose id is lossy) still resolves to its real path.
//!
//! ⛔ Errors are sentences a person can act on, never `{:?}` text. Without Full Disk Access
//! macOS refuses to let an app read `~/.Trash` at all (`EPERM`, which `std` reports as
//! `PermissionDenied`); that case says what to switch on and where.

use std::io;
use std::path::{Path, PathBuf};

use crate::core::recycle::RecycleItem;

/// What the person sees when macOS will not let Trove read the Trash.
pub const NEEDS_FULL_DISK_ACCESS: &str = "Trove needs Full Disk Access to show the Trash. Open System Settings → Privacy & Security → Full Disk Access.";

/// What Restore says on macOS, should anything still call it (the view turns it off).
pub const NO_RESTORE: &str = "Restore is not available on macOS: the Trash does not record where an item came from. Drag it out of the Trash in Finder instead.";

/// Files Finder keeps in the Trash for itself and never shows.
const HIDDEN: [&str; 2] = [".DS_Store", ".localized"];

/// `~/.Trash`, or a sentence when there is no home folder to find it in.
pub fn home_trash() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(|h| PathBuf::from(h).join(".Trash"))
        .ok_or_else(|| "Trove could not find your home folder, so it cannot find the Trash.".into())
}

/// Each volume's Trash for user `uid`: `<volumes>/<name>/.Trashes/<uid>`, where it exists.
/// ⛔ A volume in `network` (its mount point) is not looked into: checking for a `.Trashes` on
/// an SMB share is enough for macOS to ask "access files on a network volume", and a share
/// keeps its own trash on the server anyway.
pub fn volume_trashes(volumes: &Path, uid: u32, network: &[PathBuf]) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(volumes) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|v| !crate::core::mounts::is_network_point(v, network))
        .map(|v| v.join(".Trashes").join(uid.to_string()))
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    dirs
}

/// Every Trash folder on this Mac: the home Trash first, then each mounted volume's.
#[cfg(target_os = "macos")]
pub fn trash_dirs() -> Result<Vec<PathBuf>, String> {
    use std::os::unix::fs::MetadataExt;
    let home = home_trash()?;
    let mut dirs = vec![home.clone()];
    // whose Trash: the owner of the home folder, which is the person running Trove
    if let Some(uid) = home
        .parent()
        .and_then(|h| std::fs::metadata(h).ok())
        .map(|m| m.uid())
    {
        let network = crate::core::mounts::network_mount_points();
        dirs.extend(volume_trashes(Path::new("/Volumes"), uid, &network));
    }
    dirs.dedup();
    Ok(dirs)
}

/// Reading the Trash failed: a sentence for why.
pub fn read_error(e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::PermissionDenied => NEEDS_FULL_DISK_ACCESS.to_string(),
        _ => "Trove could not read the Trash. Try again, or open it in Finder.".to_string(),
    }
}

/// Deleting `name` failed: a sentence for why.
pub fn delete_error(name: &str, e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::PermissionDenied => format!(
            "Trove is not allowed to delete {name}. Check Full Disk Access in System Settings → Privacy & Security."
        ),
        io::ErrorKind::NotFound => format!("{name} is not in the Trash any more."),
        _ => format!("Could not delete {name} from the Trash."),
    }
}

fn ms(t: io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// One thing in a Trash folder: its real path (not a lossy string) and its row.
struct Found {
    path: PathBuf,
    item: RecycleItem,
}

/// What is directly inside the Trash folders. A missing folder is empty (macOS makes it on first
/// use). The first folder is the home Trash: if it cannot be read that is an error sentence, never
/// an empty list. A volume's Trash that cannot be read is left out — the volume may be ejecting.
fn found_in(dirs: &[PathBuf]) -> Result<Vec<Found>, String> {
    let mut out = Vec::new();
    for (i, dir) in dirs.iter().enumerate() {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) if i == 0 => return Err(read_error(&e)),
            Err(_) => continue,
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) if i == 0 => return Err(read_error(&e)),
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if HIDDEN.contains(&name.as_str()) {
                continue;
            }
            let path = entry.path();
            // not followed: a link in the Trash is the link, not what it points at
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue; // gone between the listing and the look — it is not there to show
            };
            let is_dir = meta.is_dir();
            out.push(Found {
                item: RecycleItem {
                    id: path.to_string_lossy().into_owned(),
                    name,
                    original_parent: None,
                    deleted_ms: ms(meta.modified()),
                    is_dir,
                    // a folder's size would mean walking it; the column shows nothing rather
                    // than guess
                    size: (!is_dir).then_some(meta.len()),
                },
                path,
            });
        }
    }
    Ok(out)
}

/// Everything in the Trash folders, as rows, newest first.
pub fn list_in(dirs: &[PathBuf]) -> Result<Vec<RecycleItem>, String> {
    let mut items: Vec<RecycleItem> = found_in(dirs)?.into_iter().map(|f| f.item).collect();
    crate::core::recycle::sort(&mut items);
    Ok(items)
}

/// Delete one real path for good; a sentence naming it if that failed.
fn delete(f: &Found) -> Result<(), String> {
    let gone = match std::fs::symlink_metadata(&f.path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&f.path),
        Ok(_) => std::fs::remove_file(&f.path),
        Err(e) => Err(e),
    };
    gone.map_err(|e| delete_error(&f.item.name, &e))
}

/// The id names something directly inside one of `dirs` (so a miss means "already gone").
fn names_inside(dirs: &[PathBuf], id: &str) -> Option<String> {
    let path = Path::new(id);
    let name = path.file_name()?.to_string_lossy().into_owned();
    let parent = path.parent()?;
    dirs.iter().any(|d| d.as_path() == parent).then_some(name)
}

/// Up to three sentences, then a count of the rest.
fn report(problems: &[String]) -> Result<(), String> {
    if problems.is_empty() {
        return Ok(());
    }
    let shown: Vec<&str> = problems.iter().take(3).map(String::as_str).collect();
    let more = problems.len() - shown.len();
    let mut out = shown.join(" ");
    if more > 0 {
        out.push_str(&format!(" And {more} more could not be deleted."));
    }
    Err(out)
}

/// Delete each of `ids` for good. Each id is matched against a fresh listing and only the
/// listed real path is deleted; every one is tried, and the ones that failed are named after.
pub fn purge_in(dirs: &[PathBuf], ids: &[String]) -> Result<(), String> {
    let found = found_in(dirs)?;
    let mut problems = Vec::new();
    for id in ids {
        match found.iter().find(|f| f.item.id == *id) {
            Some(f) => {
                if let Err(e) = delete(f) {
                    problems.push(e);
                }
            }
            None => problems.push(match names_inside(dirs, id) {
                Some(name) => format!("{name} is not in the Trash any more."),
                None => "An item outside the Trash was skipped.".to_string(),
            }),
        }
    }
    log::info!(
        "trash purge: {} item(s) asked for, {} failed",
        ids.len(),
        problems.len()
    );
    report(&problems)
}

/// Delete everything in the Trash folders; returns how many items were purged.
pub fn empty_in(dirs: &[PathBuf]) -> Result<usize, String> {
    let found = found_in(dirs)?;
    log::info!("trash empty: the Trash lists {} item(s)", found.len());
    let problems: Vec<String> = found.iter().filter_map(|f| delete(f).err()).collect();
    report(&problems).map(|()| found.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system temp dir, removed when dropped.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "trove-fake-trash-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fill(dir: &Path) {
        std::fs::write(dir.join("report.pdf"), b"12345").unwrap();
        std::fs::create_dir(dir.join("Old Photos")).unwrap();
        std::fs::write(dir.join("Old Photos").join("a.jpg"), b"x").unwrap();
        std::fs::write(dir.join(".DS_Store"), b"finder").unwrap();
    }

    /// `<root>/Volumes/USB/.Trashes/501` with one file in it, and the volumes folder.
    fn volume(root: &Path) -> (PathBuf, PathBuf) {
        let volumes = root.join("Volumes");
        let t = volumes.join("USB").join(".Trashes").join("501");
        std::fs::create_dir_all(&t).unwrap();
        std::fs::write(t.join("song.mp3"), b"la").unwrap();
        // a volume with no Trash for this person, and one for someone else
        std::fs::create_dir_all(volumes.join("Backup")).unwrap();
        std::fs::create_dir_all(volumes.join("Shared").join(".Trashes").join("502")).unwrap();
        (volumes, t)
    }

    #[test]
    fn lists_a_fake_trash_with_name_size_kind_and_no_original_place() {
        let s = Scratch::new("list");
        fill(&s.0);
        let items = list_in(std::slice::from_ref(&s.0)).unwrap();
        let mut names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            ["Old Photos", "report.pdf"],
            ".DS_Store is Finder's, not shown"
        );

        let pdf = items.iter().find(|i| i.name == "report.pdf").unwrap();
        assert_eq!(pdf.size, Some(5));
        assert!(!pdf.is_dir);
        assert!(pdf.deleted_ms > 0, "the modified time is filled in");
        assert_eq!(
            pdf.original_parent, None,
            "the Trash does not know where it came from"
        );
        assert_eq!(PathBuf::from(&pdf.id), s.0.join("report.pdf"));

        let folder = items.iter().find(|i| i.name == "Old Photos").unwrap();
        assert!(folder.is_dir);
        assert_eq!(folder.size, None, "a folder is not walked for its size");
    }

    #[test]
    fn the_home_trash_is_dot_trash_and_restore_says_why_not() {
        // HOME is not always set on Windows; where it is, the Trash is `$HOME/.Trash`
        if let Ok(d) = home_trash() {
            assert!(d.ends_with(".Trash"), "{}", d.display());
        }
        assert!(NO_RESTORE.contains("Finder") && !NO_RESTORE.contains('{'));
    }

    #[test]
    fn finds_each_volumes_trash_for_this_person_only() {
        let s = Scratch::new("volumes");
        let (volumes, usb) = volume(&s.0);
        assert_eq!(volume_trashes(&volumes, 501, &[]), vec![usb.clone()]);
        assert!(volume_trashes(&volumes, 999, &[]).is_empty());
        assert!(volume_trashes(&s.0.join("no-volumes"), 501, &[]).is_empty());
        // the same volume, mounted from a server: not looked into
        let mount = usb.parent().and_then(Path::parent).unwrap().to_path_buf();
        assert!(volume_trashes(&volumes, 501, &[mount]).is_empty());
    }

    #[test]
    fn lists_purges_and_empties_across_the_home_and_a_volume_trash() {
        let s = Scratch::new("multi");
        let home = s.0.join(".Trash");
        std::fs::create_dir(&home).unwrap();
        fill(&home);
        let (volumes, usb) = volume(&s.0);
        let mut dirs = vec![home.clone()];
        dirs.extend(volume_trashes(&volumes, 501, &[]));

        let items = list_in(&dirs).unwrap();
        assert_eq!(items.len(), 3);
        let song = items.iter().find(|i| i.name == "song.mp3").unwrap();
        assert_eq!(PathBuf::from(&song.id), usb.join("song.mp3"));

        purge_in(&dirs, std::slice::from_ref(&song.id)).unwrap();
        assert!(!usb.join("song.mp3").exists());
        assert_eq!(list_in(&dirs).unwrap().len(), 2);

        std::fs::write(usb.join("again.mp3"), b"la").unwrap();
        assert_eq!(empty_in(&dirs).unwrap(), 3);
        assert!(list_in(&dirs).unwrap().is_empty());
    }

    #[test]
    fn a_volume_trash_that_cannot_be_read_does_not_hide_the_home_trash() {
        let s = Scratch::new("badvol");
        fill(&s.0);
        let not_a_folder = s.0.join("report.pdf");
        let items = list_in(&[s.0.clone(), not_a_folder]).unwrap();
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn a_missing_trash_folder_is_an_empty_trash() {
        let s = Scratch::new("missing");
        assert_eq!(list_in(&[s.0.join("not-there")]).unwrap(), Vec::new());
    }

    #[test]
    fn a_trash_that_cannot_be_read_is_a_sentence_not_debug_text() {
        // a file where the folder should be cannot be listed — the generic sentence
        let s = Scratch::new("unreadable");
        let file = s.0.join("not-a-folder");
        std::fs::write(&file, b"").unwrap();
        let e = list_in(&[file]).unwrap_err();
        assert!(e.starts_with("Trove could not read the Trash"), "{e}");
        assert!(!e.contains('{') && !e.contains("Error"), "{e}");
    }

    #[test]
    fn no_permission_asks_for_full_disk_access() {
        let e = read_error(&io::Error::from(io::ErrorKind::PermissionDenied));
        assert_eq!(e, NEEDS_FULL_DISK_ACCESS);
        assert!(e.contains("System Settings → Privacy & Security → Full Disk Access"));
        let d = delete_error("a.txt", &io::Error::from(io::ErrorKind::PermissionDenied));
        assert!(d.contains("a.txt") && d.contains("Full Disk Access"), "{d}");
        let n = delete_error("a.txt", &io::Error::from(io::ErrorKind::NotFound));
        assert_eq!(n, "a.txt is not in the Trash any more.");
    }

    #[test]
    fn purges_files_and_folders_and_names_what_was_not_there() {
        let s = Scratch::new("purge");
        fill(&s.0);
        let dirs = [s.0.clone()];
        let ids: Vec<String> = list_in(&dirs).unwrap().into_iter().map(|i| i.id).collect();
        purge_in(&dirs, &ids).unwrap();
        assert!(list_in(&dirs).unwrap().is_empty());
        assert!(
            s.0.join(".DS_Store").exists(),
            "only what was asked for goes"
        );

        let gone = s.0.join("report.pdf").to_string_lossy().into_owned();
        let e = purge_in(&dirs, &[gone]).unwrap_err();
        assert_eq!(e, "report.pdf is not in the Trash any more.");
    }

    #[test]
    fn a_purge_never_touches_a_path_outside_the_trash() {
        let s = Scratch::new("outside");
        let trash = s.0.join("Trash");
        std::fs::create_dir(&trash).unwrap();
        let precious = s.0.join("precious.txt");
        std::fs::write(&precious, b"keep").unwrap();
        let nested = trash.join("sub");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("deep.txt"), b"keep").unwrap();

        let ids = [
            precious.to_string_lossy().into_owned(),
            trash.join("..").to_string_lossy().into_owned(),
            nested.join("deep.txt").to_string_lossy().into_owned(),
            trash
                .join("sub")
                .join("..")
                .join("..")
                .join("precious.txt")
                .to_string_lossy()
                .into_owned(),
        ];
        let e = purge_in(std::slice::from_ref(&trash), &ids).unwrap_err();
        assert!(e.contains("outside the Trash"), "{e}");
        assert!(precious.exists());
        assert!(nested.join("deep.txt").exists());
    }

    /// A name that is not UTF-8 has a lossy id; it still purges, by its real path.
    #[test]
    #[cfg(unix)]
    fn a_name_that_is_not_utf8_still_purges() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let s = Scratch::new("bytes");
        let odd = s.0.join(OsStr::from_bytes(b"caf\xe9.txt"));
        // APFS refuses names that are not UTF-8; where the file system does too, nothing to test
        if std::fs::write(&odd, b"x").is_err() {
            return;
        }
        let dirs = [s.0.clone()];
        let ids: Vec<String> = list_in(&dirs).unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids.len(), 1);
        purge_in(&dirs, &ids).unwrap();
        assert!(!odd.exists());
    }

    #[test]
    fn emptying_returns_the_count_and_leaves_nothing_listed() {
        let s = Scratch::new("empty");
        fill(&s.0);
        let dirs = [s.0.clone()];
        assert_eq!(empty_in(&dirs).unwrap(), 2);
        assert!(list_in(&dirs).unwrap().is_empty());
        assert_eq!(
            empty_in(&dirs).unwrap(),
            0,
            "an empty Trash empties to nothing"
        );
    }
}

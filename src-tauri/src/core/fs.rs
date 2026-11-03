//! Directory listing. One `FileEntry` per child, sorted folders-first by name; the frontend
//! re-sorts by any column, so this is only a stable default.

use std::collections::HashMap;
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::core::{icons, ops};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Bytes; 0 for directories (Explorer shows a blank there, the frontend decides).
    pub size: u64,
    /// Modified time as Unix milliseconds; `None` when the OS does not report one.
    pub modified_ms: Option<u64>,
    /// Creation time as Unix milliseconds — Explorer's "Date created", and on a Downloads
    /// folder the moment the file landed. `None` on a filesystem that keeps none.
    pub created_ms: Option<u64>,
    /// Lower-cased extension without the dot, files only.
    pub ext: Option<String>,
    pub is_hidden: bool,
    /// Which icon lookup applies — `folder`, `ext/<ext>` or `file/<path>` (see core/icons.rs).
    pub icon_key: String,
    /// Explorer's Type column: "File folder", "Text Document", "PNG File"…
    pub type_name: String,
    /// A link: a junction or symlink (listed as what it points at), a macOS Finder alias, or a Windows
    /// .lnk / .url shortcut (named, not followed). The list draws Explorer's arrow on it. Sent only when true: a listing is 100k entries.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_link: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

/// Read one directory level. Entries whose metadata cannot be read (a broken junction, a
/// permission wall) are still listed, as a file of unknown size — dropping them would hide
/// things Explorer shows.
pub fn read_dir(dir: &Path) -> std::io::Result<DirListing> {
    // Type names come from the shell once per extension, not once per file.
    let mut types: HashMap<Option<String>, String> = HashMap::new();
    let mut entries: Vec<FileEntry> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|e| entry_from(e.path(), e.metadata().ok(), &mut types))
        .collect();
    entries.sort_by_cached_key(default_order);
    Ok(DirListing {
        path: dir.to_string_lossy().into_owned(),
        entries,
    })
}

/// What a typed path is, so the address bar can open a file instead of failing to list it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PathKind {
    File,
    Dir,
    Missing,
}

pub fn path_kind(path: &Path) -> PathKind {
    match std::fs::metadata(path) {
        Ok(m) if m.is_dir() => PathKind::Dir,
        Ok(_) => PathKind::File,
        Err(_) => PathKind::Missing,
    }
}

/// Explorer's hidden rule: the attribute, or a dotfile name. Shared with `core/search.rs`.
pub fn is_hidden_entry(name: &str, meta: Option<&Metadata>) -> bool {
    meta.is_some_and(is_hidden) || name.starts_with('.')
}

/// A folder's Type: Explorer's words on Windows, plain "Folder" on a Mac and on Linux.
pub const FOLDER_TYPE: &str = if cfg!(windows) {
    "File folder"
} else {
    "Folder"
};

/// A macOS app bundle's name: `Safari.app`. Finder calls such a folder an "Application" and
/// launches it; the front end does the same (`utils/app-bundle.ts`). Name only: the caller
/// checks it is a directory, and on a Mac (`cfg!`), so Windows and Linux keep "Folder".
fn is_app_bundle_name(name: &str) -> bool {
    name.len() > ".app".len() && name.to_lowercase().ends_with(".app")
}

/// A directory's Type: "Application" for a Mac's `X.app`, else `FOLDER_TYPE`. The listing and
/// the Properties panel (`core/props.rs`) both use it, so the Type column and the (i) pane's
/// Type row never disagree (they did: the Mac, Calculator.app said App and Folder).
pub(crate) fn dir_type_name(name: &str) -> &'static str {
    if cfg!(target_os = "macos") && is_app_bundle_name(name) {
        "Application"
    } else {
        FOLDER_TYPE
    }
}

/// One entry from a path and its metadata. `types` caches the shell's type name per
/// extension across a listing (or a whole search), so the shell is asked once per extension.
pub(crate) fn entry_from(
    path: PathBuf,
    meta: Option<Metadata>,
    types: &mut HashMap<Option<String>, String>,
) -> FileEntry {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    // A directory entry's metadata is the LINK's, never its target's (`DirEntry::metadata`
    // does not follow), so a junction or a symlinked folder came out as an extension-less
    // "File". On Windows the link itself carries the folder attribute, so it is read off the
    // link and the target is never touched: following a link to an offline network share
    // stalls the whole listing for the network timeout. Size and dates are the link's, as in
    // Explorer. A dangling junction therefore lists as a folder (opening it errors, as in
    // Explorer). Elsewhere a symlink has no such attribute, so it is followed once (a dead
    // NFS mount can still stall there); a broken link keeps its own metadata and stays a
    // file. Hidden is read off the link itself (`Application Data` is a hidden junction).
    let link_meta = meta;
    let is_symlink = link_meta
        .as_ref()
        .is_some_and(|m| m.file_type().is_symlink());
    let meta = if is_symlink && !cfg!(windows) {
        std::fs::metadata(&path).ok().or_else(|| link_meta.clone())
    } else {
        link_meta.clone()
    };
    let is_dir = meta.as_ref().is_some_and(Metadata::is_dir)
        || link_meta.as_ref().is_some_and(ops::is_dir_link);
    let is_alias = !is_dir && is_finder_alias(&path, meta.as_ref());
    // Only the badge reads this: a .lnk / .url is opened as the file it is, never followed.
    let is_shortcut = !is_dir && is_windows_shortcut(&path);
    let is_link = is_symlink || is_alias || is_shortcut;
    let ext = if is_dir {
        None
    } else {
        path.extension().map(|e| e.to_string_lossy().to_lowercase())
    };
    let path_str = path.to_string_lossy().into_owned();
    // A folder with a desktop.ini carries its own icon (IconResource); one `exists` per
    // DIRECTORY entry, never per file, so a 100k-file listing costs a handful of checks.
    let icon_key = if is_dir && !is_symlink && path.join("desktop.ini").exists() {
        format!("file/{path_str}")
    } else {
        icons::icon_key(is_dir, ext.as_deref(), &path_str)
    };
    let type_name = if is_dir {
        dir_type_name(&name).to_string()
    } else if is_alias && !is_symlink {
        "Alias".to_string()
    } else {
        types
            .entry(ext.clone())
            .or_insert_with(|| icons::type_name(ext.as_deref()))
            .clone()
    };
    FileEntry {
        icon_key,
        type_name,
        is_hidden: is_hidden_entry(&name, link_meta.as_ref()),
        size: if is_dir {
            0
        } else {
            meta.as_ref().map_or(0, Metadata::len)
        },
        modified_ms: meta.as_ref().and_then(|m| time_ms(m.modified().ok())),
        created_ms: meta.as_ref().and_then(|m| time_ms(m.created().ok())),
        path: path_str,
        name,
        is_dir,
        ext,
        is_link,
    }
}

/// A Windows shortcut (`.lnk`) or internet shortcut (`.url`): Explorer draws the arrow on both.
/// By name only, and only on Windows; nothing is read or followed.
fn is_windows_shortcut(path: &Path) -> bool {
    cfg!(windows)
        && path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("lnk") || e.eq_ignore_ascii_case("url"))
}

/// The 16 bytes a Finder alias file starts with: bookmark data (`CFURLCreateBookmarkData`).
#[cfg(any(target_os = "macos", test))]
const ALIAS_MAGIC: &[u8; 16] = b"book\0\0\0\0mark\0\0\0\0";

/// A macOS Finder alias: a plain file holding bookmark data, not a symlink, so nothing in its
/// metadata says what it is. Finder names it `X alias` (or `X.jpg alias`), which gives it no
/// extension or one with a space, so only those names are opened and read — 16 bytes each,
/// never a `.png`. Off macOS an alias is just a file nobody made there.
#[cfg(target_os = "macos")]
fn is_finder_alias(path: &Path, meta: Option<&Metadata>) -> bool {
    alias_candidate(path, meta) && starts_with_alias_magic(path)
}

#[cfg(not(target_os = "macos"))]
fn is_finder_alias(_path: &Path, _meta: Option<&Metadata>) -> bool {
    false
}

/// Whether a name and size could be an alias, before any byte is read.
#[cfg(any(target_os = "macos", test))]
fn alias_candidate(path: &Path, meta: Option<&Metadata>) -> bool {
    let named_like_one = path
        .extension()
        .is_none_or(|e| e.to_string_lossy().contains(' '));
    named_like_one && meta.is_some_and(|m| m.is_file() && m.len() >= ALIAS_MAGIC.len() as u64)
}

#[cfg(any(target_os = "macos", test))]
fn starts_with_alias_magic(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 16];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_ok_and(|()| &head == ALIAS_MAGIC)
}

fn time_ms(t: Option<std::time::SystemTime>) -> Option<u64> {
    let d = t?.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(d.as_millis()).ok()
}

#[cfg(windows)]
fn is_hidden(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

/// macOS's `UF_HIDDEN` file flag (`chflags hidden`): Finder hides such a file whatever its name.
#[cfg(any(target_os = "macos", test))]
const UF_HIDDEN: u32 = 0x8000;

/// Whether a BSD `st_flags` word carries the hidden flag. A seam so the test needs no Mac.
#[cfg(any(target_os = "macos", test))]
fn flags_hidden(st_flags: u32) -> bool {
    st_flags & UF_HIDDEN != 0
}

#[cfg(target_os = "macos")]
fn is_hidden(meta: &Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    flags_hidden(meta.st_flags())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn is_hidden(_meta: &Metadata) -> bool {
    false
}

/// Folders first, then case-insensitive by name — what Explorer does before any column sort.
/// A cached key: one lower-casing per entry, not two per comparison (100k entries sort ~1.7M
/// times).
fn default_order(e: &FileEntry) -> (bool, String) {
    (!e.is_dir, e.name.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trove-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_mac_hidden_flag_is_bit_0x8000() {
        assert!(flags_hidden(0x8000));
        assert!(flags_hidden(0x8000 | 0x1));
        assert!(!flags_hidden(0));
        assert!(!flags_hidden(0x1));
    }

    #[test]
    fn lists_folders_first_then_files_case_insensitively() {
        let dir = scratch("order");
        fs::write(dir.join("b.txt"), b"12345").unwrap();
        fs::write(dir.join("A.TXT"), b"1").unwrap();
        fs::create_dir(dir.join("zeta")).unwrap();
        fs::create_dir(dir.join("Alpha")).unwrap();

        let names: Vec<_> = read_dir(&dir)
            .unwrap()
            .entries
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["Alpha", "zeta", "A.TXT", "b.txt"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn entry_fields_are_filled() {
        let dir = scratch("fields");
        fs::write(dir.join("Notes.MD"), b"hello").unwrap();
        fs::create_dir(dir.join("sub")).unwrap();

        let listing = read_dir(&dir).unwrap();
        let file = listing.entries.iter().find(|e| !e.is_dir).unwrap();
        let folder = listing.entries.iter().find(|e| e.is_dir).unwrap();
        assert_eq!(file.size, 5);
        assert_eq!(file.ext.as_deref(), Some("md"));
        assert!(file.modified_ms.is_some());
        assert!(
            file.created_ms.is_some(),
            "Explorer's Date created column needs this"
        );
        assert_eq!(folder.size, 0);
        assert_eq!(folder.ext, None);
        assert!(file.path.ends_with("Notes.MD"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn app_bundle_names() {
        assert!(is_app_bundle_name("Safari.app"));
        assert!(is_app_bundle_name("Old Tool.APP"));
        assert!(!is_app_bundle_name(".app"));
        assert!(!is_app_bundle_name("webapp"));
        assert!(!is_app_bundle_name("Safari.app.backup"));
    }

    #[test]
    fn an_app_folder_is_an_application_only_on_a_mac() {
        let dir = scratch("app-bundle");
        fs::create_dir(dir.join("Tool.app")).unwrap();
        let listing = read_dir(&dir).unwrap();
        let app = listing
            .entries
            .iter()
            .find(|e| e.name == "Tool.app")
            .unwrap();
        assert!(app.is_dir, "still a folder on disk, on every OS");
        let want = if cfg!(target_os = "macos") {
            "Application"
        } else {
            FOLDER_TYPE
        };
        assert_eq!(app.type_name, want);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn icon_keys_and_type_names_follow_the_kind() {
        let dir = scratch("icons");
        fs::write(dir.join("run.exe"), b"").unwrap();
        fs::write(dir.join("notes.txt"), b"").unwrap();
        fs::create_dir(dir.join("sub")).unwrap();
        fs::create_dir(dir.join("themed")).unwrap();
        fs::write(
            dir.join("themed").join("desktop.ini"),
            b"[.ShellClassInfo]\r\n",
        )
        .unwrap();
        let listing = read_dir(&dir).unwrap();
        let by_name = |n: &str| listing.entries.iter().find(|e| e.name == n).unwrap();
        assert_eq!(by_name("sub").icon_key, "folder");
        assert_eq!(
            by_name("themed").icon_key,
            format!("file/{}", dir.join("themed").to_string_lossy()),
            "a folder with a desktop.ini takes the per-file icon path"
        );
        assert_eq!(by_name("themed").type_name, FOLDER_TYPE);
        assert_eq!(by_name("sub").type_name, FOLDER_TYPE);
        assert_eq!(by_name("notes.txt").icon_key, "ext/txt");
        assert_eq!(
            by_name("run.exe").icon_key,
            format!("file/{}", dir.join("run.exe").to_string_lossy())
        );
        assert!(!by_name("notes.txt").type_name.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn dotfiles_count_as_hidden() {
        let dir = scratch("hidden");
        fs::write(dir.join(".env"), b"").unwrap();
        fs::write(dir.join("shown"), b"").unwrap();
        let listing = read_dir(&dir).unwrap();
        let hidden: Vec<_> = listing
            .entries
            .iter()
            .filter(|e| e.is_hidden)
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(hidden, [".env"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_directory_is_an_error_not_a_panic() {
        assert!(read_dir(Path::new("Z:/definitely/not/here-trove")).is_err());
    }

    #[test]
    fn path_kind_tells_files_folders_and_nothing_apart() {
        let dir = std::env::temp_dir();
        let file = dir.join(format!("trove-path-kind-{}.txt", std::process::id()));
        std::fs::write(&file, "x").unwrap();
        assert_eq!(path_kind(&dir), PathKind::Dir);
        assert_eq!(path_kind(&file), PathKind::File);
        std::fs::remove_file(&file).unwrap();
        assert_eq!(path_kind(&file), PathKind::Missing);
    }

    /// Make a link to a folder the way this OS makes one without privileges: a junction on
    /// Windows (`mklink /J`, what `Application Data` is), a symlink elsewhere.
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

    #[test]
    fn a_link_to_a_folder_is_listed_as_a_folder_and_marked_as_a_link() {
        let dir = scratch("dirlink");
        fs::create_dir(dir.join("real")).unwrap();
        link_folder(&dir.join("real"), &dir.join("linked"));

        let listing = read_dir(&dir).unwrap();
        let linked = listing.entries.iter().find(|e| e.name == "linked").unwrap();
        assert!(linked.is_dir, "was an extension-less \"File\" before");
        assert!(linked.is_link);
        assert_eq!(linked.icon_key, "folder");
        assert_eq!(linked.type_name, FOLDER_TYPE);
        let real = listing.entries.iter().find(|e| e.name == "real").unwrap();
        assert!(!real.is_link);
        // folders first: both links and folders sort ahead of files
        fs::write(dir.join("a.txt"), b"x").unwrap();
        let names: Vec<_> = read_dir(&dir)
            .unwrap()
            .entries
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["linked", "real", "a.txt"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_link_whose_target_is_gone_is_still_listed() {
        let dir = scratch("brokenlink");
        fs::create_dir(dir.join("gone")).unwrap();
        link_folder(&dir.join("gone"), &dir.join("dangling"));
        fs::remove_dir(dir.join("gone")).unwrap();

        let listing = read_dir(&dir).unwrap();
        let dangling = listing
            .entries
            .iter()
            .find(|e| e.name == "dangling")
            .unwrap();
        // Windows reads the folder attribute off the link and never follows it; elsewhere a
        // broken symlink cannot be told from a file
        assert_eq!(dangling.is_dir, cfg!(windows));
        assert!(dangling.is_link);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_shortcut_gets_the_link_badge_and_a_plain_file_does_not() {
        let dir = scratch("lnkbadge");
        for n in ["x.lnk", "Y.LNK", "z.url", "plain.txt"] {
            fs::write(dir.join(n), b"x").unwrap();
        }
        let listing = read_dir(&dir).unwrap();
        let by = |n: &str| listing.entries.iter().find(|e| e.name == n).unwrap();
        assert!(by("x.lnk").is_link);
        assert!(by("Y.LNK").is_link);
        assert!(by("z.url").is_link);
        assert!(!by("plain.txt").is_link);
        assert_ne!(by("x.lnk").type_name, "Alias");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn is_link_is_left_out_of_the_json_unless_true() {
        let dir = scratch("linkjson");
        fs::write(dir.join("plain.txt"), b"x").unwrap();
        let json = serde_json::to_string(&read_dir(&dir).unwrap()).unwrap();
        assert!(!json.contains("isLink"), "{json}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_finder_alias_is_told_by_its_first_16_bytes_and_only_read_when_named_like_one() {
        let dir = scratch("alias");
        let mut bookmark = ALIAS_MAGIC.to_vec();
        bookmark.extend_from_slice(&[7; 64]);
        for name in ["Docs alias", "photo.jpg alias", "photo.png", "plain"] {
            fs::write(dir.join(name), &bookmark).unwrap();
        }
        fs::write(dir.join("short"), b"book").unwrap();
        let is_alias = |name: &str| {
            let path = dir.join(name);
            let meta = fs::metadata(&path).ok();
            alias_candidate(&path, meta.as_ref()) && starts_with_alias_magic(&path)
        };
        assert!(is_alias("Docs alias"));
        assert!(is_alias("photo.jpg alias"));
        assert!(is_alias("plain"));
        assert!(!is_alias("photo.png"), "a real extension is never opened");
        assert!(!is_alias("short"), "shorter than the magic");
        fs::write(dir.join("plain"), b"not a bookmark at all, just text").unwrap();
        assert!(!is_alias("plain"));
        fs::remove_dir_all(dir).unwrap();
    }
}

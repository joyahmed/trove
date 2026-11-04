use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::core::fs::{self, DirListing, PathKind};
use crate::core::ops;
use crate::core::workers;

type CmdResult<T> = Result<T, String>;

fn msg<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// A folder listing that takes longer than this is logged.
const SLOW_READ_DIR: std::time::Duration = std::time::Duration::from_millis(300);

#[tauri::command(async)]
pub fn read_dir(app: AppHandle, path: String) -> CmdResult<DirListing> {
    let listing = list_folder(&path)?;
    // Mac: the person opened a privacy-guarded folder and the OS let Trove in, so the index and
    // the size walks may read it from now on (`core::privacy_folders`). Off a Mac: never `Some`.
    if let Some(folder) = crate::core::privacy_folders::note_listed(Path::new(&path)) {
        index_opened(&app, folder);
    }
    Ok(listing)
}

/// How many entries the palette preview shows under a folder row, or `None` without reading
/// it. ⛔ A highlighted row is not an act of opening: the preview counted `~/Desktop` and
/// `~/Music` as soon as a search ranked them first, and each listing raised a Mac privacy
/// prompt that took the palette's focus (Mac test, 2026-11-04). So a folder inside a guarded
/// folder the person has not opened, or on a network share or automount, is not counted, and
/// this listing never marks a guarded folder as opened (`read_dir` does, for a real opening).
#[tauri::command(async)]
pub fn palette_folder_count(path: String) -> Option<usize> {
    let guarded = crate::core::privacy_folders::unopened();
    let skip = crate::core::mounts::walk_skip_points();
    palette_count_with(&path, &guarded, &skip)
}

/// Mac: the privacy-guarded folders (Desktop, Documents, Downloads…) the person has not opened
/// in Trove yet, which searches leave out. Empty off a Mac and once every one is opened.
#[tauri::command(async)]
pub fn unopened_guarded_folders() -> Vec<String> {
    let unopened = crate::core::privacy_folders::unopened();
    crate::core::privacy_folders::in_order(&unopened, &unopened)
}

/// "Not searched: Desktop, Documents… — Allow": read each of `paths` once, so macOS asks for it
/// now, at a moment the person chose, and remember each one the OS let Trove into as opened
/// (`privacy_folders::note_listed`, the same path `read_dir` takes), so searches enter it from
/// then on. Answers the folders now opened; one the person refused stays unopened and is asked
/// again only on the next Allow. ⛔ Only a guarded folder not opened yet is read: a path the
/// webview names that is anything else is ignored.
#[tauri::command(async)]
pub fn allow_guarded_folders(app: AppHandle, paths: Vec<String>) -> Vec<String> {
    let unopened = crate::core::privacy_folders::unopened();
    let opened = allow_each(
        &paths,
        &unopened,
        can_list,
        crate::core::privacy_folders::note_listed,
    );
    for folder in &opened {
        index_opened(&app, folder.clone());
    }
    opened
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Whether the OS lets Trove read `path` — the folder AND what is guarded inside it. On a Mac
/// these reads are what raise the prompts.
///
/// ⛔ Not a listing of the folder alone: `~/Pictures`, `~/Music` and `~/Movies` list fine with
/// Photos and Apple Music refused, because the prompt guards the library INSIDE them (`Photos
/// Library.photoslibrary`, `Music/Media.localized`). A one-level read marked them opened after
/// the person said "Don't Allow", and every later walk went in (Mac test, 2026-11-04). So the
/// folder is walked a few levels down, a bounded number of entries; a refusal anywhere in that
/// walk (`EPERM`, TCC's answer — not an ordinary `EACCES` file mode) means not opened.
fn can_list(path: &Path) -> bool {
    access_granted(path, 3, 4000, refused_by_os)
}

#[cfg(unix)]
fn refused_by_os(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(libc::EPERM)
}

/// No TCC off a Unix; nothing is guarded there (`privacy_folders` is empty), so never called.
#[cfg(not(unix))]
fn refused_by_os(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied
}

/// `can_list` with the depth, the entry cap and what counts as a refusal as parameters.
fn access_granted(
    path: &Path,
    max_depth: usize,
    max_entries: usize,
    refused: impl Fn(&std::io::Error) -> bool,
) -> bool {
    if std::fs::read_dir(path).is_err() {
        return false;
    }
    let walk = walkdir::WalkDir::new(path)
        .follow_links(false)
        .min_depth(1)
        .max_depth(max_depth);
    for next in walk.into_iter().take(max_entries) {
        if let Err(e) = next {
            if e.io_error().is_some_and(&refused) {
                return false;
            }
        }
    }
    true
}

/// `allow_guarded_folders` with the read and the record as parameters, so a test can name them.
fn allow_each(
    paths: &[String],
    unopened: &[PathBuf],
    can_list: impl Fn(&Path) -> bool,
    mut note: impl FnMut(&Path) -> Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut opened = Vec::new();
    for p in paths.iter().map(PathBuf::from) {
        if !unopened.contains(&p) || opened.contains(&p) || !can_list(&p) {
            continue;
        }
        if let Some(root) = note(&p) {
            opened.push(root);
        }
    }
    opened
}

fn palette_count_with(path: &str, guarded: &[PathBuf], skip: &[PathBuf]) -> Option<usize> {
    let p = PathBuf::from(path);
    if crate::core::spotlight::palette_roots(std::slice::from_ref(&p), guarded, skip).is_empty() {
        return None;
    }
    list_folder(path).ok().map(|l| l.entries.len())
}

/// `read_dir` without the app: the listing, timed, with the failure as a sentence.
fn list_folder(path: &str) -> CmdResult<DirListing> {
    let started = std::time::Instant::now();
    // plan 08 D2: a listing on a share or removable drive gives up after `LIST_WAIT`; the
    // message names the place (`Late`), and the frontend shows it with a way to try again
    let owned = path.to_string();
    let listing = workers::guarded("list", path, workers::LIST_WAIT, move || {
        fs::read_dir(Path::new(&owned))
    })
    .map_err(|late| late.to_string())?
    .map_err(|e| read_dir_failed(path, &e))?;
    let took = started.elapsed();
    if took >= SLOW_READ_DIR {
        log::warn!("slow read_dir: {}ms", took.as_millis());
        log::debug!("slow read_dir: {path}");
    }
    Ok(listing)
}

/// A guarded folder just opened: indexed now if the index is on (`core::index::start_opened`).
fn index_opened(app: &AppHandle, folder: PathBuf) {
    use tauri::Manager;
    let settings = crate::commands::index_settings::current(app);
    if !settings.on {
        return;
    }
    if let Some(index) = app.try_state::<crate::core::index::Index>() {
        crate::core::index::start_opened(&index, folder, &settings.skip_folders);
    }
}

/// The message for a folder that could not be listed. A folder that is gone (a Recent entry,
/// a typed path, one deleted behind the tab) gets the same plain sentence a failed open does,
/// `"x" is no longer there.`, and the OS text goes to the log; anything else keeps the path
/// and the OS's words, which are the only clue to what went wrong.
fn read_dir_failed(path: &str, err: &std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::NotFound {
        log::warn!("read_dir: {err}");
        log::debug!("read_dir {path}: {err}");
        return open_failed(Path::new(path), Some(err));
    }
    format!("{path}: {err}")
}

/// Whether a typed path is a file, a folder or nothing — the address bar opens a file.
#[tauri::command(async)]
pub fn path_kind(path: String) -> PathKind {
    // plan 08 D1: on a share that does not answer in `PROBE_WAIT` the answer is `Dir`, so the
    // address bar goes on to list it, and the listing's own deadline and message take over
    let owned = path.clone();
    workers::guarded("probe", &path, workers::PROBE_WAIT, move || {
        fs::path_kind(Path::new(&owned))
    })
    .unwrap_or(PathKind::Dir)
}

/// The drive letters mapped to a network share, for the sidebar's Network group (5.3b).
#[tauri::command(async)]
pub fn mapped_drives() -> Vec<String> {
    crate::core::mounts::mapped_letters()
}

/// Shows the Windows credential box for the share holding `path` and connects (plan 05 5.3d).
/// `code` is the OS error the listing failed with (5 or 1326). Refuses anything that is not a
/// real share — a local path or a WSL distro has no password to type.
#[tauri::command(async)]
pub fn net_sign_in(
    window: tauri::WebviewWindow,
    path: String,
    code: i32,
) -> Result<crate::core::net::SignIn, String> {
    let share = crate::core::net::sign_in_target(&path)
        .ok_or_else(|| format!("{path}: not a network share that takes a password"))?;
    if !crate::core::net::wants_credentials(Some(code)) {
        return Err(format!(
            "{path}: a user name and password would not fix this"
        ));
    }
    #[cfg(windows)]
    let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let owner = {
        let _ = &window;
        0isize
    };
    crate::core::net::sign_in(&share, owner, code)
}

/// Open a file with its default app (or a folder in the OS shell).
///
/// A failure is shown as a plain sentence; the raw error stays in the log only. The opener's
/// own text is a Debug dump (`Launcher "/usr/bin/open" failed with ExitStatus(256)` on a Mac,
/// an OS error code from ShellExecuteExW on Windows) and none of them say why.
#[tauri::command(async)]
pub fn open_path(app: AppHandle, path: String) -> CmdResult<()> {
    app.opener()
        .open_path(path.as_str(), None::<&str>)
        .map_err(|e| {
            log::warn!("open_path: {e}");
            log::debug!("open_path {path}: {e}");
            let io = match &e {
                tauri_plugin_opener::Error::Io(io) => Some(io),
                _ => None,
            };
            open_failed(Path::new(&path), io)
        })
}

/// "this Mac" where Finder would say it, "this computer" on Windows and Linux.
const THIS_DEVICE: &str = if cfg!(target_os = "macos") {
    "this Mac"
} else {
    "this computer"
};

/// Windows `ERROR_NO_ASSOCIATION`: ShellExecuteExW found no app for the file's type.
const ERROR_NO_ASSOCIATION: i32 = 1155;

/// Why an open failed, as far as Trove can tell.
#[derive(Debug, PartialEq, Eq)]
enum OpenFailure {
    Gone,
    Denied,
    NoApp,
    Other,
}

/// Sort a failed open by its cause. `err` is the opener's io error when it had one.
///
/// - Gone: the path is not there any more.
/// - Denied: the OS refused access - the opener said so, or the file cannot be read.
/// - NoApp: only when the opener says it - Windows `ERROR_NO_ASSOCIATION`, or the Mac's
///   `/usr/bin/open` exiting non-zero on a readable file (`.DS_Store`). Linux spawns `xdg-open`
///   detached, so its exit is never seen and a Linux failure is never NoApp.
/// - Other: anything else, a folder included.
fn open_failure(path: &Path, err: Option<&std::io::Error>) -> OpenFailure {
    use std::io::ErrorKind;
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::PermissionDenied => return OpenFailure::Denied,
        Err(_) => return OpenFailure::Gone,
    };
    if err.is_some_and(|e| e.kind() == ErrorKind::PermissionDenied) {
        return OpenFailure::Denied;
    }
    if meta.is_file()
        && std::fs::File::open(path).is_err_and(|e| e.kind() == ErrorKind::PermissionDenied)
    {
        return OpenFailure::Denied;
    }
    if meta.is_dir() {
        return OpenFailure::Other;
    }
    match err {
        Some(e) if cfg!(windows) && e.raw_os_error() == Some(ERROR_NO_ASSOCIATION) => {
            OpenFailure::NoApp
        }
        Some(e)
            if cfg!(target_os = "macos")
                && e.kind() == ErrorKind::Other
                && e.to_string().starts_with("Launcher ") =>
        {
            OpenFailure::NoApp
        }
        _ => OpenFailure::Other,
    }
}

/// The sentence for an open that failed: one per cause, the raw detail left to the log.
pub(crate) fn open_failed(path: &Path, err: Option<&std::io::Error>) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    match open_failure(path, err) {
        OpenFailure::Gone => format!("\"{name}\" is no longer there."),
        OpenFailure::Denied => format!("Trove can't open \"{name}\": access is denied."),
        OpenFailure::NoApp => format!("No app on {THIS_DEVICE} opens \"{name}\"."),
        OpenFailure::Other => format!("Couldn't open \"{name}\"."),
    }
}

/// The only schemes `open_url` will hand to the OS (the frontend's `BROWSER_SCHEMES`).
const OPEN_URL_SCHEMES: [&str; 4] = ["http", "https", "ftp", "mailto"];

/// Refuse anything that is not a plain web / mail link, so a bad string can't launch
/// `file:`, `ms-settings:`, `search-ms:` or a bare path. Scheme match is case-insensitive.
fn check_url_scheme(url: &str) -> CmdResult<()> {
    let refuse = || "Trove only opens http, https, ftp and mailto links.".to_string();
    let url = url.trim();
    if url.chars().any(|c| c.is_control()) {
        return Err(refuse());
    }
    let Some((scheme, rest)) = url.split_once(':') else {
        return Err(refuse());
    };
    let scheme = scheme.to_ascii_lowercase();
    if !OPEN_URL_SCHEMES.contains(&scheme.as_str()) {
        return Err(refuse());
    }
    // Web links need `//host`; mailto needs an address.
    let ok = if scheme == "mailto" {
        !rest.is_empty()
    } else {
        rest.strip_prefix("//")
            .is_some_and(|r| !r.is_empty() && !r.starts_with('/'))
    };
    if ok {
        Ok(())
    } else {
        Err(refuse())
    }
}

/// Open a URL with the OS default browser.
///
/// ⛔ Not `open_path`: the `open` crate stats the argument (`path.metadata()?`) when no
/// explicit app is given, which fails on an `https://…` string. `open_url` is a distinct
/// crate function with no such check — the two are not interchangeable.
#[tauri::command(async)]
pub fn open_url(app: AppHandle, url: String) -> CmdResult<()> {
    check_url_scheme(&url)?;
    app.opener().open_url(url, None::<&str>).map_err(msg)
}

#[tauri::command(async)]
pub fn rename_entry(path: String, new_name: String) -> CmdResult<String> {
    ops::rename(Path::new(&path), &new_name)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(msg)
}

#[tauri::command(async)]
pub fn create_folder(dir: String) -> CmdResult<String> {
    ops::create_folder(Path::new(&dir))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(msg)
}

/// "Retry as administrator" (plan 05 5.6): the one operation that failed with access denied,
/// run again in an elevated copy of Trove that does it and exits (`core/elevate.rs`).
#[tauri::command(async)]
pub fn retry_elevated(op: crate::core::elevate::ElevatedOp) -> CmdResult<String> {
    crate::core::elevate::run_elevated(&op)
}

/// A failed `trash_entries`. Every failure is the plain sentence it always was, except one:
/// a place with no Recycle Bin arrives as `{ noBin, message }`, so the frontend can offer a
/// permanent delete instead of guessing from the path (`api/fs.ts` `trashEntries`).
#[derive(serde::Serialize, Debug)]
#[serde(untagged)]
pub enum TrashError {
    #[serde(rename_all = "camelCase")]
    NoBin {
        /// `WSL`, a drive (`N:`) or a share (`\\server\share`)
        no_bin: String,
        /// `noBin` (the place has none), `off` (turned off), `tooBig` (bigger than the bin) or
        /// `denied` (macOS refused Trove the Trash; items not in `paths` already went to it)
        reason: &'static str,
        /// every path that cannot go to a bin; the rest of the batch can
        paths: Vec<String>,
        message: String,
    },
    Other(String),
}

impl TrashError {
    fn from_io(e: std::io::Error) -> Self {
        match ops::no_recycle_bin(&e) {
            Some(why) => TrashError::NoBin {
                no_bin: why.place.clone(),
                reason: match why.why {
                    ops::Why::NoBin => "noBin",
                    ops::Why::TurnedOff => "off",
                    ops::Why::TooBig => "tooBig",
                    ops::Why::Denied => "denied",
                },
                paths: why
                    .paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
                message: e.to_string(),
            },
            None => TrashError::Other(e.to_string()),
        }
    }
}

#[tauri::command(async)]
pub fn trash_entries(paths: Vec<String>) -> Result<(), TrashError> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    ops::trash(&paths).map_err(TrashError::from_io)
}

/// New → Text document and friends: an empty `<base_name>.<ext>` with Explorer's numbering.
#[tauri::command(async)]
pub fn create_file(dir: String, base_name: String, ext: String) -> CmdResult<String> {
    ops::create_file(Path::new(&dir), &base_name, &ext)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(msg)
}

/// Compress to ZIP file: one archive beside the items; returns its path for selection.
#[tauri::command(async)]
pub fn compress_entries(paths: Vec<String>) -> CmdResult<String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    ops::zip_entries(&paths)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(msg)
}

/// Shift+Delete: gone for good, no Recycle Bin. The frontend asks first.
#[tauri::command(async)]
pub fn delete_entries(paths: Vec<String>) -> CmdResult<()> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    ops::delete_permanently(&paths).map_err(msg)
}

/// "Always keep on this device" (`keep`) or "Free up space" for each path (plan 05 5.4). Every
/// path is tried; the error names the first one that failed and how many more did.
#[tauri::command(async)]
pub fn set_cloud_pin(paths: Vec<String>, keep: bool) -> CmdResult<()> {
    let failed: Vec<&String> = paths
        .iter()
        .filter(|p| match ops::set_cloud_pin(Path::new(p), keep) {
            Ok(()) => false,
            Err(e) => {
                log::warn!("set_cloud_pin: {e}");
                log::debug!("set_cloud_pin {p}: {e}");
                true
            }
        })
        .collect();
    cloud_pin_message(&failed, keep).map_or(Ok(()), Err)
}

/// The OneDrive sidebar row's sync glyph (plan 05 5.4): `None` when `path` is in no sync root.
#[tauri::command(async)]
pub fn cloud_sync_status(path: String) -> Option<crate::core::sync_root::SyncStatus> {
    crate::core::sync_root::sync_status(Path::new(&path))
}

/// The sentence for the paths `set_cloud_pin` could not change, or `None` when all went.
fn cloud_pin_message(failed: &[&String], keep: bool) -> Option<String> {
    let first = failed.first()?;
    let name = Path::new(first.as_str())
        .file_name()
        .map_or_else(|| first.to_string(), |n| n.to_string_lossy().into_owned());
    let what = if keep {
        "keep it on this device"
    } else {
        "free up its space"
    };
    Some(match failed.len() {
        1 => format!("Trove couldn't {what}: \"{name}\"."),
        n => format!("Trove couldn't {what}: \"{name}\" and {} more.", n - 1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_reads_each_unopened_guarded_folder_once_and_records_what_worked() {
        let desk = PathBuf::from("/Users/x/Desktop");
        let docs = PathBuf::from("/Users/x/Documents");
        let music = PathBuf::from("/Users/x/Music");
        let unopened = [desk.clone(), docs.clone(), music.clone()];
        let asked = std::cell::RefCell::new(Vec::<PathBuf>::new());
        let mut noted = Vec::new();
        let paths: Vec<String> = [
            "/Users/x/Desktop",
            "/Users/x/Documents",
            "/Users/x/Documents", // twice: read once
            "/Users/x/Music",
            "/etc",                   // not a guarded folder: never read
            "/Users/x/Desktop/inner", // inside one: not what Allow opens
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let opened = allow_each(
            &paths,
            &unopened,
            |p| {
                asked.borrow_mut().push(p.to_path_buf());
                // the person allowed Documents only
                p == docs.as_path()
            },
            |p| {
                noted.push(p.to_path_buf());
                Some(p.to_path_buf())
            },
        );
        assert_eq!(opened, std::slice::from_ref(&docs));
        assert_eq!(noted, std::slice::from_ref(&docs));
        assert_eq!(*asked.borrow(), [desk, docs, music]);
        // nothing unopened: nothing read
        let none = allow_each(&paths, &[], |_| panic!("read"), |_| None);
        assert!(none.is_empty());
    }

    /// ⭐ "Don't Allow" on Photos still marked `~/Pictures` opened: the folder itself lists, the
    /// library inside it is what was refused. A refusal anywhere in the bounded walk = not opened.
    #[cfg(unix)]
    #[test]
    fn a_folder_whose_library_inside_was_refused_is_not_opened() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("trove-allow-deep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let lib = dir.join("Pictures/Photos Library.photoslibrary");
        std::fs::create_dir_all(lib.join("originals")).unwrap();
        std::fs::create_dir_all(dir.join("Movies/clips")).unwrap();
        std::fs::set_permissions(&lib, std::fs::Permissions::from_mode(0o000)).unwrap();
        // a test run as root reads anything; the refusal cannot be staged then
        let staged = std::fs::read_dir(&lib).is_err();
        let refused = |e: &std::io::Error| e.kind() == std::io::ErrorKind::PermissionDenied;
        if staged {
            assert!(!access_granted(&dir.join("Pictures"), 3, 4000, refused));
        }
        assert!(access_granted(&dir.join("Movies"), 3, 4000, refused));
        assert!(!access_granted(&dir.join("Nope"), 3, 4000, refused));
        std::fs::set_permissions(&lib, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_palette_preview_never_counts_an_unopened_guarded_folder() {
        let dir = std::env::temp_dir().join(format!("trove-pcount-{}", std::process::id()));
        let desk = dir.join("Desktop");
        std::fs::create_dir_all(desk.join("inner")).unwrap();
        std::fs::write(desk.join("a.txt"), b"x").unwrap();
        let path = desk.to_string_lossy().into_owned();
        let inner = desk.join("inner").to_string_lossy().into_owned();
        assert_eq!(
            palette_count_with(&path, std::slice::from_ref(&desk), &[]),
            None
        );
        assert_eq!(
            palette_count_with(&inner, std::slice::from_ref(&desk), &[]),
            None
        );
        assert_eq!(
            palette_count_with(&path, &[], std::slice::from_ref(&dir)),
            None
        );
        assert_eq!(palette_count_with(&path, &[], &[]), Some(2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cloud_pin_message_names_the_first_failure() {
        assert_eq!(cloud_pin_message(&[], true), None);
        let a = r"C:\OneDrive\a.docx".to_string();
        let b = r"C:\OneDrive\b.docx".to_string();
        let one = cloud_pin_message(&[&a], true).unwrap();
        assert!(one.contains("keep it on this device"), "{one}");
        let two = cloud_pin_message(&[&a, &b], false).unwrap();
        assert!(
            two.contains("free up its space") && two.contains("1 more"),
            "{two}"
        );
    }

    #[test]
    fn open_url_allows_only_web_and_mail_schemes() {
        for ok in [
            "http://example.com",
            "https://example.com/a?b=c",
            "HTTPS://x",
            "ftp://host/file",
            "mailto:alex@example.com",
        ] {
            assert!(check_url_scheme(ok).is_ok(), "{ok} should pass");
        }
        for bad in [
            "file:///C:/x.exe",
            "ms-settings:",
            "javascript:alert(1)",
            "search-ms:query=x",
            r"C:\x.exe",
            "",
            "https:",
            "https://",
            "https:\n//x",
        ] {
            assert!(check_url_scheme(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_place_with_no_bin_is_named_and_every_other_failure_stays_a_sentence() {
        let refused = trash_entries(vec![r"\\wsl$\Ubuntu\a.txt".into()]).unwrap_err();
        let json = serde_json::to_value(&refused).unwrap();
        assert_eq!(json["noBin"], "WSL");
        assert_eq!(json["reason"], "noBin");
        assert_eq!(json["paths"][0], r"\\wsl$\Ubuntu\a.txt");
        assert!(json["message"]
            .as_str()
            .unwrap()
            .starts_with("WSL folders have no Recycle Bin"));

        let other = TrashError::from_io(std::io::Error::other("disk on fire"));
        assert_eq!(serde_json::to_value(&other).unwrap(), "disk on fire");
    }

    /// Seen on a Mac: a Recent folder deleted outside Trove toasted
    /// `/Users/alex/x: No such file or directory (os error 2)`. It is the open's sentence now,
    /// with no OS text; a folder that is there but unreadable keeps the OS's words.
    #[test]
    fn a_missing_folder_is_no_longer_there_in_plain_words() {
        let root = std::env::temp_dir().join(format!("trove-read-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let gone = root.join("x");
        let err = list_folder(&gone.to_string_lossy()).unwrap_err();
        assert_eq!(err, "\"x\" is no longer there.");
        assert!(!err.contains("os error"), "{err}");

        // not NotFound: the path and the OS's words stay, they are the only clue
        let other = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let raw = read_dir_failed("/a/locked", &other);
        assert!(raw.starts_with("/a/locked: "), "{raw}");

        assert!(list_folder(&root.to_string_lossy()).is_ok());
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// Seen on a Mac: opening `.DS_Store` toasted `Launcher "/usr/bin/open" ... ExitStatus(256)`.
    /// Seen on Windows: every failed open said "No app", access denied included.
    #[test]
    fn a_failed_open_names_its_cause_in_a_plain_sentence() {
        use std::io::{Error, ErrorKind};
        let root = std::env::temp_dir().join(format!("trove-open-failed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join(".DS_Store");
        std::fs::write(&file, b"x").unwrap();
        let folder = root.join("docs");
        std::fs::create_dir(&folder).unwrap();
        let device = if cfg!(target_os = "macos") {
            "this Mac"
        } else {
            "this computer"
        };
        let no_app = format!("No app on {device} opens \".DS_Store\".");
        let generic = "Couldn't open \".DS_Store\".";

        // Gone wins over any opener error.
        let denied = Error::from(ErrorKind::PermissionDenied);
        assert_eq!(
            open_failed(&root.join("gone.txt"), Some(&denied)),
            "\"gone.txt\" is no longer there."
        );
        // Access denied, from the opener (Windows ERROR_ACCESS_DENIED is os error 5).
        let denied_text = "Trove can't open \".DS_Store\": access is denied.";
        assert_eq!(open_failed(&file, Some(&denied)), denied_text);
        if cfg!(windows) {
            assert_eq!(
                open_failed(&file, Some(&Error::from_raw_os_error(5))),
                denied_text
            );
        }
        assert_eq!(
            open_failed(&folder, Some(&denied)),
            "Trove can't open \"docs\": access is denied."
        );

        // No app: only when the opener says so, in its own OS's words.
        let win_no_assoc = Error::from_raw_os_error(ERROR_NO_ASSOCIATION);
        let mac_launcher = Error::other(
            r#"Launcher "/usr/bin/open" "--" "x" failed with ExitStatus(unix_wait_status(256))"#,
        );
        if cfg!(windows) {
            assert_eq!(open_failed(&file, Some(&win_no_assoc)), no_app);
            assert_eq!(open_failed(&file, Some(&mac_launcher)), generic);
        } else if cfg!(target_os = "macos") {
            assert_eq!(open_failed(&file, Some(&mac_launcher)), no_app);
            assert_eq!(open_failed(&file, Some(&win_no_assoc)), generic);
        } else {
            assert_eq!(open_failed(&file, Some(&mac_launcher)), generic);
            assert_eq!(open_failed(&file, Some(&win_no_assoc)), generic);
        }

        // Anything else is the generic sentence: a folder, an unknown error, no io error at all.
        assert_eq!(
            open_failed(&folder, Some(&mac_launcher)),
            "Couldn't open \"docs\"."
        );
        assert_eq!(
            open_failed(&file, Some(&Error::other("disk on fire"))),
            generic
        );
        assert_eq!(open_failed(&file, None), generic);

        for err in [
            Some(&denied),
            Some(&win_no_assoc),
            Some(&mac_launcher),
            None,
        ] {
            for path in [&file, &folder] {
                let said = open_failed(path, err);
                assert!(
                    !said.contains("Launcher")
                        && !said.contains("ExitStatus")
                        && !said.contains("os error"),
                    "{said}"
                );
            }
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}

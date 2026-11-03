use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::core::fs::{self, DirListing, PathKind};
use crate::core::ops;

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

/// `read_dir` without the app: the listing, timed, with the failure as a sentence.
fn list_folder(path: &str) -> CmdResult<DirListing> {
    let started = std::time::Instant::now();
    let listing = fs::read_dir(Path::new(path)).map_err(|e| read_dir_failed(path, &e))?;
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
    fs::path_kind(Path::new(&path))
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

#[cfg(test)]
mod tests {
    use super::*;

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

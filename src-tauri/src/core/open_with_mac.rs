//! macOS "Open With ▸" (plan 15 G.61): the apps Launch Services lists for a file, as Finder's
//! own "Open With" does, and `open -a <app> <files>` to open them in one.
//!
//! The list comes from `NSWorkspace`: `URLsForApplicationsToOpenURL:` (macOS 12+) for every
//! app, `URLForApplicationToOpenURL:` for the default. On an older Mac only the default is
//! listed. Called through `msg_send!` so no AppKit binding crate is added: tao already links
//! AppKit into every Mac build.
//!
//! The naming, the argv and the shaping are plain functions tested on every OS. There is no
//! system app picker to call here the way Windows has `SHOpenWithDialog` — Finder's "Other…"
//! is its own panel — so the Mac menu has no "Choose another app…".

use std::path::Path;

use super::open_with::RawApp;

/// What Finder shows for an app bundle: `Preview` for `/System/Applications/Preview.app`.
pub fn app_name(path: &str) -> String {
    let file = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    match file.len().checked_sub(4) {
        Some(cut) if file.is_char_boundary(cut) && file[cut..].eq_ignore_ascii_case(".app") => {
            file[..cut].to_string()
        }
        _ => file,
    }
}

/// An app bundle path as the menu's raw entry: its path is its id, its name Finder's.
pub fn raw_app(path: &str) -> RawApp {
    RawApp {
        id: path.to_string(),
        name: app_name(path),
        icon: None,
    }
}

/// Whether `app` is a bundle path `open -a` may be handed: absolute, ending `.app` (any case).
/// The id comes back from the frontend, so it is checked, never trusted.
pub fn is_app_path(app: &str) -> bool {
    app.starts_with('/') && app.len() > 5 && app[app.len() - 4..].eq_ignore_ascii_case(".app")
}

/// What opening `files` in `app` spawns: `open -a <app path> <files…>` — the bundle by path, so
/// the copy that was listed is the one that starts, never another one found by name.
pub fn open_argv(app: &str, files: &[String]) -> Vec<String> {
    let mut argv = vec!["open".to_string(), "-a".to_string(), app.to_string()];
    argv.extend(files.iter().cloned());
    argv
}

/// Whether `path` can become a file URL at all. `+[NSURL fileURLWithPath:]` answers nil for an
/// empty path or one holding a NUL (an archive member's path does: `a.zip\0docs/a.txt`), and
/// objc2 aborts the app on that nil (MAC-C.8.7). Every Mac call that turns a path into a URL
/// goes through [`file_url`], which checks this first.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn file_url_ok(path: &str) -> bool {
    !path.is_empty() && !path.contains('\0')
}

/// `path` as a file URL, or `None` where Foundation has none for it. Never panics: the guard
/// above, then objc2's fallible constructor rather than `fileURLWithPath:`.
#[cfg(target_os = "macos")]
pub fn file_url(path: &Path) -> Option<objc2::rc::Retained<objc2_foundation::NSURL>> {
    if !file_url_ok(&path.to_string_lossy()) {
        return None;
    }
    objc2_foundation::NSURL::from_file_path(path)
}

#[cfg(target_os = "macos")]
pub fn apps(path: &Path) -> Vec<super::open_with::OpenWithApp> {
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{NSArray, NSURL};

    let (all, default) = autoreleasepool(|_| {
        let Some(url) = file_url(path) else {
            log::warn!("open with: no file URL for the item");
            log::debug!("open with: no file URL for {path:?}");
            return (Vec::new(), None);
        };
        // SAFETY: `+[NSWorkspace sharedWorkspace]` takes nothing and returns the shared object.
        let ws: Retained<AnyObject> = unsafe { msg_send![class!(NSWorkspace), sharedWorkspace] };
        let path_of = |u: &NSURL| u.path().map(|p| p.to_string());
        // SAFETY: a documented NSWorkspace method taking an NSURL and returning one or nil.
        let default: Option<Retained<NSURL>> =
            unsafe { msg_send![&*ws, URLForApplicationToOpenURL: &*url] };
        // SAFETY: asks whether the selector exists (macOS 12+) before sending it.
        let has_list: bool =
            unsafe { msg_send![&*ws, respondsToSelector: sel!(URLsForApplicationsToOpenURL:)] };
        let mut all: Vec<String> = Vec::new();
        if has_list {
            // SAFETY: the selector exists (checked above); it returns a non-nil NSArray<NSURL>.
            let list: Retained<NSArray<NSURL>> =
                unsafe { msg_send![&*ws, URLsForApplicationsToOpenURL: &*url] };
            for i in 0..list.count() {
                all.extend(path_of(&list.objectAtIndex(i)));
            }
        }
        (all, default.as_deref().and_then(path_of))
    });
    let mut raw: Vec<RawApp> = default.iter().map(|d| raw_app(d)).collect();
    raw.extend(all.iter().map(|p| raw_app(p)));
    super::open_with::shape(raw, |a| default.as_deref() == Some(a.id.as_str()))
}

#[cfg(target_os = "macos")]
pub fn open(app: &str, files: &[String]) -> Result<(), String> {
    if !is_app_path(app) {
        return Err(format!("{app} is not an app bundle"));
    }
    let argv = open_argv(app, files);
    let out = std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("could not start open: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "open -a {app} exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// MAC-C.8.7: an archive member's path holds a NUL, which `+[NSURL fileURLWithPath:]`
    /// answers with nil, and objc2 aborts on that nil. A bad path lists no apps, never panics.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_path_no_file_url_can_hold_lists_no_apps_and_does_not_panic() {
        assert!(apps(Path::new("")).is_empty());
        assert!(apps(Path::new("/tmp/a.zip\u{0}docs/a.txt")).is_empty());
        // a well-formed path to nothing is still a valid URL: no panic, whatever is listed
        let _ = apps(Path::new("/no/such/dir/trove-missing.txt"));
    }

    #[test]
    fn only_a_path_a_file_url_can_hold_is_handed_to_foundation() {
        assert!(file_url_ok("/Users/j/a.txt"));
        assert!(file_url_ok("/no/such/file"));
        assert!(!file_url_ok(""));
        assert!(!file_url_ok("/tmp/a.zip\u{0}docs/a.txt"));
    }

    #[test]
    fn an_app_is_named_without_its_bundle_extension() {
        assert_eq!(app_name("/System/Applications/Preview.app"), "Preview");
        assert_eq!(
            app_name("/Applications/Visual Studio Code.APP"),
            "Visual Studio Code"
        );
        assert_eq!(app_name("/Applications/odd"), "odd");
        assert_eq!(app_name("/Applications/.app"), "");
    }

    #[test]
    fn only_an_absolute_bundle_path_is_opened_with() {
        assert!(is_app_path("/Applications/TextEdit.app"));
        assert!(is_app_path("/Applications/X.APP"));
        assert!(!is_app_path("TextEdit.app"));
        assert!(!is_app_path("/usr/bin/evil"));
        assert!(!is_app_path("/.app"));
    }

    #[test]
    fn the_argv_names_the_bundle_by_path_and_passes_every_file() {
        let files = vec!["/Users/j/a b.txt".to_string(), "/Users/j/c.txt".to_string()];
        assert_eq!(
            open_argv("/Applications/TextEdit.app", &files),
            [
                "open",
                "-a",
                "/Applications/TextEdit.app",
                "/Users/j/a b.txt",
                "/Users/j/c.txt"
            ]
        );
    }

    #[test]
    fn the_default_listed_twice_is_kept_once_and_first() {
        let raw = vec![
            raw_app("/Applications/TextEdit.app"),
            raw_app("/Applications/Code.app"),
            raw_app("/Applications/TextEdit.app"),
        ];
        let list = super::super::open_with::shape(raw, |a| a.id == "/Applications/TextEdit.app");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "TextEdit");
        assert!(list[0].is_default);
        assert!(!list[1].is_default);
    }
}

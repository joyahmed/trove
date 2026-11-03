//! macOS only: the app's life as a Mac app — the Dock icon brings a window back, closing the
//! last window leaves the app running (⌘Q quits), and Finder's "Open With → Trove", a folder
//! dropped on the Dock icon and `open -a Trove <dir>` open that folder.
//!
//! Windows and Linux never compile this file; their launches are argv and the single-instance
//! handler in `lib.rs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, Url};

use crate::commands::launch::LaunchGate;
use crate::commands::windows::is_explorer_label;
use crate::core::launch::Launch;

/// What a path on disk is, as far as opening it goes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Folder,
    File,
    Missing,
}

fn kind_on_disk(p: &Path) -> Kind {
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => Kind::Folder,
        Ok(_) => Kind::File,
        Err(_) => Kind::Missing,
    }
}

/// The launch one opened URL asks for: a folder opens itself, a file opens its folder with it
/// selected, a path that is not there opens its parent. Anything but `file://` is ignored.
pub fn launch_for_url(url: &Url, kind: impl Fn(&Path) -> Kind) -> Option<Launch> {
    if url.scheme() != "file" {
        return None;
    }
    let path = url.to_file_path().ok()?;
    // a folder URL ends in `/`; the frontend's paths do not (the root itself stays `/`)
    let path = match path.to_str() {
        Some(s) if s.len() > 1 && s.ends_with('/') => PathBuf::from(s.trim_end_matches('/')),
        _ => path,
    };
    let text = |p: &Path| p.to_string_lossy().into_owned();
    Some(match kind(&path) {
        Kind::Folder => Launch {
            path: Some(text(&path)),
            ..Launch::default()
        },
        Kind::File => Launch {
            path: path.parent().map(text),
            select: Some(text(&path)),
            ..Launch::default()
        },
        Kind::Missing => Launch {
            path: Some(text(path.parent()?)),
            ..Launch::default()
        },
    })
}

/// Set on `RunEvent::Ready`, which Tauri sends right after `setup`, so after the config's
/// windows exist.
///
/// ⛔ A cold start from Finder (`open -a Trove <dir>`, "Open With") delivers `Opened` BEFORE
/// `Ready`: no window exists yet, not even the config's `main`. Building `main` there made
/// Tauri's own setup panic a moment later — "a webview with label `main` already exists" — and
/// the launch died with no window. Seen on the bundle, 2026-10-07. Before `Ready`, park only.
static READY: AtomicBool = AtomicBool::new(false);

/// Where an opened launch goes, given the state of the app and its main window.
#[derive(Debug, PartialEq)]
pub enum Route {
    /// `main` exists and its frontend listens: a new tab there, through `LAUNCH_EVENT`.
    Emit,
    /// `main` exists but its frontend has not asked for its launch yet (a cold start from
    /// Finder): park it for `initial_launch`.
    Park,
    /// No `main` (its window was closed and the app kept running): park it, then build one.
    Rebuild,
}

pub fn route(ready: bool, main_exists: bool, delivered: bool) -> Route {
    match (ready, main_exists, delivered) {
        // setup has not built the config's windows yet; the `main` it builds will ask
        (false, _, _) => Route::Park,
        (true, false, _) => Route::Rebuild,
        (true, true, false) => Route::Park,
        (true, true, true) => Route::Emit,
    }
}

/// The run loop's macOS events. Everything else is left to Tauri.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    match event {
        RunEvent::Ready => READY.store(true, Ordering::SeqCst),
        // a reopen before setup has nothing to show yet, and setup shows `main` itself
        RunEvent::Reopen { .. } if !READY.load(Ordering::SeqCst) => {}
        // The Dock icon was clicked (or `open -a`, or AppleScript's `reopen`).
        RunEvent::Reopen { .. } => reopen(app),
        RunEvent::Opened { urls } => {
            log::info!("opened {} url(s)", urls.len());
            log::debug!("opened {urls:?}");
            for launch in urls.iter().filter_map(|u| launch_for_url(u, kind_on_disk)) {
                open(app, launch);
            }
        }
        _ => {}
    }
}

/// A window back on screen, unless an explorer window already is one. Checked by hand rather
/// than trusting `has_visible_windows`: the Spotlight strip counts as a visible window to
/// AppKit, and a Dock click while it is up must still bring an explorer window back.
pub fn reopen<R: Runtime>(app: &AppHandle<R>) {
    let windows = app.webview_windows();
    let mut explorer: Vec<_> = windows
        .iter()
        .filter(|(label, _)| is_explorer_label(label))
        .map(|(_, w)| w)
        .collect();
    let on_screen = |w: &&tauri::WebviewWindow<R>| {
        w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)
    };
    if explorer.iter().any(on_screen) {
        return;
    }
    // `main` first: it is the one that hears launches and owns Spotlight
    explorer.sort_by_key(|w| w.label() != "main");
    match explorer.first() {
        Some(w) => {
            log::info!("reopen: showing {}", w.label());
            if let Err(e) = w.show() {
                log::error!("reopen: show failed: {e}");
            }
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        None => {
            log::info!("reopen: no explorer window — building main");
            expect_new_main(app, None);
            crate::commands::tray::show_main(app);
        }
    }
}

/// Open one launch the OS handed over: a new tab in `main`, or the first thing a new `main`
/// shows.
fn open<R: Runtime>(app: &AppHandle<R>, launch: Launch) {
    let main_exists = app.get_webview_window("main").is_some();
    let delivered = app
        .state::<LaunchGate>()
        .0
        .lock()
        .map(|g| g.delivered)
        .unwrap_or(false);
    match route(READY.load(Ordering::SeqCst), main_exists, delivered) {
        Route::Emit => {
            crate::commands::tray::show_main(app);
            if let Err(e) = app.emit(crate::LAUNCH_EVENT, launch) {
                log::error!("opened: could not hand the launch to the window: {e}");
            }
        }
        Route::Park => park(app, launch),
        Route::Rebuild => {
            expect_new_main(app, Some(launch));
            crate::commands::tray::show_main(app);
        }
    }
}

/// Park a launch for the frontend's `initial_launch`. Several folders opened before it asks
/// (a multi-folder drop on a cold start): the last one wins, and the others are logged.
fn park<R: Runtime>(app: &AppHandle<R>, launch: Launch) {
    if let Ok(mut g) = app.state::<LaunchGate>().0.lock() {
        if let Some(old) = g.pending.replace(launch) {
            log::warn!("opened before the window was ready; the earlier launch was replaced");
            log::debug!("replaced launch: {old:?}");
        }
    }
}

/// A new `main` is about to be built: its frontend will ask `initial_launch` again, so until
/// it does, launches are parked rather than emitted into a window that is not listening.
fn expect_new_main<R: Runtime>(app: &AppHandle<R>, launch: Option<Launch>) {
    if let Ok(mut g) = app.state::<LaunchGate>().0.lock() {
        g.delivered = false;
        if launch.is_some() {
            g.pending = launch;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn a_folder_opens_itself_without_its_trailing_slash() {
        let l = launch_for_url(&url("file:///Users/alex/Projects/"), |_| Kind::Folder).unwrap();
        assert_eq!(l.path.as_deref(), Some("/Users/alex/Projects"));
        assert_eq!(l.select, None);
        assert!(!l.hidden);
    }

    #[test]
    fn a_percent_encoded_folder_is_decoded() {
        let l = launch_for_url(&url("file:///Users/alex/My%20Stuff/"), |_| Kind::Folder).unwrap();
        assert_eq!(l.path.as_deref(), Some("/Users/alex/My Stuff"));
    }

    #[test]
    fn the_root_stays_the_root() {
        let l = launch_for_url(&url("file:///"), |_| Kind::Folder).unwrap();
        assert_eq!(l.path.as_deref(), Some("/"));
    }

    #[test]
    fn a_file_opens_its_folder_with_it_selected() {
        let l = launch_for_url(&url("file:///Users/alex/notes.txt"), |_| Kind::File).unwrap();
        assert_eq!(l.path.as_deref(), Some("/Users/alex"));
        assert_eq!(l.select.as_deref(), Some("/Users/alex/notes.txt"));
    }

    #[test]
    fn a_path_that_is_gone_opens_its_parent_with_nothing_selected() {
        let l = launch_for_url(&url("file:///Users/alex/gone.txt"), |_| Kind::Missing).unwrap();
        assert_eq!(l.path.as_deref(), Some("/Users/alex"));
        assert_eq!(l.select, None);
    }

    #[test]
    fn anything_but_a_file_url_is_ignored() {
        assert_eq!(
            launch_for_url(&url("https://example.com/"), |_| Kind::Folder),
            None
        );
        assert_eq!(launch_for_url(&url("trove://open"), |_| Kind::Folder), None);
    }

    #[test]
    fn the_real_disk_is_asked_what_a_path_is() {
        let dir = std::env::temp_dir();
        assert_eq!(kind_on_disk(&dir), Kind::Folder);
        assert_eq!(
            kind_on_disk(&dir.join("trove-no-such-entry-7f3a")),
            Kind::Missing
        );
        let file = dir.join(format!("trove-dock-test-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(kind_on_disk(&file), Kind::File);
        std::fs::remove_file(&file).unwrap();
    }

    #[test]
    fn a_launch_goes_to_a_listening_main_or_waits_for_one() {
        assert_eq!(route(true, true, true), Route::Emit);
        // the window exists, its page has not asked yet
        assert_eq!(route(true, true, false), Route::Park);
        // the last window was closed and the app kept running
        assert_eq!(route(true, false, true), Route::Rebuild);
        assert_eq!(route(true, false, false), Route::Rebuild);
        // ⛔ cold start from Finder: `Opened` comes before setup, with no window at all —
        // building one here is the "label `main` already exists" panic
        assert_eq!(route(false, false, false), Route::Park);
        assert_eq!(route(false, false, true), Route::Park);
    }
}

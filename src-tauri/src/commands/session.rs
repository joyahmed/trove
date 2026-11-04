//! "Restore tabs" for every window, not just `main` (plan 15 G.45): each explorer window reports
//! its folder tabs here, and the next start's `main` asks for what was open at quit. The rules
//! live in `core::session`; this file only finds the folder and wires the window events.
//! Mirrors `src/lib/api/session.ts`.

use std::collections::HashSet;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;

use tauri::{AppHandle, Manager, PhysicalPosition, Runtime, WebviewWindow, Window, WindowEvent};

use crate::commands::windows::{explorer_windows_besides, is_explorer_label};
use crate::core::session::{
    fit_to_monitors, maximized_bounds, Bounds, Screen, Session, Store, WindowTabs,
};

static STORE: OnceLock<Option<Store>> = OnceLock::new();

/// The process's one store, in the config folder beside `settings.json`. `None` only when the
/// OS gives no config folder, and then nothing is remembered.
fn store<R: Runtime>(app: &AppHandle<R>) -> Option<&'static Store> {
    STORE
        .get_or_init(|| app.path().app_config_dir().ok().map(Store::new))
        .as_ref()
}

/// The calling window's folder tabs and the active one. The label is the caller's own, never
/// an argument, so a window can only ever speak for itself.
///
/// The explorer windows alive now go with it, so a window kept as "closed last" that the app
/// outlived (a Mac in the Dock) is pruned; the store never prunes during a quit.
#[tauri::command(async)]
pub fn save_window_tabs(
    app: AppHandle,
    window: WebviewWindow,
    tabs: Vec<String>,
    active: usize,
) -> Result<(), String> {
    if !is_explorer_label(window.label()) {
        return Ok(());
    }
    let Some(store) = store(&app) else {
        return Ok(());
    };
    let alive: HashSet<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| is_explorer_label(label))
        .collect();
    let saved = store.save(
        WindowTabs {
            label: window.label().to_string(),
            tabs,
            active,
            bounds: None,
        },
        Some(&alive),
    );
    // the error only: an io::Error carries no path, and the tabs are the user's folders
    saved.map_err(|e| {
        log::warn!("session: could not save window tabs: {e}");
        e.to_string()
    })
}

/// One window a hidden start has not opened yet: its tabs and the active one.
#[derive(Deserialize)]
pub struct HeldWindow {
    tabs: Vec<String>,
    active: usize,
}

/// `main` keeps the last run's other windows in the file while it starts hidden in the tray
/// (they open when it is first shown), and clears them (`[]`) just before opening them — so a
/// quit from the tray in between does not lose them.
#[tauri::command(async)]
pub fn hold_windows(
    app: AppHandle,
    window: WebviewWindow,
    windows: Vec<HeldWindow>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Ok(());
    }
    let Some(store) = store(&app) else {
        return Ok(());
    };
    store
        .hold(windows.into_iter().map(|w| (w.tabs, w.active)).collect())
        .map_err(|e| {
            log::warn!("session: could not hold windows: {e}");
            e.to_string()
        })
}

/// What was open when the last run ended, `main`'s window first. Once per process: a `main`
/// rebuilt later in the run does not reopen the old windows again; it gets the window this run
/// closed last instead (a Mac Dock click), with its active tab, or `None`.
#[tauri::command(async)]
pub fn take_last_session(app: AppHandle) -> Option<Session> {
    store(&app)?.take_previous()
}

/// An explorer window was destroyed: forget it if it was closed on its own, keep it if it was the
/// last one or the app is quitting. Re-entry safe (a second pass finds nothing to forget) and it
/// touches only the label, as `pty::on_window_event` explains.
pub fn on_window_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if !is_explorer_label(label) {
        return;
    }
    let Some(store) = store(app) else {
        return;
    };
    let others_open = explorer_windows_besides(app, label) > 0;
    if let Err(e) = store.window_closed(label, others_open) {
        log::warn!("session: could not forget window {label}: {e}");
    }
}

/// The app is about to quit (the tray's Quit, `app.exit`): the windows it tears down from here
/// on are the ones the next start brings back.
pub fn quitting<R: Runtime>(app: &AppHandle<R>) {
    if let Some(store) = store(app) {
        // the last move may still sit in the debounce: every window's place now, before teardown
        save_all_bounds(app);
        store.quit();
    }
}

/// Every explorer window's size and place now: the last move may still sit in the debounce.
/// Called on the way out: a quit from the tray (`quitting`), and the run loop ending, which is
/// all a Mac's ⌘Q goes through.
pub fn save_all_bounds<R: Runtime>(app: &AppHandle<R>) {
    for window in app.webview_windows().values() {
        save_bounds_now(&window.as_ref().window());
    }
}

/// How long a window must keep still before its size and place are written: a drag reports a
/// move per frame, and one write per drag is enough.
const BOUNDS_DEBOUNCE: Duration = Duration::from_millis(500);

/// Labels of windows that moved or resized, for the one thread that writes their bounds once
/// they keep still (`BOUNDS_DEBOUNCE`).
static MOVED: OnceLock<Mutex<Sender<String>>> = OnceLock::new();

/// Size and place of every explorer window, saved here from its window events rather than from
/// the page (plan 15 G.45): a move or resize, debounced; a close, at once. ⛔ Spotlight
/// (`palette`) is never saved: `is_explorer_label` keeps it out.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !is_explorer_label(window.label()) {
        return;
    }
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let sender = MOVED.get_or_init(|| Mutex::new(spawn_bounds_writer(window.app_handle())));
            let _ = sender
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .send(window.label().to_string());
        }
        // ⚠️ the resident close in `lib.rs` hides `main` before this runs, so it saves first
        WindowEvent::CloseRequested { .. } => save_bounds_now(window),
        // what every show ends in: `main`'s restored maximize, held while it was hidden
        WindowEvent::Focused(true) => crate::commands::windows::maximize_if_due(window),
        _ => {}
    }
}

/// The debounce on its own thread: saves each window that moved once none has for
/// `BOUNDS_DEBOUNCE`.
fn spawn_bounds_writer(app: &AppHandle) -> Sender<String> {
    let (tx, rx) = channel::<String>();
    let app = app.clone();
    std::thread::spawn(move || {
        debounce(&rx, BOUNDS_DEBOUNCE, |label| {
            // closed in the meantime: it saved itself on the way out
            if let Some(window) = app.get_webview_window(label) {
                save_bounds_now(&window.as_ref().window());
            }
        })
    });
    tx
}

/// Collect labels from `rx` until none has arrived for `wait`, then `save` each once. Asleep
/// while nothing is pending (a plain `recv`), so an idle app wakes no thread. Returns when every
/// sender is gone, which in the app is never: the one sender lives in the `MOVED` static, so the
/// writer lives as long as the process (only the tests drop theirs).
fn debounce(rx: &Receiver<String>, wait: Duration, mut save: impl FnMut(&str)) {
    let mut pending: HashSet<String> = HashSet::new();
    loop {
        let got = if pending.is_empty() {
            rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
        } else {
            rx.recv_timeout(wait)
        };
        match got {
            Ok(label) => {
                pending.insert(label);
            }
            Err(RecvTimeoutError::Timeout) => {
                for label in pending.drain() {
                    save(&label);
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Whether this session keeps window places to itself (Wayland), once per process: then only
/// sizes are saved and restored. `core::session::positions_hidden` says how it is told.
pub fn positions_hidden() -> bool {
    static HIDDEN: OnceLock<bool> = OnceLock::new();
    *HIDDEN.get_or_init(|| {
        cfg!(target_os = "linux")
            && crate::core::session::positions_hidden(
                std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
                std::env::var("GDK_BACKEND").ok().as_deref(),
            )
    })
}

/// `window`'s place now, in physical px. Minimized: nothing (Windows parks it at -32000).
/// Full screen (a Mac's green button): nothing either, or the whole screen comes back next run
/// as a plain window; the place before it stays. Maximized: the flag, over the rect it goes
/// back to, on the monitor it is maximized on (`maximized_bounds`), so un-maximizing next run
/// lands there. Wayland: the size alone, at 0,0.
fn bounds_now<R: Runtime>(window: &Window<R>, before: Option<Bounds>) -> Option<Bounds> {
    if window.is_minimized().unwrap_or(false)
        || window.is_fullscreen().unwrap_or(false)
        || !window.is_visible().unwrap_or(true)
    {
        return None;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let pos = if positions_hidden() {
        PhysicalPosition::new(0, 0)
    } else {
        window.outer_position().ok()?
    };
    let size = window.inner_size().ok()?;
    if size.width == 0 || size.height == 0 {
        return None;
    }
    let now = Bounds {
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
        maximized,
    };
    if maximized {
        return Some(maximized_bounds(now, before, &screens(window.app_handle())));
    }
    Some(now)
}

/// Save an explorer window's size and place now. Before it hides, too: a hidden window saves
/// nothing (`bounds_now`).
pub fn save_bounds_now<R: Runtime>(window: &Window<R>) {
    let label = window.label();
    if !is_explorer_label(label) {
        return;
    }
    let Some(store) = store(window.app_handle()) else {
        return;
    };
    let Some(bounds) = bounds_now(window, store.bounds_of(label)) else {
        return;
    };
    if let Err(e) = store.save_bounds(label, bounds) {
        log::warn!("session: could not save the bounds of {label}: {e}");
    }
}

/// The monitors there are now, by their work area.
pub(crate) fn screens<R: Runtime>(app: &AppHandle<R>) -> Vec<Screen> {
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (*m.position(), *m.size()));
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let area = m.work_area();
            Screen {
                x: area.position.x,
                y: area.position.y,
                w: area.size.width,
                h: area.size.height,
                scale: m.scale_factor(),
                primary: primary == Some((*m.position(), *m.size())),
            }
        })
        .collect()
}

/// The size and place a window being built takes (`Store::restore_bounds`), fitted to the
/// monitors there are now. `tabs` is a restored window's; `None` for `main` and new windows.
/// Wayland: as saved, the size alone counts, and there is no place to fit.
pub fn restore_bounds<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    tabs: Option<&[String]>,
) -> Option<Bounds> {
    let saved = store(app)?.restore_bounds(label, tabs)?;
    if positions_hidden() {
        return Some(saved);
    }
    Some(fit_to_monitors(saved, &screens(app)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bounds_writer_saves_each_moved_window_once_after_it_keeps_still() {
        let (tx, rx) = channel::<String>();
        let (saved_tx, saved_rx) = channel::<String>();
        let writer = std::thread::spawn(move || {
            debounce(&rx, Duration::from_millis(50), |label| {
                saved_tx.send(label.to_string()).unwrap();
            })
        });
        // a drag: many moves of one window, one of another
        for label in ["main", "main", "main-2", "main"] {
            tx.send(label.to_string()).unwrap();
        }
        let mut saved: Vec<String> = (0..2)
            .map(|_| saved_rx.recv_timeout(Duration::from_secs(5)).unwrap())
            .collect();
        saved.sort();
        assert_eq!(saved, vec!["main", "main-2"]);
        assert!(
            saved_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "nothing more until a window moves again"
        );
        // idle, it blocks on `recv` and still ends when the app drops the sender
        drop(tx);
        writer.join().unwrap();
    }
}

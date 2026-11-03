//! Tray residency: a tray icon with Open / New tab / Quit that exists only while the app is
//! resident; the main window then hides on close instead of exiting. The frontend decides
//! residency from its settings and calls `set_resident`.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event the tray's "New tab" sends; the frontend opens a tab after showing the window.
pub const NEW_TAB_EVENT: &str = "tray:new-tab";

/// The tray icon's id in Tauri's own registry, so turning residency off can remove it there.
const TRAY_ID: &str = "trove";

/// The live tray icon, `None` while not resident. Managed state on the app.
pub struct Residency(pub Mutex<Option<TrayIcon>>);

/// Show the main window from the tray or a launch: unhide, unminimize, focus — **rebuilding it
/// when it is gone rather than hidden.**
///
/// ⛔ **`main` can be absent, and this used to fail silently when it was.** The whole body was
/// one `if let Some(win)`, so a missing window meant no action, no error and no log line —
/// while the single-instance handler that calls this still exited 0 and reported success. On
/// 2026-09-24 a process sat four hours in exactly that state, swallowing every launch, because
/// the hidden `palette` window kept it alive after `main` was destroyed. Plancheck 8 §G.
///
/// ⛔ **Never turn a failure here back into a `let _ =`.** This is the one entry point every
/// launch goes through — the tray, `Win+E`, a folder double-click, a second `trove.exe` — and
/// the default-handler path cannot pass a flag to route around it. If this is quiet, the app is
/// unopenable with no trace anywhere.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        if let Err(e) = win.show() {
            log::error!("show_main: show failed: {e}");
        }
        // a maximize restored while it was hidden (`windows::maximize_when_shown`)
        crate::commands::windows::maximize_if_due(&win.as_ref().window());
        if let Err(e) = win.unminimize() {
            log::warn!("show_main: unminimize failed: {e}");
        }
        if let Err(e) = win.set_focus() {
            log::warn!("show_main: focus failed: {e}");
        }
        return;
    }
    // Gone, not hidden. Rebuild it on the frame the config declares; the frontend boots from
    // `/` exactly as it does on a cold start, so argv/LAUNCH_EVENT still drive where it lands.
    log::warn!("show_main: no main window — rebuilding it");
    match crate::commands::windows::build_explorer_window(
        app,
        "main",
        tauri::WebviewUrl::App("/".into()),
        None,
        // where the window closed last was (a Mac Dock click), or the last run's `main`
        crate::commands::session::restore_bounds(app, "main", None),
    ) {
        Ok(_) => log::info!("show_main: main window rebuilt"),
        // Nothing above this can recover, so it must be loud: the app is now unopenable.
        Err(e) => log::error!("show_main: could not rebuild the main window: {e}"),
    }
}

fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let new_tab = MenuItem::with_id(app, "new-tab", "New tab", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Trove", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &new_tab, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Trove")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "new-tab" => {
                show_main(app);
                let _ = app.emit(NEW_TAB_EVENT, ());
            }
            "quit" => {
                // before the exit: every window it destroys is one to bring back next start
                crate::commands::session::quitting(app);
                app.exit(0)
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    // A tray without an icon does not show on Windows, and `default_window_icon()` is None
    // without an `app.windows[].icon` in the config — so the icon is embedded here.
    builder = builder.icon(tauri::include_image!("icons/32x32.png"));
    builder.build(app)
}

pub fn is_resident_now<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<Residency>()
        .0
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
}

/// Where tray icons are registered, so the on/off bookkeeping can be tested without a desktop.
trait TrayRegistry {
    /// We hold the icon now.
    fn has(&self) -> bool;
    /// Hold an icon with our id: one already registered (shown again), or a new one.
    fn add(&mut self) -> Result<(), String>;
    /// Every icon with our id gone, ours and the registry's. A no-op when there is none.
    fn remove(&mut self);
    /// Let go of our handle but keep the registry's icon, hidden. A no-op when there is none.
    fn hide(&mut self);
}

/// Off hides the icon instead of removing it — on Linux only.
///
/// ⛔ **On Linux a removed icon cannot be re-added.** The appindicator behind `tray-icon` never
/// frees its object (the `libappindicator` crate's `AppIndicator` has no `Drop`), so removing
/// the icon only sets it Passive and leaves it exported on D-Bus under our fixed id; the next
/// add then fails with "An object is already exported" and shows nothing. Plan 15 D.3.1.
/// Hiding sets the same Passive status (the GNOME AppIndicator extension and KDE hide Passive
/// items) and on shows the same object again. Windows and macOS keep removing.
const OFF_HIDES: bool = cfg!(target_os = "linux");

/// Make the registry show exactly one icon (`on`) or none. Idempotent.
fn apply_resident(reg: &mut impl TrayRegistry, on: bool, off_hides: bool) -> Result<(), String> {
    match (on, reg.has()) {
        (true, false) => reg.add(),
        (true, true) => Ok(()),
        // unconditionally: an icon we lost track of must not outlive "off"
        (false, _) => {
            if off_hides {
                reg.hide();
            } else {
                reg.remove();
            }
            Ok(())
        }
    }
}

/// The real registry: our handle plus Tauri's own copy of it.
///
/// ⛔ **Dropping our handle is not removing the icon.** `TrayIconBuilder::build` also puts a
/// clone in the app's resources table, so `*guard = None` alone left the icon on screen with a
/// working menu, and the next "Keep running" on built a SECOND one. Seen on Ubuntu, plan 15
/// D.3.1. Off must go through `remove_tray_by_id`, which takes Tauri's copy and closes it —
/// or, on Linux, through `hide` (see `OFF_HIDES`).
struct LiveTray<'a> {
    app: &'a AppHandle,
    ours: &'a mut Option<TrayIcon>,
}

impl TrayRegistry for LiveTray<'_> {
    fn has(&self) -> bool {
        self.ours.is_some()
    }
    fn add(&mut self) -> Result<(), String> {
        let tray = match self.app.tray_by_id(TRAY_ID) {
            // hidden by `hide` (Linux): show the same icon again
            Some(tray) => {
                tray.set_visible(true).map_err(|e| e.to_string())?;
                tray
            }
            None => {
                let tray = build_tray(self.app).map_err(|e| e.to_string())?;
                // its hidden window joins the ones kept alive against WM_CLOSE (Windows)
                crate::core::helper_windows::guard_on_main(self.app);
                tray
            }
        };
        *self.ours = Some(tray);
        Ok(())
    }
    fn remove(&mut self) {
        *self.ours = None;
        if let Some(tray) = self.app.remove_tray_by_id(TRAY_ID) {
            if let Err(e) = tray.set_visible(false) {
                log::warn!("tray: could not hide the icon being removed: {e}");
            }
        }
    }
    fn hide(&mut self) {
        *self.ours = None;
        if let Some(tray) = self.app.tray_by_id(TRAY_ID) {
            if let Err(e) = tray.set_visible(false) {
                log::warn!("tray: could not hide the icon: {e}");
            }
        }
    }
}

/// Create the tray icon (resident) or remove it (not resident). Idempotent.
#[tauri::command]
pub fn set_resident(app: AppHandle, on: bool) -> Result<(), String> {
    let state = app.state::<Residency>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    apply_resident(
        &mut LiveTray {
            app: &app,
            ours: &mut guard,
        },
        on,
        OFF_HIDES,
    )
}

#[tauri::command]
pub fn is_resident(app: AppHandle) -> bool {
    is_resident_now(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tauri's registry as `LiveTray` sees it, plus what a panel shows. `linux` models the
    /// appindicator: a removed icon stays exported on D-Bus, so a new one with our id can
    /// never register and shows nothing.
    #[derive(Default)]
    struct Fake {
        linux: bool,
        /// icons in Tauri's registry under our id
        registered: usize,
        /// icons a panel shows
        shown: usize,
        /// a removed icon still exported on D-Bus (Linux)
        leaked: bool,
        ours: bool,
    }

    impl TrayRegistry for Fake {
        fn has(&self) -> bool {
            self.ours
        }
        fn add(&mut self) -> Result<(), String> {
            if self.registered == 0 {
                self.registered = 1;
                // "An object is already exported": the new icon never reaches the panel
                if !(self.linux && self.leaked) {
                    self.shown = 1;
                }
            } else {
                self.shown = 1;
            }
            self.ours = true;
            Ok(())
        }
        fn remove(&mut self) {
            self.ours = false;
            if self.registered > 0 {
                self.registered = 0;
                self.shown = 0;
                self.leaked = self.linux;
            }
        }
        fn hide(&mut self) {
            self.ours = false;
            self.shown = 0;
        }
    }

    fn on_off_on(reg: &mut Fake, off_hides: bool) {
        apply_resident(reg, true, off_hides).unwrap();
        assert_eq!(reg.shown, 1);
        apply_resident(reg, false, off_hides).unwrap();
        assert_eq!(reg.shown, 0);
        assert!(!reg.ours);
        apply_resident(reg, true, off_hides).unwrap();
    }

    #[test]
    fn on_off_on_shows_exactly_one_icon_either_way_off() {
        for off_hides in [false, true] {
            let mut reg = Fake::default();
            on_off_on(&mut reg, off_hides);
            assert_eq!((reg.registered, reg.shown), (1, 1), "off_hides {off_hides}");
        }
    }

    /// Plan 15 D.3.1: removing on Linux left ON/OFF/ON with no icon at all.
    #[test]
    fn linux_on_off_on_needs_hiding() {
        let mut removed = Fake {
            linux: true,
            ..Fake::default()
        };
        on_off_on(&mut removed, false);
        assert_eq!(
            removed.shown, 0,
            "the appindicator cannot re-add a removed icon"
        );

        let mut hidden = Fake {
            linux: true,
            ..Fake::default()
        };
        on_off_on(&mut hidden, true);
        assert_eq!((hidden.registered, hidden.shown), (1, 1));
    }

    /// The Linux build itself picks hiding, so its ON/OFF/ON ends with one icon.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_linux_build_hides_on_off() {
        let mut reg = Fake {
            linux: true,
            ..Fake::default()
        };
        on_off_on(&mut reg, OFF_HIDES);
        assert_eq!((reg.registered, reg.shown), (1, 1));
    }

    #[test]
    fn repeating_a_state_changes_nothing() {
        for off_hides in [false, true] {
            let mut reg = Fake::default();
            apply_resident(&mut reg, false, off_hides).unwrap();
            assert_eq!(reg.shown, 0);
            apply_resident(&mut reg, true, off_hides).unwrap();
            apply_resident(&mut reg, true, off_hides).unwrap();
            assert_eq!((reg.registered, reg.shown), (1, 1));
            apply_resident(&mut reg, false, off_hides).unwrap();
            apply_resident(&mut reg, false, off_hides).unwrap();
            assert_eq!(reg.shown, 0);
        }
    }

    #[test]
    fn off_hides_or_removes_an_icon_we_lost_track_of() {
        for off_hides in [false, true] {
            let mut reg = Fake {
                registered: 1,
                shown: 1,
                ..Fake::default()
            };
            apply_resident(&mut reg, false, off_hides).unwrap();
            assert_eq!(reg.shown, 0);
        }
    }
}

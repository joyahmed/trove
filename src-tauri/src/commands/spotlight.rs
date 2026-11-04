//! The Spotlight palette's window and hotkey glue: a configurable chord toggles the `palette`
//! window, which is positioned on the monitor under the cursor, resized to its results, hidden
//! on focus loss; plus the two lookups the palette asks for (apps, files).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Window, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::core::spotlight::{self, AppEntry};

/// The palette window's label in `tauri.conf.json`.
///
/// ⛔ **That window asks for no `windowEffects`, and that is what gives it a rounded corner.**
/// Measured 2026-09-25 against a busy background: with `windowEffects: ["mica"]` the palette's
/// corner pixel was exactly `#202020` — a perfect 90° — even though the CSS already carried an
/// 8px radius. Mica is painted by DWM into the full, SQUARE window rect, so it fills in behind
/// the rounded box at the same colour the box is painted. Windows 11 would normally clip the
/// window itself, but only for windows that keep `WS_THICKFRAME`; `resizable: false` drops it,
/// so DWM leaves this one square — `--radius-panel` (20px, in `app.css`) is the only corner it
/// has, and restoring the effect makes Spotlight a rectangle again.
///
/// ⚠️ The main window took the same medicine on 2026-09-25 (`windowEffects` dropped from `main`
/// too, and `--radius-window` applied to the shell root): it keeps `WS_THICKFRAME`, so DWM still
/// clips it at 8px, but with no backdrop behind that clip everything outside the CSS arc is
/// genuinely transparent and the 14px arc is the edge you see. No window in this app asks the OS
/// for a backdrop now, so the corner is always CSS's.
pub const PALETTE_WINDOW: &str = "palette";
/// What the chord is when nobody has chosen one.
///
/// ⛔ **Not a `Win+…` chord, and this is not a style preference.** Measured on 2026-09-24 on the
/// shipped build:
///
/// ```text
/// super+space        REFUSED — ERROR_HOTKEY_ALREADY_REGISTERED; the shell owns it
/// alt+space          registers, fires   ← chosen
/// ctrl+shift+space   registers, fires
/// ctrl+space         registers, fires
/// ```
///
/// `super+shift+space` and `super+f1` did not fire either, though whether they were refused or
/// merely swallowed was never established, and is not claimed.
///
/// ⚠️ `alt+space` beats the window menu rather than losing to it, which is what makes it usable
/// — but while Trove holds the chord, Alt+Space stops opening that menu in other apps. That
/// trade is stated in the Settings note too (`utils/hotkeys.ts`).
///
/// ⛔ **Linux is `ctrl+alt+space`** (Joy's pick 2026-10-23): GNOME binds `<Alt>space` to its
/// window menu and swallows the press with no error (`core::hotkey_conflicts`, D.5.2). The
/// frontend's default (`utils/hotkeys.ts` `defaultSpotlightHotkey`) is the one that is saved;
/// this is only the fallback for a call with no chord, and must say the same.
pub const DEFAULT_HOTKEY: &str = default_hotkey_for(cfg!(target_os = "linux"));

/// The default chord on Linux (`true`) or anywhere else. A function so both answers are tested
/// on every OS, not only the one the tests run on.
pub const fn default_hotkey_for(linux: bool) -> &'static str {
    if linux {
        "ctrl+alt+space"
    } else {
        "alt+space"
    }
}

/// The chord currently registered, so a change can release the old one first. A stale
/// registration would leave two live chords, and the old one would keep toggling the palette.
static CURRENT: Mutex<Option<String>> = Mutex::new(None);
/// Emitted to the palette when it is shown, so it can focus its input.
pub const SHOWN_EVENT: &str = "spotlight:shown";
/// Emitted to the main window when the chord could not be taken (payload: the message).
pub const HOTKEY_FAILED_EVENT: &str = "spotlight:hotkey-failed";

/// The chord the person was last told about. A window reload re-registers the chord and fails
/// again; without this the warning toast reappears on every reload, not once per app run.
static LAST_TOLD: Mutex<Option<String>> = Mutex::new(None);

/// True the first time `chord` is reported refused in this run; false for repeats.
fn first_report(chord: &str) -> bool {
    let mut told = LAST_TOLD.lock().unwrap_or_else(|e| e.into_inner());
    if told.as_deref() == Some(chord) {
        return false;
    }
    *told = Some(chord.to_string());
    true
}

const WIDTH: f64 = 680.0;
const COLLAPSED_HEIGHT: f64 = 64.0;
const MAX_HEIGHT: f64 = 480.0;

static APPS: Mutex<Option<Vec<AppEntry>>> = Mutex::new(None);
/// When the palette was last shown. Windows can answer `show` + `set_focus` with an immediate
/// `Focused(false)` while the previous foreground window wins the handshake; a blur inside
/// this grace is a retry, not a dismissal — otherwise the palette vanishes before it is seen.
static SHOWN_AT: Mutex<Option<Instant>> = Mutex::new(None);
const FOCUS_GRACE: Duration = Duration::from_millis(300);

/// Whether the chord is held right now. One physical press of Ctrl+Space arrives as several
/// `Pressed` events — the key-down and then Windows' autorepeat (its default delay is about
/// half a second) — and every one of them would toggle. Only the first press before a release
/// counts: edge-triggered, not level-triggered.
static CHORD_HELD: Mutex<bool> = Mutex::new(false);

/// The plugin's handler for every registered chord: ours toggles the palette on press.
pub fn on_shortcut(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    let mut held = CHORD_HELD.lock().unwrap_or_else(|e| e.into_inner());
    match event.state {
        ShortcutState::Released => {
            *held = false;
        }
        ShortcutState::Pressed => {
            if *held {
                return;
            }
            *held = true;
            drop(held);
            // A recorder is listening: the chord is what the person is recording, not a call
            // for the palette. Windows hands a registered chord to us alone — the page never
            // sees its keydown — so without this it could never be recorded (A.8.9).
            if crate::core::key_menu::recording() {
                let chord = CURRENT.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if let Some(chord) = chord {
                    let _ = app.emit(crate::core::key_menu::RECORDED_EVENT, chord);
                }
                return;
            }
            let blur_hid_ago = BLUR_HID_AT
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
                .map(|t| t.elapsed());
            if press_reopens(blur_hid_ago, BLUR_RACE) {
                toggle(app);
            }
        }
    }
}

/// When focus loss last hid the palette. On X11 the chord's key grab takes focus from the
/// palette BEFORE the press reaches us: measured on Xvfb 2026-10-19, `Focused(false)` hid it
/// and the `Pressed` event arrived 20 ms later, found it hidden, and showed it again — so
/// Alt+Space could never close it. A press that lands right after such a hide is the close.
static BLUR_HID_AT: Mutex<Option<Instant>> = Mutex::new(None);
/// How soon after a focus-loss hide a chord press still counts as that same close. Zero off
/// Linux: Windows and macOS take the chord without moving focus, so nothing changes there.
const BLUR_RACE: Duration = if cfg!(target_os = "linux") {
    Duration::from_millis(250)
} else {
    Duration::ZERO
};

/// Whether a chord press should toggle, given how long ago focus loss hid the palette.
fn press_reopens(blur_hid_ago: Option<Duration>, race: Duration) -> bool {
    !blur_hid_ago.is_some_and(|ago| ago < race)
}

fn shown_recently() -> bool {
    SHOWN_AT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some_and(|t| t.elapsed() < FOCUS_GRACE)
}

/// Whether a close request on this window hides it instead of destroying it.
///
/// ⛔ The palette is built ONCE, from `tauri.conf.json`, and nothing rebuilds it: `toggle`
/// returns early when it is gone. Alt+F4 while Spotlight has focus sends it `WM_CLOSE`, and
/// before this the default close destroyed it — so Alt+Space did nothing for the rest of the
/// session. Hidden, it is exactly what Esc leaves. `app.exit` does not ask (`ExitRequested`,
/// not `CloseRequested`), so the tray's Quit and the last explorer window still end the app.
pub fn close_hides(label: &str) -> bool {
    label == PALETTE_WINDOW
}

/// The palette hides when it loses focus — Esc, a click elsewhere, Alt+Tab — except in the
/// first moments after it was shown, when a lost handshake just asks for focus again. A close
/// request (Alt+F4, `WM_CLOSE`) hides it too, see `close_hides`.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if close_hides(window.label()) {
            api.prevent_close();
            let _ = window.hide();
        }
        return;
    }
    if window.label() == PALETTE_WINDOW && matches!(event, WindowEvent::Focused(false)) {
        if shown_recently() {
            let _ = window.set_focus();
        } else {
            if window.is_visible().unwrap_or(false) {
                *BLUR_HID_AT.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
            }
            let _ = window.hide();
        }
    }
}

/// The Settings shortcut recorder started (`true`) or stopped (`false`). While it records, an
/// explorer window holds back the Alt+Space window menu and the registered chord stops toggling
/// the palette; both hand the press to the recorder instead (`core::key_menu`, A.8.9).
#[tauri::command]
pub fn set_hotkey_recording(on: bool) {
    crate::core::key_menu::set_recording(on);
}

/// Register `chord`, releasing whatever was registered before it.
///
/// Called by the main window once it is up, and again whenever the setting changes. A failure —
/// another app owns the chord, or Windows does — is returned as a message for a notice, never a
/// panic: the app runs without the palette until a free chord is chosen.
///
/// `Ok(Some(note))` is a chord that registered but that the desktop itself also uses (GNOME's
/// `<Alt>space` window menu, D.5.2), so the press may never arrive.
///
/// ⛔ That case is `Ok`, not `Err`. `spotlight-bridge.svelte.ts` turns an `Err` into "refused",
/// and Settings then will not save the chord — but it did register, and clearing the GNOME key
/// makes it work with no change in Trove.
///
/// ⛔ The old chord is released **before** the new one is tried, and restored if the new one is
/// refused. Registering first would leave both live; not restoring would leave the person with
/// no working chord after one typo.
#[tauri::command]
pub fn register_hotkey(app: AppHandle, chord: Option<String>) -> Result<Option<String>, String> {
    let wanted = chord
        .map(|c| c.trim().to_ascii_lowercase())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string());

    let shortcuts = app.global_shortcut();
    let mut current = CURRENT.lock().unwrap_or_else(|e| e.into_inner());

    // ⚠️ Checked here too: a window reload lands on this early return, and the Settings note
    // must survive it. The toast does not repeat (`first_report`).
    if current.as_deref() == Some(wanted.as_str()) && shortcuts.is_registered(wanted.as_str()) {
        return Ok(desktop_conflict(&app, &wanted));
    }

    let previous = current.take();
    if let Some(old) = previous.as_deref() {
        let _ = shortcuts.unregister(old);
    }

    match shortcuts.on_shortcut(wanted.as_str(), on_shortcut) {
        Ok(()) => {
            // ⚠️ Logged on BOTH paths on purpose. This was invisible in trove.log, and the
            // silence cost a wrong diagnosis: a failed Win+Space looked like a *silent* failure
            // because the toast had faded before anyone looked and the log said nothing at all.
            log::info!("spotlight hotkey: registered {wanted}");
            let note = desktop_conflict(&app, &wanted);
            *current = Some(wanted);
            Ok(note)
        }
        Err(e) => {
            // Put the working chord back, so a refused change does not cost the one that worked.
            if let Some(old) = previous {
                if shortcuts.on_shortcut(old.as_str(), on_shortcut).is_ok() {
                    *current = Some(old);
                }
            }
            let msg = refusal_message(&pretty(&wanted), &e.to_string(), std::env::consts::OS);
            log::warn!("spotlight hotkey: {wanted} refused — {e}");
            // ⚠️ The toast comes from this event ONLY. The frontend used to toast the returned
            // error as well, which showed it twice.
            if first_report(&wanted) {
                let _ = app.emit(HOTKEY_FAILED_EVENT, msg.clone());
            }
            Err(msg)
        }
    }
}

/// The note for a chord the desktop also binds (GNOME only, `core::hotkey_conflicts`), or None.
/// The first time in a run it is also logged and toasted through `HOTKEY_FAILED_EVENT`.
fn desktop_conflict(app: &AppHandle, chord: &str) -> Option<String> {
    let (schema, key) = crate::core::hotkey_conflicts::gnome_holder(chord)?;
    let note = conflict_message(&pretty(chord), &schema, &key);
    if first_report(chord) {
        log::warn!("spotlight hotkey: {chord} is also GNOME's {schema} {key}");
        let _ = app.emit(HOTKEY_FAILED_EVENT, note.clone());
    }
    Some(note)
}

/// The text for a chord GNOME also uses.
fn conflict_message(chord: &str, schema: &str, key: &str) -> String {
    format!(
        "{chord} is also GNOME's \"{key}\" shortcut ({schema}), so GNOME may take the press before \
         Spotlight sees it — clear it in GNOME's keyboard settings, or pick a different shortcut here."
    )
}

/// "super+space" as a person reads it. Only for messages; the chord itself stays canonical.
/// ⚠️ `src/lib/utils/hotkeys.ts` has the same formatting for the UI. Two copies, because one
/// is inside an error string Rust builds and the other renders a button — change both.
fn pretty(chord: &str) -> String {
    pretty_for(chord, std::env::consts::OS)
}

/// What the Windows key is called on this OS: Win on Windows, ⌘ on a Mac, Super on Linux.
fn super_name(os: &str) -> &'static str {
    match os {
        "windows" => "Win",
        "macos" => "⌘",
        _ => "Super",
    }
}

/// The text of a refused chord; only Windows has reserved Win+key chords to warn about.
fn refusal_message(chord: &str, error: &str, os: &str) -> String {
    let reserved = if os == "windows" {
        " Windows reserves some Win+key chords, and another app may own this one"
    } else {
        " Another app may own this one"
    };
    format!("{chord} could not be registered ({error}).{reserved} — pick a different shortcut in Settings.")
}

fn pretty_for(chord: &str, os: &str) -> String {
    chord
        .split('+')
        .map(|part| match part {
            "super" | "meta" | "cmd" => super_name(os).to_string(),
            "ctrl" | "control" => "Ctrl".to_string(),
            "alt" => "Alt".to_string(),
            "shift" => "Shift".to_string(),
            other => {
                let mut c = other.chars();
                match c.next() {
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

#[cfg(test)]
mod tests {
    use super::{
        close_hides, default_hotkey_for, first_report, press_reopens, pretty_for, refusal_message,
        Duration, DEFAULT_HOTKEY, PALETTE_WINDOW,
    };

    #[test]
    fn only_the_palette_hides_on_close() {
        // Alt+F4 on Spotlight must not destroy the one palette window the app has
        assert!(close_hides(PALETTE_WINDOW));
        // explorer windows keep `lib.rs`'s own decision (resident hides, otherwise closes)
        assert!(!close_hides("main"));
        assert!(!close_hides("main-2"));
    }

    #[test]
    fn a_press_right_after_a_focus_loss_hide_is_that_close_not_a_reopen() {
        let race = Duration::from_millis(250);
        // X11: the grab blurred and hid the palette 20 ms before the press arrived.
        assert!(!press_reopens(Some(Duration::from_millis(20)), race));
        // A press long after a click-away hide opens it again.
        assert!(press_reopens(Some(Duration::from_secs(2)), race));
        assert!(press_reopens(None, race));
        // Off Linux the race is zero: behaviour is unchanged.
        assert!(press_reopens(
            Some(Duration::from_millis(20)),
            Duration::ZERO
        ));
    }

    #[test]
    fn the_default_chord_is_ctrl_alt_space_on_linux_only() {
        assert_eq!(default_hotkey_for(true), "ctrl+alt+space");
        assert_eq!(default_hotkey_for(false), "alt+space");
        let here = if cfg!(target_os = "linux") {
            "ctrl+alt+space"
        } else {
            "alt+space"
        };
        assert_eq!(DEFAULT_HOTKEY, here);
    }

    #[test]
    fn a_refused_chord_is_reported_once_per_run() {
        assert!(first_report("alt+space-test"));
        assert!(!first_report("alt+space-test"));
        assert!(first_report("ctrl+alt+x-test"));
    }

    #[test]
    fn a_chord_reads_the_way_the_keyboard_is_labelled() {
        assert_eq!(pretty_for("super+space", "windows"), "Win+Space");
        assert_eq!(pretty_for("ctrl+shift+p", "windows"), "Ctrl+Shift+P");
        assert_eq!(pretty_for("alt+f1", "windows"), "Alt+F1");
    }

    #[test]
    fn the_super_key_has_the_name_of_its_os() {
        assert_eq!(pretty_for("super+space", "macos"), "⌘+Space");
        assert_eq!(pretty_for("super+space", "linux"), "Super+Space");
    }

    #[test]
    fn only_windows_is_told_about_reserved_win_chords() {
        let win = refusal_message("Win+L", "taken", "windows");
        assert!(win.contains("Windows reserves some Win+key chords"));
        for os in ["macos", "linux"] {
            let m = refusal_message("⌘+L", "taken", os);
            assert!(!m.contains("Win"), "{os}: {m}");
            assert!(m.contains("Another app may own this one"));
        }
    }
}

/// Where the palette goes: centred over the Trove window's top third when that window is
/// showing and wide enough to hold it, else on the monitor under the cursor (the window is
/// hidden in the tray, minimized, or narrower than the palette).
fn placement(app: &AppHandle, win: &tauri::WebviewWindow) -> Option<PhysicalPosition<i32>> {
    let scale = win.scale_factor().unwrap_or(1.0);
    let width = WIDTH * scale;
    if let Some(main) = app.get_webview_window("main") {
        let showing = main.is_visible().unwrap_or(false) && !main.is_minimized().unwrap_or(true);
        if let (true, Ok(pos), Ok(size)) = (showing, main.outer_position(), main.outer_size()) {
            if size.width as f64 >= width + 80.0 * scale && size.height as f64 >= MAX_HEIGHT * scale
            {
                let x = pos.x as f64 + (size.width as f64 - width) / 2.0;
                let y = pos.y as f64 + size.height as f64 * 0.18;
                return Some(PhysicalPosition::new(x.round() as i32, y.round() as i32));
            }
        }
    }
    let cursor = app.cursor_position().ok();
    let monitor = cursor
        .and_then(|c| app.monitor_from_point(c.x, c.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    let x = area.position.x as f64 + (area.size.width as f64 - width) / 2.0;
    let y = area.position.y as f64 + area.size.height as f64 * 0.22;
    Some(PhysicalPosition::new(x.round() as i32, y.round() as i32))
}

/// Show the palette (see `placement`), or hide it.
pub fn toggle(app: &AppHandle) {
    let Some(win) = app.get_webview_window(PALETTE_WINDOW) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    if let Some(pos) = placement(app, &win) {
        let _ = win.set_position(pos);
    }
    let _ = win.set_size(LogicalSize::new(WIDTH, COLLAPSED_HEIGHT));
    *SHOWN_AT.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to(PALETTE_WINDOW, SHOWN_EVENT, ());
}

#[tauri::command]
pub fn toggle_palette(app: AppHandle) {
    toggle(&app);
}

#[tauri::command]
pub fn hide_palette(app: AppHandle) {
    if let Some(win) = app.get_webview_window(PALETTE_WINDOW) {
        let _ = win.hide();
    }
}

/// The palette grew or shrank with its results: `height` in logical px, clamped.
#[tauri::command]
pub fn resize_palette(app: AppHandle, height: f64) {
    if let Some(win) = app.get_webview_window(PALETTE_WINDOW) {
        let h = height.clamp(COLLAPSED_HEIGHT, MAX_HEIGHT);
        let _ = win.set_size(LogicalSize::new(WIDTH, h));
    }
}

/// Bring the explorer window to the front before the palette hands it a navigation.
#[tauri::command]
pub fn show_main(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Start-menu apps, read once per process; `refresh` re-reads (a folder change).
/// `(async)`: a plain sync command runs on the main thread and the Start Menu walk froze the
/// window on a machine whose Start Menu is large or on a slow disk.
#[tauri::command(async)]
pub fn spotlight_apps(refresh: bool) -> Vec<AppEntry> {
    let mut guard = APPS.lock().unwrap_or_else(|e| e.into_inner());
    if refresh || guard.is_none() {
        *guard = Some(spotlight::all_apps(&spotlight::app_roots()));
    }
    guard.clone().unwrap_or_default()
}

/// Start an app by its `AppsFolder` id, for the rows that have no `.lnk` to open — every Store
/// app, and the ID-list-only shortcuts `parse_lnk` cannot resolve (`core/spotlight::apps_folder`).
///
/// ⛔ `shell:AppsFolder\<id>` is a **shell namespace** path, not a file, so `open_path` and the
/// opener plugin cannot start it — `ShellExecuteW` is the one call that can, and it is how Start
/// itself launches these. The id is opaque and comes straight back from the shell; it is never
/// parsed here, only re-quoted into the namespace path.
///
/// `(async)`: `ShellExecuteW` blocks while the shell resolves the package, which on a cold Store
/// app is long enough to freeze the palette.
#[tauri::command(async)]
#[cfg(windows)]
pub fn launch_app(aumid: String) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    if aumid.trim().is_empty() {
        return Err("no app id".into());
    }
    let wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(Some(0))
            .collect()
    };
    let verb = wide("open");
    let file = wide(&format!(r"shell:AppsFolder\{aumid}"));
    crate::core::icons::ensure_com();
    // SAFETY: both strings are NUL-terminated and live for the call; the remaining pointers are
    // null (no parameters, no working directory) which ShellExecuteW documents as allowed.
    let h = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ⚠️ ShellExecuteW returns a *fake* HINSTANCE: > 32 is success, and the error codes below
    // it are the reason nothing started. Treating it as a pointer reads every failure as a win.
    if h as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "the shell would not start {aumid} (code {})",
            h as isize
        ))
    }
}

/// The listed app whose id is `aumid`, from the cached list (read now if it never was).
/// ⛔ The id is only ever matched against that list — never used as a path — so the frontend
/// cannot make `launch_app` start something the list did not offer.
#[cfg(not(windows))]
fn cached_app(aumid: &str) -> Result<AppEntry, String> {
    spotlight_apps(false)
        .into_iter()
        .find(|a| !aumid.is_empty() && a.aumid == aumid)
        .ok_or_else(|| format!("{aumid} is not in the app list"))
}

/// Spawn `argv` with no shell and no inherited stdio, and reap it on a thread so a finished
/// launcher (`open`, `gio launch`) never lingers as a zombie.
#[cfg(not(windows))]
fn spawn_detached(argv: &[String]) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let (program, args) = argv.split_first().ok_or("nothing to run")?;
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start {program}: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// macOS: `open <bundle path>` for a bundle in the cached list (`core/apps_mac.rs`).
#[tauri::command(async)]
#[cfg(target_os = "macos")]
pub fn launch_app(aumid: String) -> Result<(), String> {
    let app = cached_app(&aumid)?;
    spawn_detached(&crate::core::apps_mac::launch_argv(&app))
}

/// Linux: `gio launch <desktop file>` for an entry in the cached list; without `gio`, the
/// entry's `Exec` words — no shell, refused for a terminal app (`core/apps_linux.rs`).
#[tauri::command(async)]
#[cfg(all(unix, not(target_os = "macos")))]
pub fn launch_app(aumid: String) -> Result<(), String> {
    let app = cached_app(&aumid)?;
    spawn_detached(&crate::core::apps_linux::env_launch_argv(&app)?)
}

/// A bounded name search under `roots`: at most `max_results`, three levels deep, within
/// `budget_ms`, and the unopened guarded folders it left out (Mac). `(async)`: off the main thread, so the webview never waits on the walk.
#[tauri::command(async)]
pub fn spotlight_files(
    text: String,
    roots: Vec<String>,
    max_results: usize,
    budget_ms: u64,
    max_depth: Option<usize>,
) -> spotlight::FoundFiles {
    let roots: Vec<PathBuf> = roots.into_iter().map(PathBuf::from).collect();
    spotlight::find_files(
        &text,
        &roots,
        max_depth.unwrap_or(3).clamp(1, 8),
        max_results.clamp(1, 100),
        spotlight::budget_ms(budget_ms),
    )
}

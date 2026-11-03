//! A second explorer window: a tab dragged out of the strip, or Ctrl+N. Built with the same
//! frame as `main` in tauri.conf.json (mirrored here by hand — change both or neither) and
//! labelled `main-<n>` so the capability's `main-*` covers it.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window,
};

use crate::core::session::Bounds;

/// The next window's number; `main` itself is 1.
static NEXT: AtomicU32 = AtomicU32::new(2);

/// The offset of a new window from the one that opened it, in logical px.
const CASCADE_PX: f64 = 40.0;

/// Where the macOS traffic lights sit, in logical px from the window's top-left: x 14, and y 17
/// so the ~14 px buttons centre on the tab strip (the strip is the bottom 32 px of the 40 px bar,
/// so its middle is y 24). Same numbers as `trafficLightPosition` in `tauri.macos.conf.json`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MAC_TRAFFIC_LIGHTS: (f64, f64) = (14.0, 17.0);

/// `main-2`, `main-3`, … — one per call, never reused within a process.
pub fn next_label() -> String {
    format!("main-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// The URL a new window loads: the explorer route, with the folder or place it should open
/// as a query so the shell reads it instead of argv (which belongs to `main`).
pub fn window_url(path: Option<&str>) -> String {
    window_url_tabs(path.as_slice(), 0)
}

/// The URL of a window opening several tabs at once (a restored window, plan 15 G.45): one
/// `open=` per tab, in order, and `active=` when it is not the first. One tab is exactly
/// `window_url`'s URL, so a window that reads only the first `open` is unchanged.
pub fn window_url_tabs<S: AsRef<str>>(tabs: &[S], active: usize) -> String {
    let opens: Vec<String> = tabs
        .iter()
        .map(AsRef::as_ref)
        .filter(|p| !p.is_empty())
        .map(|p| format!("open={}", urlencode(p)))
        .collect();
    if opens.is_empty() {
        return "/".to_string();
    }
    let mut query = opens.join("&");
    if active > 0 && active < opens.len() {
        query.push_str(&format!("&active={active}"));
    }
    format!("/?{query}")
}

/// Percent-encode everything but the unreserved set (RFC 3986), as `encodeURIComponent` does.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Whether a label names an explorer window: `main`, or `main-<n>` from `next_label`.
///
/// ⛔ `palette` is deliberately NOT one. It is a hidden always-on-top strip that exists for
/// the whole session, so counting it as a window is what let the app survive with no explorer
/// window at all — see `lib.rs`'s `Destroyed` arm and plancheck 8 §G.
pub fn is_explorer_label(label: &str) -> bool {
    label == "main"
        || label
            .strip_prefix("main-")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// How many explorer windows are alive, ignoring `except` (the one being destroyed, which the
/// manager may or may not have dropped yet — so it is excluded by name rather than by timing).
pub fn explorer_windows_besides<R: Runtime>(app: &AppHandle<R>, except: &str) -> usize {
    app.webview_windows()
        .keys()
        .filter(|label| label.as_str() != except && is_explorer_label(label))
        .count()
}

/// Set once the process has decided to exit, so it decides only once.
static EXITING: AtomicBool = AtomicBool::new(false);

/// End the process when `closed` was the last explorer window and nothing keeps the app alive.
/// Does nothing while resident (the tray's Quit owns that), and nothing for `palette`.
///
/// ⛔ **The exit is latched.** `app.exit` destroys every remaining window, each of which fires
/// `Destroyed` again and re-enters this function — and a re-entrant exit while tao is already
/// tearing the event loop down is the shape of the `cannot move state from Destroyed` panic
/// recorded on 2026-09-24 (plancheck 8 §G.3). The latch makes the second call a no-op instead.
pub fn exit_if_last_explorer_window<R: Runtime>(app: &AppHandle<R>, closed: &str) {
    if !is_explorer_label(closed) || crate::commands::tray::is_resident_now(app) {
        return;
    }
    if explorer_windows_besides(app, closed) != 0 {
        return;
    }
    // ⚠️ A Mac app stays in the Dock with no window; ⌘Q (or the tray's Quit) ends it, and the
    // Dock icon brings a window back (`commands::dock::reopen`). The palette is no trap there:
    // the Dock icon, ⌘Tab and Spotlight's `show_main` all reach a rebuilt `main`.
    if cfg!(target_os = "macos") {
        log::info!("the last explorer window closed — staying in the Dock");
        return;
    }
    // `swap` rather than load-then-store: two windows destroyed on the same tick must not both
    // pass the check.
    if EXITING.swap(true, Ordering::SeqCst) {
        return;
    }
    log::info!("the last explorer window closed and the app is not resident — exiting");
    app.exit(0);
}

/// Build an explorer window wearing the frame `main` declares in `tauri.conf.json`.
///
/// ⛔ **The frame is mirrored from the config by hand — change both or neither.** Every caller
/// that needs an explorer window comes through here so the mirror stays a pair rather than
/// growing a third copy: `open_window` for a detached tab or Ctrl+N, and `tray::show_main`
/// when `main` has to be rebuilt from nothing.
///
/// ⛔ **Windows: no `windowEffects`, and that is the whole point of `transparent(true)` there.**
/// Mica was dropped from every Windows window on 2026-09-25: DWM paints a backdrop into the full
/// SQUARE window rect, so it fills the corners back in behind any CSS arc, and
/// `DWMWA_WINDOW_CORNER_PREFERENCE` only ever offers ROUND (~8px) or ROUNDSMALL (~4px) — never
/// the 14px the design asks for. With no backdrop the window is genuinely see-through and
/// `--radius-window` in `app.css` draws the frame, on a detached window exactly as on `main`.
/// Adding `.effects(…)` for Windows here would give every `main-<n>` a square Mica corner while
/// `main` stayed round — the mirror is the guard. That reasoning is DWM's only: **macOS does get
/// an effect** (`Sidebar`, below, mirrored by `tauri.macos.conf.json`), because the Mac frame is
/// the system's own rounded one and its material follows that corner.
///
/// ⛔ **The DWM border is suppressed here and nowhere else for these windows.** `decorations:
/// false` keeps `WS_THICKFRAME`, so DWM strokes a 1px border on its own ~8px arc, which our 14px
/// CSS arc pulls away from at every corner — see `core::frame`. `main` is not built here (it
/// comes from `tauri.conf.json`), so `lib.rs`'s setup gives it the same call: a detached window
/// whose corners did not match `main`'s would be the mirror breaking in a new place.
///
/// `position` cascades from a caller in logical px; `None` centres. `bounds` (the size and place
/// the window had last run, `commands::session::restore_bounds`) win over both: the window is
/// built hidden, moved there, shown, and only then maximized if it was, so it never flashes at
/// the cascade first. A show that fails destroys it rather than leave a hidden window behind.
pub fn build_explorer_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    url: WebviewUrl,
    position: Option<(f64, f64)>,
    bounds: Option<Bounds>,
) -> tauri::Result<WebviewWindow<R>> {
    let builder = WebviewWindowBuilder::new(app, label, url)
        .title("Trove")
        .inner_size(1200.0, 760.0)
        .min_inner_size(800.0, 500.0)
        .decorations(false)
        .shadow(true);
    // ⚠️ On macOS `transparent` exists only with tauri's `macos-private-api` feature
    // (`tauri-2.11.6 webview_window.rs:1075`), which Cargo.toml now turns on for the glass below.
    let builder = builder.transparent(true);
    // On a Mac the window keeps the system's frame and its native traffic lights, laid over the
    // top of the page (Overlay, no title) at the left end of the tab strip; the frontend hides
    // its own caption buttons and insets the strip (`utils/window-chrome.ts`). The mirror of
    // `tauri.macos.conf.json`'s `main` — change both or neither. Plan 12 F / plan 10 E.
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(
            MAC_TRAFFIC_LIGHTS.0,
            MAC_TRAFFIC_LIGHTS.1,
        ))
        // Frosted glass behind the transparent page, Finder's sidebar material, going flat when
        // the window loses focus. The page keeps the file list, panes and dialogs solid and lets
        // it show only under the title bar, tab strip and sidebar (`app.css`, `data-os`).
        .effects(
            tauri::window::EffectsBuilder::new()
                .effect(tauri::window::Effect::Sidebar)
                .state(tauri::window::EffectState::FollowsWindowActiveState)
                .build(),
        )
        // the glass follows the window's appearance: open in the saved theme, not the OS's
        .theme(crate::commands::settings::saved_window_theme(app));
    let window = match position {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    }
    .visible(bounds.is_none())
    .build()?;
    crate::core::frame::suppress_dwm_border(&window);
    crate::core::sys_menu::guard(&window);
    crate::core::min_size::guard(&window);
    crate::core::frame::set_window_icon(&window);
    crate::core::key_menu::guard(&window);
    crate::core::drag_out::prepare_window(&window);
    if label == "main" {
        // a rebuilt `main` brings its own bounds: a maximize the old one never showed is stale
        MAXIMIZE_MAIN_ON_SHOW.store(false, Ordering::Relaxed);
    }
    if let Some(bounds) = bounds {
        apply_bounds(&window, bounds);
        if let Err(e) = window.show() {
            // hidden and never shown, it would live on with no way to close it
            let _ = window.destroy();
            return Err(e);
        }
        // only once it is on screen: see `maximize_when_shown`
        if bounds.maximized {
            if let Err(e) = window.maximize() {
                log::warn!("{label}: could not maximize the window: {e}");
            }
        }
    }
    Ok(window)
}

/// `main`'s restored maximize, waiting for the window to be shown (`maximize_when_shown`).
static MAXIMIZE_MAIN_ON_SHOW: AtomicBool = AtomicBool::new(false);

/// Put `window` at `bounds` (physical px, already fitted to the monitors), all but the maximize:
/// that is the caller's, once the window is on screen (`maximize_when_shown`). The size, the
/// place, then the size again: moving onto a monitor of another scale makes the OS rescale the
/// window (per-monitor DPI), which would leave a size set only before the move 1.5x off. Where
/// the windowing system keeps a window's place to itself (Wayland,
/// `commands::session::positions_hidden`), the size alone.
pub fn apply_bounds<R: Runtime>(window: &WebviewWindow<R>, bounds: Bounds) {
    let label = window.label();
    let size = PhysicalSize::new(bounds.w, bounds.h);
    if let Err(e) = window.set_size(size) {
        log::warn!("{label}: could not restore the window size: {e}");
    }
    if crate::commands::session::positions_hidden() {
        return;
    }
    if let Err(e) = window.set_position(PhysicalPosition::new(bounds.x, bounds.y)) {
        log::warn!("{label}: could not restore the window position: {e}");
    }
    if let Err(e) = window.set_size(size) {
        log::warn!("{label}: could not restore the window size: {e}");
    }
}

/// Put `window`'s VISIBLE frame exactly on `rect` (physical px): what Cascade / Stacked / Side by
/// side and Trove's own Snap ask for, where the visible edge must land on the work area's edge.
///
/// ⛔ **Windows: not `apply_bounds`.** Every explorer window keeps `WS_THICKFRAME`, and the OS
/// hangs an invisible 7 px resize border (at 100 %) off its left, right and bottom: an outer
/// position set to the work area's corner left a 7 px gap on the left, ran 9 px past the right
/// edge and 2 px over the taskbar (plan 20.4.3, 2026-10-21). Here the border is measured per
/// window (`GetWindowRect` against DWM's `DWMWA_EXTENDED_FRAME_BOUNDS`) and the OUTER rect set
/// to `rect` grown by it, as the OS's own Snap does. Twice: a move onto a monitor of another
/// scale makes the OS rescale the window AND its border, so the second pass measures again.
/// Elsewhere (no invisible border) this is `apply_bounds`, the outer position and inner size.
pub fn place_visible<R: Runtime>(window: &WebviewWindow<R>, rect: Bounds) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        let hwnd: windows_sys::Win32::Foundation::HWND = hwnd.0.cast();
        for _ in 0..2 {
            let insets = win32_frame(hwnd)
                .map(|(outer, frame)| crate::core::window_layout::frame_insets(outer, frame))
                .unwrap_or_default();
            let outer = crate::core::window_layout::outer_for(rect, insets);
            if !win32_set_outer(hwnd, outer) {
                log::warn!("{}: could not place the window", window.label());
                break;
            }
        }
        return;
    }
    apply_bounds(window, rect);
}

/// Where `window`'s VISIBLE frame is now, physical px: on Windows DWM's frame bounds (no
/// invisible border), elsewhere the outer position and inner size, as `Bounds` is saved.
pub fn visible_bounds<R: Runtime>(window: &WebviewWindow<R>) -> Result<Bounds, String> {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        if let Some((_, frame)) = win32_frame(hwnd.0.cast()) {
            return Ok(crate::core::window_layout::rect_bounds(frame));
        }
    }
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    Ok(Bounds {
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
        maximized: false,
    })
}

/// `hwnd`'s outer rect (`GetWindowRect`) and visible frame (`DWMWA_EXTENDED_FRAME_BOUNDS`), each
/// `[left, top, right, bottom]` in screen px. `None` when either read fails.
#[cfg(windows)]
fn win32_frame(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<([i32; 4], [i32; 4])> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let mut outer = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let mut frame = outer;
    let size = u32::try_from(std::mem::size_of::<RECT>()).ok()?;
    // SAFETY: `hwnd` is a live window handle from tauri; both out-pointers are live `RECT`s and
    // DWM is told exactly their size.
    let ok = unsafe {
        GetWindowRect(hwnd, &mut outer) != 0
            && DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                std::ptr::from_mut(&mut frame).cast(),
                size,
            ) >= 0
    };
    let as_array = |r: RECT| [r.left, r.top, r.right, r.bottom];
    ok.then(|| (as_array(outer), as_array(frame)))
}

/// Set `hwnd`'s outer rect, keeping its z-order and focus. `false` when the OS refused.
#[cfg(windows)]
fn win32_set_outer(hwnd: windows_sys::Win32::Foundation::HWND, outer: Bounds) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
    };
    let (Ok(w), Ok(h)) = (i32::try_from(outer.w), i32::try_from(outer.h)) else {
        return false;
    };
    // SAFETY: `hwnd` is a live window handle from tauri; a null insert-after is ignored with
    // SWP_NOZORDER.
    unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            outer.x,
            outer.y,
            w,
            h,
            SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE,
        ) != 0
    }
}

/// Maximize `main`, built hidden, once it is on screen: now if it already is, else at its next
/// show (`maximize_if_due`). ⛔ Never `maximize()` a hidden window: on Windows tao does it with
/// `ShowWindow(SW_MAXIMIZE)` and no visibility check (`tao-0.35.3 window_state.rs:377`), which
/// SHOWS it, so a `--hidden` start popped up maximized at login instead of staying in the tray,
/// and a normal start showed an empty window before its first paint.
pub fn maximize_when_shown<R: Runtime>(window: &WebviewWindow<R>) {
    MAXIMIZE_MAIN_ON_SHOW.store(true, Ordering::Relaxed);
    maximize_if_due(&window.as_ref().window());
}

/// `main` may just have been shown (`show_window`, `tray::show_main`, the backstop, or the
/// focus a show usually ends in, `commands::session::on_window_event`): the maximize it was
/// waiting for, if any.
pub fn maximize_if_due<R: Runtime>(window: &Window<R>) {
    let visible = window.is_visible().unwrap_or(false);
    if take_due(&MAXIMIZE_MAIN_ON_SHOW, window.label(), visible) {
        if let Err(e) = window.maximize() {
            log::warn!("main: could not maximize the window: {e}");
        }
    }
}

/// Whether `label`, `visible` or not, is due the maximize `flag` holds — clearing it if so: once,
/// for `main` only, and only on screen.
fn take_due(flag: &AtomicBool, label: &str, visible: bool) -> bool {
    label == "main" && visible && flag.swap(false, Ordering::Relaxed)
}

/// The page puts its window on screen (`showWindow`, the reveal in `use-shell`): show it, then
/// the maximize it was waiting for, here and not at the focus that usually follows. A show that
/// brings no focus — a `--hidden` start that is not resident, which has no backstop — otherwise
/// left `main` waiting, and it maximized on the user's first click instead.
#[tauri::command]
pub fn show_window(window: WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    maximize_if_due(&window.as_ref().window());
    Ok(())
}

/// Open a new explorer window on `path` (a folder, or a place's name), cascaded from the
/// window `from`. Returns the new window's label. `async` on purpose: a sync command runs on
/// the main thread, and on Windows building a webview there deadlocks the event loop the
/// webview needs — the window came up on `about:blank` and the call never returned.
#[tauri::command]
pub async fn open_window(
    app: AppHandle,
    path: Option<String>,
    from: String,
    tabs: Option<Vec<String>>,
    active: Option<usize>,
) -> Result<String, String> {
    let label = next_label();
    // a restored window comes back where it was last run; a new one cascades
    let bounds = crate::commands::session::restore_bounds(&app, &label, tabs.as_deref());
    // `tabs` (a restored window) wins over `path`; without it this is the one-folder window
    let url = match tabs {
        Some(tabs) => window_url_tabs(&tabs, active.unwrap_or(0)),
        None => window_url(path.as_deref()),
    };
    let url = WebviewUrl::App(url.into());
    // cascade from the caller: its outer position plus 40 px, in the caller's logical units
    let position = app.get_webview_window(&from).and_then(|origin| {
        match (origin.outer_position(), origin.scale_factor()) {
            (Ok(pos), Ok(scale)) => {
                let logical = pos.to_logical::<f64>(scale);
                Some((logical.x + CASCADE_PX, logical.y + CASCADE_PX))
            }
            _ => None,
        }
    });
    build_explorer_window(&app, &label, url, position, bounds).map_err(|e| e.to_string())?;
    Ok(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The windows array of a config file, by label.
    fn windows_of(json: &str) -> Vec<serde_json::Value> {
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        v["app"]["windows"].as_array().unwrap().clone()
    }

    #[test]
    fn the_mac_config_differs_from_the_base_only_by_the_native_title_bar() {
        // ⛔ Tauri merges `tauri.macos.conf.json` as a JSON merge patch, and a patch REPLACES
        // an array: the Mac file has to carry every window whole, so a field added to the base
        // and not to it would silently vanish on a Mac. This keeps the two in step.
        // `transparent` (and with it the glass) needs this flag on a Mac; tauri-build refuses
        // the `macos-private-api` feature without it, but only at build time — pin it here too.
        let base_cfg: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(base_cfg["app"]["macOSPrivateApi"], true);
        let base = windows_of(include_str!("../../tauri.conf.json"));
        let mac = windows_of(include_str!("../../tauri.macos.conf.json"));
        assert_eq!(base.len(), mac.len());
        for (b, m) in base.iter().zip(&mac) {
            let mut m = m.as_object().unwrap().clone();
            let mut b = b.as_object().unwrap().clone();
            if m["label"] == "main" {
                assert_eq!(m.remove("decorations").unwrap(), true);
                assert_eq!(m.remove("titleBarStyle").unwrap(), "Overlay");
                assert_eq!(m.remove("hiddenTitle").unwrap(), true);
                let lights = m.remove("trafficLightPosition").unwrap();
                assert_eq!(lights["x"].as_f64(), Some(MAC_TRAFFIC_LIGHTS.0));
                assert_eq!(lights["y"].as_f64(), Some(MAC_TRAFFIC_LIGHTS.1));
                // frosted glass on a Mac, as `build_explorer_window` gives every other window
                let effects = m.remove("windowEffects").unwrap();
                assert_eq!(effects["effects"], serde_json::json!(["sidebar"]));
                assert_eq!(effects["state"], "followsWindowActiveState");
                b.remove("decorations");
            }
            if m["label"] == "palette" {
                // a hidden WKWebView pauses its JS, so Spotlight's first frame on show() would
                // be the theme it was hidden with; Windows' WebView2 does not need this
                assert_eq!(m.remove("backgroundThrottling").unwrap(), "disabled");
            }
            assert_eq!(b, m);
        }
    }

    #[test]
    fn labels_count_up_from_two_and_never_repeat() {
        let a = next_label();
        let b = next_label();
        assert!(a.starts_with("main-") && b.starts_with("main-"));
        assert_ne!(a, b);
        let na: u32 = a["main-".len()..].parse().unwrap();
        let nb: u32 = b["main-".len()..].parse().unwrap();
        // ⛔ not `nb == na + 1`: the counter is one static shared by every test, and the test
        // runner calls `next_label` from other threads between these two lines. Increasing is
        // what the app relies on; consecutive is only true when nothing else runs.
        assert!(na >= 2 && nb > na, "{a} then {b}");
    }

    #[test]
    fn an_explorer_label_is_main_or_main_followed_by_digits() {
        assert!(is_explorer_label("main"));
        assert!(is_explorer_label("main-2"));
        assert!(is_explorer_label("main-10"));
        // ⛔ the palette is the reason this function exists — it must never count
        assert!(!is_explorer_label("palette"));
        // `main-*` is the capability's glob, not a label; nothing but digits qualifies
        assert!(!is_explorer_label("main-"));
        assert!(!is_explorer_label("main-*"));
        assert!(!is_explorer_label("main-2x"));
        assert!(!is_explorer_label("mainly"));
        assert!(!is_explorer_label(""));
    }

    #[test]
    fn every_label_next_label_hands_out_is_an_explorer_label() {
        for _ in 0..4 {
            assert!(is_explorer_label(&next_label()));
        }
    }

    #[test]
    fn the_url_carries_the_target_percent_encoded() {
        assert_eq!(window_url(None), "/");
        assert_eq!(window_url(Some("")), "/");
        assert_eq!(window_url(Some("This PC")), "/?open=This%20PC");
        // the macOS and Linux names of the same place (plan 10, B.2.2)
        assert_eq!(window_url(Some("This Mac")), "/?open=This%20Mac");
        assert_eq!(window_url(Some("This Computer")), "/?open=This%20Computer");
        assert_eq!(
            window_url(Some(r"C:\Users\alex")),
            "/?open=C%3A%5CUsers%5Calex"
        );
        assert_eq!(
            window_url(Some("Ubuntu:/home/alex")),
            "/?open=Ubuntu%3A%2Fhome%2Falex"
        );
    }

    #[test]
    fn a_restored_window_url_carries_every_tab_and_the_active_one() {
        assert_eq!(
            window_url_tabs(&[r"C:\a", r"D:\b"], 1),
            "/?open=C%3A%5Ca&open=D%3A%5Cb&active=1"
        );
        // the first tab active: no `active`, and one tab is exactly the one-folder URL
        assert_eq!(
            window_url_tabs(&[r"C:\a", r"D:\b"], 0),
            "/?open=C%3A%5Ca&open=D%3A%5Cb"
        );
        assert_eq!(window_url_tabs(&[r"C:\a"], 0), window_url(Some(r"C:\a")));
        // nothing to open, or an index past the end
        assert_eq!(window_url_tabs::<&str>(&[], 3), "/");
        assert_eq!(window_url_tabs(&["", ""], 0), "/");
        assert_eq!(window_url_tabs(&["x"], 5), "/?open=x");
    }

    #[test]
    fn a_held_maximize_lands_at_the_first_show_with_no_focus_needed() {
        // `show_window` asks right after its show: nothing waits on a focus event
        let flag = AtomicBool::new(true);
        // still hidden (a `--hidden` start), or another window: it keeps waiting
        assert!(!take_due(&flag, "main", false));
        assert!(!take_due(&flag, "main-2", true));
        assert!(flag.load(Ordering::Relaxed));
        // on screen: once, and the focus that may follow finds nothing left to do
        assert!(take_due(&flag, "main", true));
        assert!(!take_due(&flag, "main", true));
    }
}

//! Plan 20: Trove's own Snap for one window (the Snap keys, bound on a Mac coming from Windows)
//! and Cascade / Show windows stacked / Show windows side by side for all of them. The rules are
//! `core::window_layout`; this file reads the windows and monitors and moves them.
//!
//! Only explorer windows ever move: never Spotlight (`palette`), never another app's. A
//! minimized or hidden window is left out; a maximized one is restored first. Where the
//! windowing system keeps window places to itself (Wayland, `positions_hidden`), both commands
//! refuse and touch nothing.

use std::collections::BTreeMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::commands::session::{positions_hidden, screens};
use crate::commands::windows::{is_explorer_label, place_visible, visible_bounds};
use crate::core::session::{screen_under, Bounds, Screen};
#[cfg(target_os = "macos")]
use crate::core::window_layout::on_active_stage;
use crate::core::window_layout::{
    arrange_order, layout_rects, next_monitor, next_snap, snap_rect, snap_state, Candidate, Layout,
    SnapAction, SnapKey, SnapMemo,
};

/// The halves Trove snapped each window to, by label (`snap_state` reads it).
static MEMOS: Mutex<BTreeMap<String, SnapMemo>> = Mutex::new(BTreeMap::new());

const NO_PLACES: &str =
    "This desktop (Wayland) keeps window places to itself, so Trove cannot move its windows.";

/// The refusal both commands share: where the windowing system keeps window places to itself
/// (Wayland), nothing is moved and the caller gets `NO_PLACES`.
fn refuse_if_hidden(hidden: bool) -> Result<(), String> {
    if hidden {
        return Err(NO_PLACES.into());
    }
    Ok(())
}

fn memos() -> std::sync::MutexGuard<'static, BTreeMap<String, SnapMemo>> {
    MEMOS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Where `window` is now: its VISIBLE frame, physical px (`windows::visible_bounds`), the same
/// rect `place_visible` puts it at, so a snapped window reads back as its snap rect.
fn bounds_of<R: Runtime>(window: &WebviewWindow<R>) -> Result<Bounds, String> {
    visible_bounds(window)
}

/// The monitor `b` is on most; off every monitor, the primary one.
fn area_for(b: &Bounds, monitors: &[Screen]) -> Option<Screen> {
    screen_under(b, monitors)
        .or_else(|| monitors.iter().find(|s| s.primary))
        .or(monitors.first())
        .copied()
}

fn log_err<E: std::fmt::Display>(label: &str, what: &str, r: Result<(), E>) {
    if let Err(e) = r {
        log::warn!("{label}: could not {what}: {e}");
    }
}

/// One Snap key in `window` (Windows 11's rules, plan 20 "What the four keys do").
#[tauri::command(async)]
pub fn snap_window(window: WebviewWindow, key: SnapKey) -> Result<(), String> {
    refuse_if_hidden(positions_hidden())?;
    let label = window.label().to_string();
    if !is_explorer_label(&label) {
        return Err(format!("{label} is not an explorer window"));
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let mut now = bounds_of(&window)?;
    let memo = memos().get(&label).copied();
    let monitors = screens(window.app_handle());
    match next_snap(snap_state(memo.as_ref(), now, maximized), key) {
        SnapAction::Snap(side) => {
            if maximized {
                log_err(&label, "unmaximize", window.unmaximize());
                now = bounds_of(&window).unwrap_or(now);
            }
            let Some(area) = area_for(&now, &monitors) else {
                return Err("no monitor".into());
            };
            let rect = snap_rect(&area, side);
            place_visible(&window, rect);
            memos().insert(
                label,
                SnapMemo {
                    side,
                    rect,
                    before: now,
                },
            );
        }
        SnapAction::NextMonitor(side) => {
            let (Some(memo), Some(area)) = (memo, area_for(&now, &monitors)) else {
                return Ok(());
            };
            if let Some(next) = next_monitor(&area, &monitors, side) {
                let rect = snap_rect(next, side);
                place_visible(&window, rect);
                memos().insert(label, SnapMemo { rect, ..memo });
            }
        }
        SnapAction::Maximize => {
            memos().remove(&label);
            log_err(&label, "maximize", window.maximize());
        }
        SnapAction::Unmaximize => log_err(&label, "unmaximize", window.unmaximize()),
        SnapAction::Restore => {
            if let Some(memo) = memos().remove(&label) {
                place_visible(&window, memo.before);
            }
        }
        SnapAction::Minimize => log_err(&label, "minimize", window.minimize()),
        SnapAction::Nothing => {}
    }
    Ok(())
}

/// Arrange every shown explorer window by `layout` on the monitor of `asking` (else of `main`,
/// else of the first one placed; off every monitor, the primary one). The asking window ends
/// focused. Returns how many windows moved.
pub fn arrange<R: Runtime>(
    app: &AppHandle<R>,
    asking: &str,
    layout: Layout,
) -> Result<usize, String> {
    arrange_with(app, asking, layout, positions_hidden())
}

/// `arrange` with "are window places hidden" passed in, so a test can take the Wayland path on
/// any desktop.
fn arrange_with<R: Runtime>(
    app: &AppHandle<R>,
    asking: &str,
    layout: Layout,
    hidden: bool,
) -> Result<usize, String> {
    refuse_if_hidden(hidden)?;
    let windows = app.webview_windows();
    let candidates: Vec<Candidate> = windows
        .iter()
        .map(|(label, w)| Candidate {
            label: label.clone(),
            explorer: is_explorer_label(label),
            shown: w.is_visible().unwrap_or(false)
                && !w.is_minimized().unwrap_or(false)
                && on_stage(w),
        })
        .collect();
    let anchor = if is_explorer_label(asking) {
        asking
    } else {
        "main"
    };
    let order = arrange_order(&candidates, anchor, layout);
    let Some(first) = order.first() else {
        return Ok(0);
    };
    let anchor = if order.iter().any(|l| l == anchor) {
        anchor
    } else {
        first.as_str()
    };
    let monitors = screens(app);
    let at = windows.get(anchor).map(bounds_of).transpose()?;
    let Some(area) = at.and_then(|b| area_for(&b, &monitors)) else {
        return Err("no monitor".into());
    };
    let rects = layout_rects(layout, order.len(), &area);
    let mut memo = memos();
    for (label, rect) in order.iter().zip(rects) {
        let Some(w) = windows.get(label) else {
            continue;
        };
        if w.is_maximized().unwrap_or(false) {
            log_err(label, "unmaximize", w.unmaximize());
        }
        place_visible(w, rect);
        memo.remove(label);
        // a cascade is a pile: each one comes up over the last, the asking window on top
        if layout == Layout::Cascade {
            log_err(label, "focus", w.set_focus());
        }
    }
    drop(memo);
    if let Some(w) = windows.get(anchor) {
        log_err(anchor, "focus", w.set_focus());
    }
    Ok(order.len())
}

/// Whether `w` is on the active Stage Manager stage (`on_active_stage`). Only the Mac has one.
#[cfg(not(target_os = "macos"))]
fn on_stage<R: Runtime>(_w: &WebviewWindow<R>) -> bool {
    true
}

/// Whether `w` is on the active Stage Manager stage: its own size against the size the window
/// server draws it at (`CGWindowListCopyWindowInfo`, `kCGWindowBounds`, points).
#[cfg(target_os = "macos")]
fn on_stage<R: Runtime>(w: &WebviewWindow<R>) -> bool {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSString;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *mut AnyObject;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const std::ffi::c_void);
    }
    const INCLUDING_WINDOW: u32 = 1 << 3; // kCGWindowListOptionIncludingWindow

    let (Ok(size), Ok(scale), Ok(ns)) = (w.outer_size(), w.scale_factor(), w.ns_window()) else {
        return true;
    };
    let own = (
        f64::from(size.width) / scale,
        f64::from(size.height) / scale,
    );
    let ns = ns.cast::<AnyObject>();
    // SAFETY: `ns` is this window's live NSWindow; `windowNumber` is a plain getter
    let number: isize = unsafe { msg_send![ns, windowNumber] };
    let Ok(number) = u32::try_from(number) else {
        return true;
    };
    // SAFETY: a Copy-rule CFArray (toll-free an NSArray of NSDictionary), released below; every
    // object read from it is checked for nil before use
    let drawn = unsafe {
        let list = CGWindowListCopyWindowInfo(INCLUDING_WINDOW, number);
        if list.is_null() {
            return true;
        }
        let entry: *mut AnyObject = msg_send![list, firstObject];
        let bounds: *mut AnyObject = if entry.is_null() {
            std::ptr::null_mut()
        } else {
            msg_send![entry, objectForKey: &*NSString::from_str("kCGWindowBounds")]
        };
        let read = |key: &str| -> Option<f64> {
            let n: *mut AnyObject = msg_send![bounds, objectForKey: &*NSString::from_str(key)];
            (!n.is_null()).then(|| msg_send![n, doubleValue])
        };
        let drawn = if bounds.is_null() {
            None
        } else {
            read("Width").zip(read("Height"))
        };
        CFRelease(list.cast());
        drawn
    };
    on_active_stage(own, drawn)
}

/// Cascade / Show windows stacked / Show windows side by side, asked from `window` (an explorer
/// window, or Spotlight: then they go on `main`'s monitor). Returns how many windows moved.
#[tauri::command(async)]
pub fn arrange_windows(
    app: AppHandle,
    window: WebviewWindow,
    layout: Layout,
) -> Result<usize, String> {
    arrange(&app, window.label(), layout)
}

// The Mac menu bar's Window items (`commands::app_menu`), here so the routing is tested on every
// OS. Prefixed like the menu's other ids: menu events are app-wide.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the menu bar is the Mac's
pub const MENU_CASCADE: &str = "app-menu:cascade-windows";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the menu bar is the Mac's
pub const MENU_STACKED: &str = "app-menu:stack-windows";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the menu bar is the Mac's
pub const MENU_SIDE_BY_SIDE: &str = "app-menu:windows-side-by-side";

/// The arrange a menu item id asks for, and the focused explorer window it is asked from. Not
/// one of these ids, or no explorer window focused (Spotlight, nothing) → `None`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the menu bar is the Mac's
pub fn menu_arrange<'a>(id: &str, focused: Option<&'a str>) -> Option<(&'a str, Layout)> {
    let layout = match id {
        MENU_CASCADE => Layout::Cascade,
        MENU_STACKED => Layout::Stacked,
        MENU_SIDE_BY_SIDE => Layout::SideBySide,
        _ => return None,
    };
    focused
        .filter(|l| is_explorer_label(l))
        .map(|l| (l, layout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_arrange_items_go_to_the_focused_explorer_window_only() {
        assert_eq!(
            menu_arrange(MENU_CASCADE, Some("main")),
            Some(("main", Layout::Cascade))
        );
        assert_eq!(
            menu_arrange(MENU_STACKED, Some("main-4")),
            Some(("main-4", Layout::Stacked))
        );
        assert_eq!(
            menu_arrange(MENU_SIDE_BY_SIDE, Some("main-2")),
            Some(("main-2", Layout::SideBySide))
        );
        for id in [MENU_CASCADE, MENU_STACKED, MENU_SIDE_BY_SIDE] {
            assert_eq!(menu_arrange(id, Some("palette")), None);
            assert_eq!(menu_arrange(id, None), None);
        }
        // the menu's other items, and the tray's
        assert_eq!(menu_arrange("app-menu:close-tab", Some("main")), None);
        assert_eq!(menu_arrange("cascade-windows", Some("main")), None);
    }

    #[test]
    fn arranging_refuses_with_the_places_error_when_positions_are_hidden() {
        assert_eq!(refuse_if_hidden(true), Err(NO_PLACES.to_string()));
        assert_eq!(refuse_if_hidden(false), Ok(()));
    }

    // Linux only: the mock runtime is a Linux dev-dependency (see Cargo.toml for why).
    #[cfg(target_os = "linux")]
    #[test]
    fn arrange_itself_refuses_on_wayland_and_moves_nothing() {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        use tauri::{PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let handle = app.handle();
        for label in ["main", "main-2"] {
            let w = WebviewWindowBuilder::new(handle, label, WebviewUrl::default())
                .build()
                .unwrap();
            w.set_position(PhysicalPosition::new(37, 91)).unwrap();
            w.set_size(PhysicalSize::new(640, 480)).unwrap();
        }
        let before: Vec<_> = ["main", "main-2"]
            .iter()
            .map(|l| {
                let w = handle.get_webview_window(l).unwrap();
                (w.outer_position().unwrap(), w.outer_size().unwrap())
            })
            .collect();

        let got = arrange_with(handle, "main", Layout::Cascade, true);

        assert_eq!(got, Err(NO_PLACES.to_string()));
        let after: Vec<_> = ["main", "main-2"]
            .iter()
            .map(|l| {
                let w = handle.get_webview_window(l).unwrap();
                (w.outer_position().unwrap(), w.outer_size().unwrap())
            })
            .collect();
        assert_eq!(before, after);
    }
}

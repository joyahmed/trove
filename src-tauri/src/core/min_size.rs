//! The smallest an explorer window may be is its INSIDE: 800x500 logical px of page, on every OS
//! (Joy, 2026-10-23). `min_inner_size` / `minWidth`+`minHeight` already say so, and the Mac and
//! Linux backends honour it, but on Windows tao turns it into the OUTER minimum.
//!
//! Why (tao-0.35.3, `src/platform_impl/windows`): an undecorated window with a shadow has its
//! client area pulled in by `WM_NCCALCSIZE` (`event_loop.rs:2172-2180`, insets from
//! `util.rs:434 calculate_insets_for_dpi`: the resize-frame thickness left, right and bottom,
//! 1 px per 100% scale on top on Windows 11). `WM_GETMINMAXINFO` (`event_loop.rs:1833`) converts
//! the min with `adjust_size(.., is_decorated = false)`, which strips `WS_SIZEBOX`/`WS_CAPTION`
//! and adds NOTHING for those insets. Measured at 100% (plan 15 A.1.5): outer stops at 800x500,
//! page 784x491.
//!
//! The fix: our own subclass lets tao fill `ptMinTrackSize` first, then grows it by the frame
//! the window really has right now (window rect minus client rect, both physical px), so it holds
//! at any DPI and on Windows 10 as well as 11.

/// `ptMinTrackSize` grown by the window's own frame (`window` minus `client`, physical px).
///
/// A frame that reads negative on either axis is not a frame: the minimum is left as tao set it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn outer_min(min: (i32, i32), window: (i32, i32), client: (i32, i32)) -> (i32, i32) {
    let frame = (window.0 - client.0, window.1 - client.1);
    if frame.0 < 0 || frame.1 < 0 {
        return min;
    }
    (min.0 + frame.0, min.1 + frame.1)
}

/// Subclass an explorer window so its minimum is the inside size. Idempotent (same proc, same
/// id), and run on the main thread whoever calls it.
#[cfg(windows)]
pub fn guard<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let label = window.label().to_string();
    // `window.hwnd()` is the `windows` crate's HWND, of another major than ours: take the pointer.
    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as isize,
        Err(e) => {
            log::warn!("min size: no HWND for {label} — minimum stays the outer size: {e}");
            return;
        }
    };
    if let Err(e) = window.run_on_main_thread(move || {
        // SAFETY: `hwnd` is a live top-level window of this (the main) thread.
        if unsafe { subclass(hwnd as _) } {
            log::debug!("min size: inner minimum on {label}");
        } else {
            log::warn!("min size: SetWindowSubclass refused {label}");
        }
    }) {
        log::warn!("min size: could not reach the main thread: {e}");
    }
}

#[cfg(windows)]
unsafe fn subclass(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetWindowRect, IsIconic, IsZoomed, MINMAXINFO, WM_GETMINMAXINFO,
        WM_NCDESTROY,
    };

    /// Ours, and different from the other subclasses' ids: "mins".
    const SUBCLASS_ID: usize = 0x6d69_6e73;

    unsafe extern "system" fn proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if msg == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(proc), SUBCLASS_ID);
            return DefSubclassProc(hwnd, msg, wparam, lparam);
        }
        // tao (installed before us, so called by DefSubclassProc) fills the minimum first
        let result = DefSubclassProc(hwnd, msg, wparam, lparam);
        // maximized or minimized, the rects are not the resizable frame
        if msg == WM_GETMINMAXINFO && lparam != 0 && IsZoomed(hwnd) == 0 && IsIconic(hwnd) == 0 {
            let mut w: RECT = std::mem::zeroed();
            let mut c: RECT = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut w) != 0 && GetClientRect(hwnd, &mut c) != 0 {
                let mmi = &mut *(lparam as *mut MINMAXINFO);
                let (x, y) = outer_min(
                    (mmi.ptMinTrackSize.x, mmi.ptMinTrackSize.y),
                    (w.right - w.left, w.bottom - w.top),
                    (c.right - c.left, c.bottom - c.top),
                );
                mmi.ptMinTrackSize.x = x;
                mmi.ptMinTrackSize.y = y;
            }
        }
        result
    }

    SetWindowSubclass(hwnd, Some(proc), SUBCLASS_ID, 0) != 0
}

/// The non-Windows twin: macOS and Linux already hold `min_inner_size` to the inside.
#[cfg(not(windows))]
pub fn guard<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grows_the_minimum_by_the_frame_measured_at_100_percent() {
        // plan 15 A.1.5: outer 800x500 held a 784x491 page — the frame is 16x9
        assert_eq!(outer_min((800, 500), (800, 500), (784, 491)), (816, 509));
    }

    #[test]
    fn grows_by_the_physical_frame_at_150_percent() {
        // 800x500 logical is 1200x750 physical; a 12/12/12 + 2 top frame is 24x14
        assert_eq!(
            outer_min((1200, 750), (1500, 900), (1476, 886)),
            (1224, 764)
        );
    }

    #[test]
    fn no_frame_leaves_the_minimum_alone() {
        // fullscreen, or a window whose client is the whole window
        assert_eq!(outer_min((800, 500), (1000, 700), (1000, 700)), (800, 500));
    }

    #[test]
    fn a_negative_frame_is_ignored() {
        // rects that cannot be a frame (the proc already skips minimized and maximized windows)
        assert_eq!(outer_min((800, 500), (0, 0), (784, 491)), (800, 500));
        assert_eq!(outer_min((800, 500), (900, 400), (884, 500)), (800, 500));
    }
}

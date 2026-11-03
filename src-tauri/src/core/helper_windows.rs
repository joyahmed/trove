//! The invisible helper windows our libraries create, kept alive against a stray `WM_CLOSE`.
//!
//! Four libraries each make a hidden top-level window on the main thread to receive messages:
//!
//! | class                      | owner                          | what dies with it                        |
//! |----------------------------|--------------------------------|------------------------------------------|
//! | `Tao Thread Event Target`  | tao (the event loop)           | every message sent through the loop proxy |
//! | `<identifier>-sic`         | tauri-plugin-single-instance   | the hand-off of a second launch           |
//! | `global_hotkey_app`        | global-hotkey (Spotlight chord)| the chord itself (Windows frees it)       |
//! | `tray_icon_app`            | tray-icon (resident mode)      | the tray icon and its menu                |
//!
//! None of their window procedures handles `WM_CLOSE`, so `DefWindowProcW` answers it with
//! `DestroyWindow`. Nothing a person can click reaches these windows — they are 0x0, layered,
//! never activated — but anything that posts `WM_CLOSE` to every window of the process does:
//! `taskkill /IM trove.exe` without `/F`, and a test harness on 2026-10-20 that did exactly
//! that. Afterwards, on the screen:
//!
//! - the main window could not be closed — not by `WM_CLOSE`, not by Trove's own Close button:
//!   the JS close path (`api/window.ts`) ends in `plugin:window|close`, which reaches the event
//!   loop only through tao's proxy, and the proxy's window was gone (reasoned from
//!   `tauri-runtime-wry-2.11.4` + `tao-0.35.3`, not traced on the screen);
//! - the next launch started a SECOND Trove: the plugin's mutex is still held, but
//!   `FindWindowW` finds no window to hand the launch to, so the new process simply carries on
//!   (`tauri-plugin-single-instance-2.4.5/src/platform_impl/windows.rs`, the
//!   `if !hwnd.is_null()` branch has no else). The mutex is NOT released — that is not the bug;
//! - both processes logged `spotlight hotkey: registered alt+space`: the first one's hotkey
//!   window had been destroyed, which frees its chord.
//!
//! So each of these windows is subclassed to swallow `WM_CLOSE`. Their owners never close them
//! with `WM_CLOSE` — they call `DestroyWindow` directly (the plugin on `RunEvent::Exit`,
//! global-hotkey and tray-icon on drop, tao on exit) — so swallowing it costs them nothing.
//! The explorer windows and the palette are NOT on the list: their close is Tauri's
//! `CloseRequested`, decided in `lib.rs` and `commands::spotlight`.
//!
//! ⚠️ Upstream: the same hole is in each library. A fix there would answer `WM_CLOSE` with 0 in
//! the window proc; until then this guard is the only thing standing in for it.

/// tao's thread event target: `tao-0.35.3/src/platform_impl/windows/event_loop.rs:627`.
#[cfg_attr(not(windows), allow(dead_code))]
const TAO_EVENT_TARGET: &str = "Tao Thread Event Target";
/// `global-hotkey-0.8.0/src/platform_impl/windows/mod.rs:32`.
#[cfg_attr(not(windows), allow(dead_code))]
const GLOBAL_HOTKEY: &str = "global_hotkey_app";
/// `tray-icon-0.24.2/src/platform_impl/windows/mod.rs:95`.
#[cfg_attr(not(windows), allow(dead_code))]
const TRAY_ICON: &str = "tray_icon_app";

/// Whether a window of this class is one of the helpers to keep alive.
///
/// The single-instance class is `<identifier>-sic`, or `<identifier>_<semver>-sic` with the
/// plugin's `semver` feature, so it is matched by its ends rather than spelled out.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_guarded_class(class: &str, identifier: &str) -> bool {
    class == TAO_EVENT_TARGET
        || class == GLOBAL_HOTKEY
        || class == TRAY_ICON
        || (class.starts_with(identifier) && class.ends_with("-sic"))
}

/// Subclass every helper window on the CALLING thread so `WM_CLOSE` is swallowed. Returns how
/// many were guarded. Idempotent: subclassing again with the same proc and id only updates it,
/// so it is safe to call again after the tray icon is built.
///
/// ⛔ Must run on the main thread — the windows live there, and `SetWindowSubclass` refuses a
/// window of another thread. Off it, use `guard_on_main`.
#[cfg(windows)]
pub fn guard_this_thread(identifier: &str) -> usize {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumThreadWindows, GetClassNameW, WM_CLOSE, WM_NCDESTROY,
    };

    /// Any id, as long as it is ours: the pair (proc, id) names the subclass.
    const SUBCLASS_ID: usize = 0x7472_6f76; // "trov"

    struct Walk<'a> {
        identifier: &'a str,
        guarded: usize,
    }

    unsafe extern "system" fn swallow_close(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match msg {
            WM_CLOSE => {
                log::warn!("a helper window was sent WM_CLOSE — ignored, it keeps the app working");
                0
            }
            WM_NCDESTROY => {
                RemoveWindowSubclass(hwnd, Some(swallow_close), SUBCLASS_ID);
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
            _ => DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }

    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> i32 {
        let walk = &mut *(lparam as *mut Walk);
        let mut buf = [0u16; 256];
        let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if n > 0 {
            let class = String::from_utf16_lossy(&buf[..n as usize]);
            if is_guarded_class(&class, walk.identifier)
                && SetWindowSubclass(hwnd, Some(swallow_close), SUBCLASS_ID, 0) != 0
            {
                walk.guarded += 1;
            }
        }
        1 // keep walking
    }

    let mut walk = Walk {
        identifier,
        guarded: 0,
    };
    // SAFETY: `walk` outlives the synchronous enumeration; `each` only reads the class name and
    // subclasses windows of this thread.
    unsafe {
        EnumThreadWindows(
            GetCurrentThreadId(),
            Some(each),
            &mut walk as *mut Walk as LPARAM,
        );
    }
    log::info!("helper windows: {} guarded against WM_CLOSE", walk.guarded);
    walk.guarded
}

/// `guard_this_thread`, run on the main thread from wherever the caller is.
pub fn guard_on_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(windows)]
    {
        let identifier = app.config().identifier.clone();
        if let Err(e) = app.run_on_main_thread(move || {
            guard_this_thread(&identifier);
        }) {
            log::warn!("helper windows: could not reach the main thread: {e}");
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::is_guarded_class;

    const ID: &str = "com.joyahmed.trove";

    #[test]
    fn the_four_helper_windows_are_guarded() {
        assert!(is_guarded_class("Tao Thread Event Target", ID));
        assert!(is_guarded_class("global_hotkey_app", ID));
        assert!(is_guarded_class("tray_icon_app", ID));
        assert!(is_guarded_class("com.joyahmed.trove-sic", ID));
        // the plugin's `semver` feature puts the version between the two
        assert!(is_guarded_class("com.joyahmed.trove_1.2-sic", ID));
        // the screen build's own identifier
        assert!(is_guarded_class(
            "com.joyahmed.trove.screen-sic",
            "com.joyahmed.trove.screen"
        ));
    }

    #[test]
    fn windows_a_person_closes_are_not_guarded() {
        // tao's ordinary windows (main, main-2, palette) and anything else stay closable
        assert!(!is_guarded_class("Window Class", ID));
        assert!(!is_guarded_class("Chrome_WidgetWin_0", ID));
        // the single-instance WINDOW name is `-siw`; only its class is matched
        assert!(!is_guarded_class("com.joyahmed.trove-siw", ID));
        // another app's single-instance helper
        assert!(!is_guarded_class("com.other.app-sic", ID));
        assert!(!is_guarded_class("", ID));
    }

    /// The real subclass on a real (invisible, never shown) window of this test's own thread:
    /// a helper-class window survives `WM_CLOSE`, an ordinary one is destroyed by it as before.
    #[cfg(windows)]
    #[test]
    fn a_guarded_helper_survives_wm_close_and_an_ordinary_window_does_not() {
        use super::guard_this_thread;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, IsWindow, RegisterClassW, SendMessageW,
            WM_CLOSE, WNDCLASSW, WS_OVERLAPPED,
        };
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let make = |class: &str| unsafe {
            let name = wide(class);
            let wc = WNDCLASSW {
                lpfnWndProc: Some(DefWindowProcW),
                lpszClassName: name.as_ptr(),
                ..std::mem::zeroed()
            };
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(
                0,
                name.as_ptr(),
                std::ptr::null(),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null(), "test window for {class} was not created");
            hwnd
        };
        let helper = make("global_hotkey_app");
        let ordinary = make("trove_test_ordinary_window");
        assert!(guard_this_thread(ID) >= 1);
        unsafe {
            SendMessageW(helper, WM_CLOSE, 0, 0);
            SendMessageW(ordinary, WM_CLOSE, 0, 0);
            assert_ne!(
                IsWindow(helper),
                0,
                "the guarded helper was destroyed by WM_CLOSE"
            );
            assert_eq!(
                IsWindow(ordinary),
                0,
                "an unguarded window must still close"
            );
            // its owner's own teardown is untouched
            DestroyWindow(helper);
            assert_eq!(IsWindow(helper), 0);
        }
    }
}

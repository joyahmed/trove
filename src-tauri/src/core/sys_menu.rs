//! Alt+Space on an explorer window: Windows' own window menu, opened from OUR loop iteration,
//! never from inside the browser process's call.
//!
//! The hang (seen twice on the screen 2026-10-21):
//! Trove not holding Alt+Space, focus in the page, Alt+Space opens the window menu, Esc closes
//! it, and the page never answers again — CDP times out on `/json`, Close is ignored,
//! `IsHungAppWindow` is false, the process has to be killed.
//!
//! Why (reasoned from sources, not traced on the screen — `VISUAL: NOT OBSERVED`):
//!
//! 1. The keystroke lands in WebView2's child window, which belongs to the BROWSER process. Its
//!    `DefWindowProc` for `WM_SYSCHAR ' '` on a child window is a synchronous
//!    `SendMessage(GetAncestor(hwnd, GA_ROOT), WM_SYSCHAR, ' ', …)` to our top-level window
//!    (Wine `dlls/user32/defwnd.c`, the `VK_SPACE && WS_CHILD` branch, which mirrors Windows).
//!    In windowed hosting the browser process is blocked until that call returns (WebView2
//!    docs, `CoreWebView2CompositionController`: "in windowed mode the input event is
//!    synchronous … the browser process is blocked").
//! 2. tao passes `WM_SYSCHAR` to `DefWindowProc`
//!    (`tao-0.35.3/src/platform_impl/windows/event_loop.rs:2232`), which sends
//!    `WM_SYSCOMMAND SC_KEYMENU ' '`, which tao also passes to `DefWindowProc` (`:1255`) — and
//!    THAT runs the menu's modal loop. So the whole menu runs on our thread, nested inside the
//!    browser's cross-process `SendMessage`, with the browser's UI thread frozen the whole time.
//! 3. When Esc ends the menu, Windows restores focus. Our top-level window gets `WM_SETFOCUS`,
//!    and wry answers it with `ICoreWebView2Controller::MoveFocus`
//!    (`wry-0.55.1/src/webview2/mod.rs:1254-1256`) — a call that needs the browser's UI thread,
//!    which is still blocked in step 1 waiting for us to return. Each side waits for the other.
//!    Our thread keeps pumping while it waits (hence `IsHungAppWindow == false`), but every
//!    later request into the webview (Close, the page's IPC, CDP) queues behind the same wait.
//!
//! The fix keeps the menu and moves it out of the browser's call: `WM_SYSCHAR ' '` is answered
//! at once (the browser's `SendMessage` returns, its UI thread runs again) and the very same
//! `WM_SYSCOMMAND SC_KEYMENU ' '` that `DefWindowProc` would have sent is POSTED to the window
//! instead. The next loop iteration hands it to `DefWindowProc` as before: same menu, same
//! place, same keys — only now the browser is free to answer `MoveFocus` when the menu closes.
//!
//! ⭐ Coexists with `key_menu.rs` (branch `fix/record-alt-space`): that one swallows BOTH
//! `WM_SYSCHAR ' '` and `WM_SYSCOMMAND SC_KEYMENU ' '` while a recorder listens, so a re-posted
//! `SC_KEYMENU` is still caught there if it reaches the window during recording.

/// `WM_SYSCHAR`, `WM_SYSCOMMAND` and `SC_KEYMENU`, spelled out so the pure decision builds and
/// is tested on every OS (the `windows-sys` constants exist only on Windows).
#[cfg_attr(not(windows), allow(dead_code))]
const WM_SYSCHAR: u32 = 0x0106;
#[cfg_attr(not(windows), allow(dead_code))]
const WM_SYSCOMMAND: u32 = 0x0112;
#[cfg_attr(not(windows), allow(dead_code))]
const SC_KEYMENU: usize = 0xF100;
/// The character Alt+Space carries: a plain space.
#[cfg_attr(not(windows), allow(dead_code))]
const SPACE: usize = 0x20;

/// Whether a window message is the Alt+Space `WM_SYSCHAR` that must be answered now and
/// re-posted, rather than handed to `DefWindowProc` inside the caller's `SendMessage`.
///
/// Only `WM_SYSCHAR ' '`: Alt+letter (`WM_SYSCHAR` with another character) and every
/// `WM_SYSCOMMAND` — including the one this module posts — pass through untouched.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn defers(msg: u32, wparam: usize) -> bool {
    msg == WM_SYSCHAR && wparam == SPACE
}

/// `WM_EXITMENULOOP`, spelled out for the same reason as the constants above.
#[cfg_attr(not(windows), allow(dead_code))]
const WM_EXITMENULOOP: u32 = 0x0212;

/// Whether a window message is the end of the WINDOW menu's modal loop (`wParam` FALSE: a
/// `TrackPopupMenu` loop sends TRUE), after which the webview must be handed the keyboard again.
///
/// The second bug (screen, 2026-10-21): Alt+Space, Esc, and the page gets no keys until it is
/// clicked once, though the Trove window stays foreground. When the menu loop ends Windows puts
/// focus back on our top-level window, not on WebView2's child window, so keys go nowhere the
/// page can see. The fix asks the webview for focus again — but only once the menu loop has
/// fully returned (a message POSTED here, handled on a later loop iteration): a focus call made
/// from inside the loop is the shape of the first hang.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn refocuses_after(msg: u32, wparam: usize) -> bool {
    msg == WM_EXITMENULOOP && wparam == 0
}

/// `WM_UNINITMENUPOPUP` and the `MF_SYSMENU` flag its `lParam` high word carries for the window
/// menu.
#[cfg_attr(not(windows), allow(dead_code))]
const WM_UNINITMENUPOPUP: u32 = 0x0125;
#[cfg_attr(not(windows), allow(dead_code))]
const MF_SYSMENU: isize = 0x2000;

/// Whether a window message is the window menu's popup closing, at which point the whole menu
/// mode must end too.
///
/// Measured on the screen (2026-10-21, `GetGUIThreadInfo`): after Alt+Space and Esc the popup
/// is gone but the thread is still in menu mode (`GUI_INMENUMODE | GUI_SYSTEMMENUMODE`) —
/// Windows drops back to "menu bar" level, the window menu's own item highlighted. Every key
/// then belongs to the menu loop: ArrowDown reopens the window menu, the page sees nothing,
/// and only a click or a second Esc ends it. Trove has no menu bar to move along, so the popup
/// closing is always the end: `EndMenu` (a flag and a posted message, no webview call) ends it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn ends_menu_after(msg: u32, lparam: isize) -> bool {
    msg == WM_UNINITMENUPOPUP && (lparam >> 16) & 0xFFFF == MF_SYSMENU
}

/// The message posted in its place: exactly what `DefWindowProc` would have SENT for it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn reposted() -> (u32, usize, isize) {
    (WM_SYSCOMMAND, SC_KEYMENU, SPACE as isize)
}

/// Subclass an explorer window so Alt+Space opens the window menu from our own loop iteration.
/// Idempotent (same proc, same id), and run on the main thread whoever calls it.
#[cfg(windows)]
pub fn guard<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let label = window.label().to_string();
    // `window.hwnd()` is the `windows` crate's HWND, of another major than ours: take the pointer.
    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as isize,
        Err(e) => {
            log::warn!("sys menu: no HWND for {label} — Alt+Space not guarded: {e}");
            return;
        }
    };
    let webview = window.clone();
    if let Err(e) = window.run_on_main_thread(move || {
        // Handed to the subclass as its data and freed on WM_NCDESTROY: gives the keyboard back
        // to the page. `Webview::set_focus` lands in wry's `MoveFocus`.
        let refocus: Refocus = Box::new(move || {
            let page: &tauri::Webview<R> = webview.as_ref();
            if let Err(e) = page.set_focus() {
                log::warn!("sys menu: could not refocus the page after the window menu: {e}");
            }
        });
        // SAFETY: `hwnd` is a live top-level window of this (the main) thread.
        if unsafe { subclass_with(hwnd as _, refocus) } {
            log::debug!("sys menu: Alt+Space guarded on {label}");
        } else {
            log::warn!("sys menu: SetWindowSubclass refused {label}");
        }
    }) {
        log::warn!("sys menu: could not reach the main thread: {e}");
    }
}

/// The non-Windows twin: the window menu is a Windows thing.
#[cfg(not(windows))]
pub fn guard<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

/// What the subclass runs once the window menu has closed.
#[cfg(windows)]
type Refocus = Box<dyn Fn()>;

/// Our private "the menu loop has ended, refocus the page now" message, registered once so it
/// cannot collide with tao's or wry's own.
#[cfg(windows)]
fn refocus_msg() -> u32 {
    use std::sync::OnceLock;
    use windows_sys::Win32::UI::WindowsAndMessaging::RegisterWindowMessageW;
    static MSG: OnceLock<u32> = OnceLock::new();
    *MSG.get_or_init(|| {
        let name: Vec<u16> = "trove.sys_menu.refocus"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the call.
        unsafe { RegisterWindowMessageW(name.as_ptr()) }
    })
}

// The windows `subclass_with` has installed on (main thread only, like the windows themselves).
#[cfg(windows)]
thread_local! {
    static GUARDED: std::cell::RefCell<std::collections::HashSet<isize>> =
        std::cell::RefCell::new(std::collections::HashSet::new());
}

/// Our private "the window menu popup has closed, end menu mode now" message.
#[cfg(windows)]
fn end_menu_msg() -> u32 {
    use std::sync::OnceLock;
    use windows_sys::Win32::UI::WindowsAndMessaging::RegisterWindowMessageW;
    static MSG: OnceLock<u32> = OnceLock::new();
    *MSG.get_or_init(|| {
        let name: Vec<u16> = "trove.sys_menu.end".encode_utf16().chain(Some(0)).collect();
        // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the call.
        unsafe { RegisterWindowMessageW(name.as_ptr()) }
    })
}

/// Any id, as long as it is ours and not another module's: "smnu".
#[cfg(windows)]
const SUBCLASS_ID: usize = 0x736d_6e75;

#[cfg(windows)]
unsafe extern "system" fn proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    _id: usize,
    data: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_NCDESTROY};

    if msg == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(proc), SUBCLASS_ID);
        GUARDED.with(|g| g.borrow_mut().remove(&(hwnd as isize)));
        if data != 0 {
            // SAFETY: `data` is the `Box<Refocus>` leaked in `subclass_with`, freed only here.
            drop(Box::from_raw(data as *mut Refocus));
        }
        return DefSubclassProc(hwnd, msg, wparam, lparam);
    }
    if ends_menu_after(msg, lparam) {
        // `EndMenu` right here is not enough (screen: still in menu mode, and the next key was
        // eaten ending it) — the popup it would cancel is already going away, and the loop
        // then sleeps waiting for input. Post instead: the menu loop dispatches our message on
        // its next turn, `EndMenu` runs while the bar-level loop is the active one, and the
        // loop sees it before it waits for a key.
        PostMessageW(hwnd, end_menu_msg(), 0, 0);
        return DefSubclassProc(hwnd, msg, wparam, lparam);
    }
    if msg == end_menu_msg() {
        windows_sys::Win32::UI::WindowsAndMessaging::EndMenu();
        return 0;
    }
    if refocuses_after(msg, wparam) {
        // Do NOT focus here: the menu loop is still on the stack. Post, and let the next loop
        // iteration do it once the loop has fully returned.
        PostMessageW(hwnd, refocus_msg(), 0, 0);
        return DefSubclassProc(hwnd, msg, wparam, lparam);
    }
    if msg == refocus_msg() {
        if data != 0 {
            // SAFETY: as above; the box lives until WM_NCDESTROY on this same thread.
            (*(data as *const Refocus))();
        }
        return 0;
    }
    if defers(msg, wparam) {
        let (m, w, l) = reposted();
        if PostMessageW(hwnd, m, w, l) == 0 {
            // the queue refused: fall back to the old path rather than lose the menu
            log::warn!("sys menu: PostMessageW failed — opening the window menu inline");
            return DefSubclassProc(hwnd, msg, wparam, lparam);
        }
        return 0;
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// Install `proc` on `hwnd` with no refocus action. Must run on the window's own thread.
#[cfg(all(windows, test))]
unsafe fn subclass(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::UI::Shell::SetWindowSubclass;
    SetWindowSubclass(hwnd, Some(proc), SUBCLASS_ID, 0) != 0
}

/// Install `proc` on `hwnd`, carrying `refocus`. Must run on the window's own (the main)
/// thread. A window already subclassed keeps its first install (and its data): `guard` runs
/// more than once per window, and a second install would leak the first box.
#[cfg(windows)]
unsafe fn subclass_with(hwnd: windows_sys::Win32::Foundation::HWND, refocus: Refocus) -> bool {
    use windows_sys::Win32::UI::Shell::SetWindowSubclass;
    // `GetWindowSubclass` is exported by ordinal only from comctl32 v5 (the test binary has no
    // v6 manifest), so the "already installed" set is kept here instead.
    if GUARDED.with(|g| g.borrow().contains(&(hwnd as isize))) {
        return true;
    }
    let data = Box::into_raw(Box::new(refocus)) as usize;
    if SetWindowSubclass(hwnd, Some(proc), SUBCLASS_ID, data) != 0 {
        GUARDED.with(|g| g.borrow_mut().insert(hwnd as isize));
        true
    } else {
        drop(Box::from_raw(data as *mut Refocus));
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{
        defers, ends_menu_after, refocuses_after, reposted, MF_SYSMENU, SC_KEYMENU, SPACE,
        WM_EXITMENULOOP, WM_SYSCHAR, WM_SYSCOMMAND, WM_UNINITMENUPOPUP,
    };

    #[test]
    fn only_the_window_menu_popup_closing_ends_menu_mode() {
        assert!(ends_menu_after(WM_UNINITMENUPOPUP, MF_SYSMENU << 16));
        // another popup closing (a context menu, a submenu): not ours to end
        assert!(!ends_menu_after(WM_UNINITMENUPOPUP, 0));
        // the low word is not the flag
        assert!(!ends_menu_after(WM_UNINITMENUPOPUP, MF_SYSMENU));
        assert!(!ends_menu_after(WM_EXITMENULOOP, MF_SYSMENU << 16));
    }

    #[test]
    fn only_the_window_menu_loop_end_refocuses_the_page() {
        // the window menu (Alt+Space, or a click on the title icon): wParam FALSE
        assert!(refocuses_after(WM_EXITMENULOOP, 0));
        // a TrackPopupMenu context menu: wParam TRUE, its own focus handling, untouched
        assert!(!refocuses_after(WM_EXITMENULOOP, 1));
        // the opening keystroke and command are not the end of the loop
        assert!(!refocuses_after(WM_SYSCHAR, SPACE));
        assert!(!refocuses_after(WM_SYSCOMMAND, SC_KEYMENU));
        // WM_ENTERMENULOOP
        assert!(!refocuses_after(0x0211, 0));
    }

    #[test]
    fn only_the_alt_space_syschar_is_deferred() {
        assert!(defers(WM_SYSCHAR, SPACE));
        // Alt+F and friends: the menu bar's business, untouched
        assert!(!defers(WM_SYSCHAR, b'f' as usize));
        // the posted command must never be deferred again, or it would loop forever
        assert!(!defers(WM_SYSCOMMAND, SC_KEYMENU));
        // a plain space (WM_CHAR) is the page's
        assert!(!defers(0x0102, SPACE));
    }

    #[test]
    fn the_repost_is_what_defwindowproc_would_have_sent() {
        assert_eq!(reposted(), (WM_SYSCOMMAND, SC_KEYMENU, SPACE as isize));
    }

    /// The real subclass on a real (invisible, never shown) window of this test's own thread:
    /// a sent `WM_SYSCHAR ' '` is answered with 0 and the window menu command is found POSTED
    /// in the queue, not run inline. The posted message is removed before anything can dispatch
    /// it, so no menu ever opens on the test machine.
    #[cfg(windows)]
    #[test]
    fn alt_space_is_reposted_as_a_queued_sc_keymenu() {
        use super::subclass;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, PeekMessageW, RegisterClassW,
            SendMessageW, MSG, PM_REMOVE, WNDCLASSW, WS_OVERLAPPED,
        };
        let name: Vec<u16> = "trove_test_sys_menu_window"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
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
            assert!(!hwnd.is_null(), "test window was not created");
            assert!(subclass(hwnd));

            // drain whatever creation queued, so the assertion below is about our message only
            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, hwnd, 0, 0, PM_REMOVE) != 0 {}

            let answered = SendMessageW(hwnd, WM_SYSCHAR, SPACE, 0);
            assert_eq!(answered, 0, "WM_SYSCHAR ' ' must be answered at once");

            let found = PeekMessageW(&mut msg, hwnd, WM_SYSCOMMAND, WM_SYSCOMMAND, PM_REMOVE);
            assert_ne!(found, 0, "the window menu command was not posted");
            assert_eq!(msg.wParam & 0xFFF0, SC_KEYMENU);
            assert_eq!(msg.lParam, SPACE as isize);

            // an Alt+letter still goes down the chain untouched: nothing new is queued
            SendMessageW(hwnd, WM_SYSCHAR, b'f' as usize, 0);
            assert_eq!(
                PeekMessageW(&mut msg, hwnd, WM_SYSCOMMAND, WM_SYSCOMMAND, PM_REMOVE),
                0,
                "Alt+F must not be turned into a window menu"
            );
            DestroyWindow(hwnd);
        }
    }

    /// The real subclass again: the end of the window menu loop does NOT refocus inline — it
    /// posts our private message — and only dispatching that message runs the refocus action.
    #[cfg(windows)]
    #[test]
    fn menu_loop_end_refocuses_only_from_the_queue() {
        use super::{refocus_msg, subclass_with};
        use std::{cell::Cell, rc::Rc};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
            RegisterClassW, SendMessageW, MSG, PM_REMOVE, WNDCLASSW, WS_OVERLAPPED,
        };
        let name: Vec<u16> = "trove_test_sys_menu_refocus"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let ran = Rc::new(Cell::new(0u32));
        let seen = ran.clone();
        unsafe {
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
            assert!(!hwnd.is_null(), "test window was not created");
            assert!(subclass_with(
                hwnd,
                Box::new(move || seen.set(seen.get() + 1))
            ));
            // a second guard on the same window keeps the first install
            assert!(subclass_with(
                hwnd,
                Box::new(|| panic!("second install ran"))
            ));

            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, hwnd, 0, 0, PM_REMOVE) != 0 {}

            SendMessageW(hwnd, WM_EXITMENULOOP, 0, 0);
            assert_eq!(ran.get(), 0, "refocus must not run inside the menu loop");
            let found = PeekMessageW(&mut msg, hwnd, refocus_msg(), refocus_msg(), PM_REMOVE);
            assert_ne!(found, 0, "the refocus message was not posted");
            DispatchMessageW(&msg);
            assert_eq!(
                ran.get(),
                1,
                "dispatching the posted message refocuses once"
            );

            // a popup menu's loop end posts nothing
            SendMessageW(hwnd, WM_EXITMENULOOP, 1, 0);
            assert_eq!(
                PeekMessageW(&mut msg, hwnd, refocus_msg(), refocus_msg(), PM_REMOVE),
                0
            );
            DestroyWindow(hwnd);
        }
    }
}

//! Alt+Space while a shortcut is being recorded: the recorder gets it, the window menu does not.
//!
//! Bug A.8.9, seen on the screen 2026-10-20 with real keys: Settings ▸ Spotlight shortcut, record
//! Ctrl+Shift+J (fine), then record Alt+Space to go back — and Windows' own window menu
//! (Restore / Move / Size / … / Close) opened on the Trove window instead, and the page stopped
//! answering until a restart (the menu's modal loop).
//!
//! Why: once Ctrl+Shift+J is saved, `register_hotkey` releases Alt+Space
//! (`commands/spotlight.rs`, the `shortcuts.unregister(old)` line), so Alt+Space is an ordinary
//! key again. Windows turns it into `WM_SYSCHAR ' '`; a child window's `DefWindowProc` hands that
//! up to its parent, tao's top-level proc passes it to `DefWindowProc` too
//! (`tao-0.35.3/src/platform_impl/windows/event_loop.rs`, the `WM_SYSCHAR` arm), which sends
//! `WM_SYSCOMMAND SC_KEYMENU` with `lParam = ' '` — and that opens the window menu. A
//! `preventDefault` in the page cannot stop it: the menu is the window's, not the page's.
//!
//! So while a recorder is listening, each explorer window swallows exactly that (`swallows`),
//! and the chord is handed to the recorder as the `hotkey-recorder:chord` event instead — not
//! left to the page's keydown, which the menu's modal loop is what starved on the screen.
//! Outside recording nothing changes: Alt+Space opens the window menu, or Spotlight while
//! Trove holds it as its chord.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The event a recorder listens for while it records (payload: the canonical chord).
/// ⚠️ `src/lib/api/palette.ts` spells it too.
pub const RECORDED_EVENT: &str = "hotkey-recorder:chord";

/// `WM_SYSCOMMAND`, `WM_SYSCHAR` and `SC_KEYMENU`, spelled out so the pure decision builds and
/// is tested on every OS (they are `windows-sys` constants, which exist only on Windows).
#[cfg_attr(not(windows), allow(dead_code))]
const WM_SYSCOMMAND: u32 = 0x0112;
#[cfg_attr(not(windows), allow(dead_code))]
const WM_SYSCHAR: u32 = 0x0106;
#[cfg_attr(not(windows), allow(dead_code))]
const SC_KEYMENU: usize = 0xF100;
/// The character Alt+Space carries: a plain space.
#[cfg_attr(not(windows), allow(dead_code))]
const SPACE: usize = 0x20;

/// How long after the recorder stops the window menu is still held back. The page may record
/// the keydown and stop before Windows has finished with the same press, and that press must
/// not then open the menu after all.
const AFTER_STOP: Duration = Duration::from_millis(500);
/// The longest a recording counts as live without a stop. A recorder torn down mid-recording
/// (Settings closed, the window reloaded) never says stop; Alt+Space must not stay dead.
const MAX_RECORDING: Duration = Duration::from_secs(60);

#[derive(Clone, Copy)]
enum Recording {
    Idle,
    Since(Instant),
    StoppedAt(Instant),
}

static STATE: Mutex<Recording> = Mutex::new(Recording::Idle);

/// The recorder started (`true`) or stopped (`false`).
pub fn set_recording(on: bool) {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    *state = if on {
        Recording::Since(Instant::now())
    } else {
        match *state {
            Recording::Since(_) => Recording::StoppedAt(Instant::now()),
            other => other,
        }
    };
}

/// Whether a recorder is listening now (or stopped a moment ago, see `AFTER_STOP`).
pub fn recording() -> bool {
    let state = *STATE.lock().unwrap_or_else(|e| e.into_inner());
    live(state, Instant::now())
}

fn live(state: Recording, now: Instant) -> bool {
    match state {
        Recording::Idle => false,
        Recording::Since(t) => now.saturating_duration_since(t) < MAX_RECORDING,
        Recording::StoppedAt(t) => now.saturating_duration_since(t) < AFTER_STOP,
    }
}

/// Whether a window message is the Alt+Space that opens the window menu and must be swallowed.
///
/// Only while recording, and only the space: Alt+F and friends (`SC_KEYMENU` with another
/// letter) and every other `WM_SYSCOMMAND` (move, size, close…) pass as before. `WM_SYSCHAR ' '`
/// is matched too because it is the message `SC_KEYMENU ' '` is made from; one press is caught
/// by whichever of the two reaches the top-level window first, never both.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn swallows(recording: bool, msg: u32, wparam: usize, lparam: isize) -> bool {
    if !recording {
        return false;
    }
    match msg {
        // the low four bits of a WM_SYSCOMMAND wParam are Windows' own
        WM_SYSCOMMAND => wparam & 0xFFF0 == SC_KEYMENU && lparam as usize == SPACE,
        WM_SYSCHAR => wparam == SPACE,
        _ => false,
    }
}

/// The chord to record for a swallowed press, in `recordChord`'s order (`utils/hotkeys.ts`).
/// Alt is down by definition — that is what made it a SYS key.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn menu_chord(ctrl: bool, shift: bool, win: bool) -> String {
    let mut parts = Vec::with_capacity(5);
    if ctrl {
        parts.push("ctrl");
    }
    parts.push("alt");
    if shift {
        parts.push("shift");
    }
    if win {
        parts.push("super");
    }
    parts.push("space");
    parts.join("+")
}

/// Where a swallowed chord goes: an emit of `RECORDED_EVENT`, set by the first `guard`.
#[cfg_attr(not(windows), allow(dead_code))]
static SINK: std::sync::OnceLock<Box<dyn Fn(String) + Send + Sync>> = std::sync::OnceLock::new();

/// Subclass an explorer window so Alt+Space is swallowed while a recorder is listening.
/// Idempotent (same proc, same id), and run on the main thread whoever calls it.
#[cfg(windows)]
pub fn guard<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use tauri::{Emitter, Manager};

    let app = window.app_handle().clone();
    SINK.get_or_init(|| {
        Box::new(move |chord: String| {
            // off the window procedure: the emit evaluates script in every webview
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = app.emit(RECORDED_EVENT, chord);
            });
        })
    });

    let label = window.label().to_string();
    // `window.hwnd()` is the `windows` crate's HWND, of another major than ours: take the pointer.
    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as isize,
        Err(e) => {
            log::warn!("key menu: no HWND for {label} — Alt+Space not guarded: {e}");
            return;
        }
    };
    if let Err(e) = window.run_on_main_thread(move || {
        // SAFETY: `hwnd` is a live top-level window of this (the main) thread.
        if unsafe { subclass(hwnd as _) } {
            log::debug!("key menu: Alt+Space guarded on {label}");
        } else {
            log::warn!("key menu: SetWindowSubclass refused {label}");
        }
    }) {
        log::warn!("key menu: could not reach the main thread: {e}");
    }
}

#[cfg(windows)]
unsafe fn subclass(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, VK_CONTROL, VK_LWIN, VK_RWIN, VK_SHIFT,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::WM_NCDESTROY;

    /// Ours, and different from `helper_windows`' id ("trov"): "keym".
    const SUBCLASS_ID: usize = 0x6b65_796d;

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
        if swallows(recording(), msg, wparam, lparam) {
            let down = |vk: u16| GetKeyState(i32::from(vk)) < 0;
            let chord = menu_chord(
                down(VK_CONTROL),
                down(VK_SHIFT),
                down(VK_LWIN) || down(VK_RWIN),
            );
            log::info!("key menu: {chord} taken for the shortcut recorder, window menu not opened");
            if let Some(sink) = SINK.get() {
                sink(chord);
            }
            return 0;
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    SetWindowSubclass(hwnd, Some(proc), SUBCLASS_ID, 0) != 0
}

/// The non-Windows twin: no window menu on Alt+Space to hold back.
#[cfg(not(windows))]
pub fn guard<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

#[cfg(test)]
mod tests {
    use super::*;

    const KEYMENU_SPACE: (u32, usize, isize) = (WM_SYSCOMMAND, SC_KEYMENU, 0x20);

    #[test]
    fn alt_space_is_swallowed_only_while_recording() {
        let (m, w, l) = KEYMENU_SPACE;
        assert!(swallows(true, m, w, l));
        assert!(
            !swallows(false, m, w, l),
            "not recording: the window menu opens as always"
        );
        assert!(swallows(true, WM_SYSCHAR, 0x20, 0));
        assert!(!swallows(false, WM_SYSCHAR, 0x20, 0));
    }

    #[test]
    fn the_low_bits_of_sc_keymenu_do_not_matter() {
        assert!(swallows(true, WM_SYSCOMMAND, SC_KEYMENU | 0x3, 0x20));
    }

    #[test]
    fn everything_else_passes_even_while_recording() {
        // Alt+F: the keyboard menu for a letter, not the window menu
        assert!(!swallows(true, WM_SYSCOMMAND, SC_KEYMENU, 'f' as isize));
        // F10 / plain Alt: SC_KEYMENU with lParam 0
        assert!(!swallows(true, WM_SYSCOMMAND, SC_KEYMENU, 0));
        // SC_CLOSE (Alt+F4), SC_MOVE, SC_MAXIMIZE with a space-looking lParam
        for sc in [0xF060usize, 0xF010, 0xF030] {
            assert!(!swallows(true, WM_SYSCOMMAND, sc, 0x20));
        }
        assert!(!swallows(true, WM_SYSCHAR, 'j' as usize, 0));
        // WM_SYSKEYDOWN VK_SPACE itself still goes on to the page
        assert!(!swallows(true, 0x0104, 0x20, 0));
        assert!(!swallows(true, 0x0100, 0x20, 0));
    }

    #[test]
    fn the_chord_is_spelled_as_the_recorder_spells_it() {
        assert_eq!(menu_chord(false, false, false), "alt+space");
        assert_eq!(menu_chord(false, true, false), "alt+shift+space");
        assert_eq!(menu_chord(true, true, true), "ctrl+alt+shift+super+space");
    }

    #[test]
    fn a_recording_lives_until_stop_plus_a_moment_and_never_forever() {
        let t = Instant::now();
        assert!(!live(Recording::Idle, t));
        assert!(live(Recording::Since(t), t + Duration::from_secs(5)));
        assert!(!live(Recording::Since(t), t + MAX_RECORDING));
        assert!(live(
            Recording::StoppedAt(t),
            t + Duration::from_millis(100)
        ));
        assert!(!live(Recording::StoppedAt(t), t + AFTER_STOP));
    }
}

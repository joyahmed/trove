//! The copy and move keys held right now, read from the OS. A drop from another app reaches
//! Trove through Tauri's drag-drop event, which carries no modifiers, and the window has no
//! focus (so no key events) while another app's drag is over it. The frontend decides with
//! these the way it decides an in-app drop (`effectFor` in src/lib/state/drag.svelte.ts).

use serde::Serialize;

/// `ctrl` is the copy key (Option on a Mac, as the in-app drag maps it), `shift` the move key.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Held {
    pub ctrl: bool,
    pub shift: bool,
}

/// `GetAsyncKeyState` sets the high bit while the key is down; the low bit means "pressed
/// since the last call" and says nothing about now.
#[cfg_attr(not(windows), allow(dead_code))] // the Windows path's; unit-tested on every OS
pub fn down_from_async(state: i16) -> bool {
    state < 0
}

const NS_SHIFT: usize = 1 << 17;
const NS_OPTION: usize = 1 << 19;

/// `NSEvent.modifierFlags`: Option is the copy key on a Mac (Finder's), Shift the move key.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the AppKit path's; unit-tested on every OS
pub fn held_from_ns(flags: usize) -> Held {
    Held {
        ctrl: flags & NS_OPTION != 0,
        shift: flags & NS_SHIFT != 0,
    }
}

#[cfg(windows)]
pub fn held() -> Held {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_SHIFT};
    // SAFETY: takes a virtual-key code and returns a state word; no pointers involved.
    let (ctrl, shift) = unsafe {
        (
            GetAsyncKeyState(VK_CONTROL as i32),
            GetAsyncKeyState(VK_SHIFT as i32),
        )
    };
    Held {
        ctrl: down_from_async(ctrl),
        shift: down_from_async(shift),
    }
}

#[cfg(target_os = "macos")]
pub fn held() -> Held {
    use objc2::{class, msg_send};
    // SAFETY: the documented class getter, callable from any thread, taking nothing.
    let flags: usize = unsafe { msg_send![class!(NSEvent), modifierFlags] };
    held_from_ns(flags)
}

/// No portable live read on Linux (X11 and Wayland differ): no keys, so the drive decides.
#[cfg(not(any(windows, target_os = "macos")))]
pub fn held() -> Held {
    Held::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_high_bit_means_down_now() {
        assert!(down_from_async(i16::MIN)); // 0x8000
        assert!(down_from_async(i16::MIN | 1)); // down, and pressed since the last call
        assert!(!down_from_async(1)); // pressed earlier, up now
        assert!(!down_from_async(0));
    }

    #[test]
    fn option_is_the_copy_key_and_shift_the_move_key_on_a_mac() {
        assert_eq!(held_from_ns(0), Held::default());
        assert_eq!(
            held_from_ns(NS_OPTION),
            Held {
                ctrl: true,
                shift: false
            }
        );
        assert_eq!(
            held_from_ns(NS_SHIFT),
            Held {
                ctrl: false,
                shift: true
            }
        );
        // Command (1 << 20) and Control (1 << 18) are neither
        assert_eq!(held_from_ns(1 << 20 | 1 << 18), Held::default());
    }
}

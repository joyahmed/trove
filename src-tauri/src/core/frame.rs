//! The 1px border DWM draws around an explorer window, and why we ask it not to.
//!
//! `decorations: false` does not take `WS_THICKFRAME` away — the explorer windows are resizable
//! and must stay so — and DWM answers a thick-framed window by rounding it at ~8px AND stroking
//! a 1px border on that arc. Our own frame is the 14px `--radius-window` arc in `app.css`, so
//! the two do not agree: within ~14px of each corner our content pulls away from DWM's stroke
//! and the desktop shows through the crescent between them.
//!
//! Measured on the real window on 2026-09-25 against a near-black desktop (luma 5–6), going
//! outward from a corner: content **32** (`#202020`) → gap **5–6** (see-through) → stroke **50**.
//! Along the straight edges the stroke sits directly against the content and reads as an
//! ordinary 1px border, which is why only the corners ever looked wrong.
//!
//! `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE` (Windows 11 build 22000+) removes that stroke, and
//! the same corner then measures content 32 → 5–6 all the way out: the CSS arc is the only edge
//! left, and the gap has nothing outside it to be an edge against.
//!
//! ⛔ **`DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_DONOTROUND` is NOT the fix — all three
//! combinations were measured on the real window before this landed.** On its own DWM stops
//! rounding but keeps stroking, so the 50-luma line becomes a SQUARE outline drawn around our
//! rounded content: strictly worse than doing nothing. Paired with `COLOR_NONE` the outline goes,
//! but DWM no longer clips the window's top row either, and a 1px square line of `#202020` walks
//! across the top of the window outside the arc. `DWMWCP_ROUND` (the default) also keeps the
//! see-through crescent as small as it can be, since a bigger DWM arc means less of the corner
//! left unpainted. So the corner preference is deliberately left alone.
//!
//! ⚠️ **What this does not fix.** The gap is still genuinely see-through, and DWM's drop shadow
//! darkens the wallpaper *around* the window but not *inside* the gap — so over a bright
//! wallpaper each corner still carries a 1–3px crescent of undarkened wallpaper. Measured over a
//! luma-186 wallpaper, removing the border moved those pixels by 4–5 luma and nothing more. That
//! crescent is a consequence of a 14px CSS arc sitting inside an 8px DWM arc, not of the border,
//! and no DWM attribute reaches it; only matching `--radius-window` to DWM's ~8px, or dropping
//! the window shadow, would.
//!
//! ⛔ **`palette` does not come through here, on purpose.** It is `resizable: false`, so it never
//! gets `WS_THICKFRAME` (measured style `0x04CB0000` — the `0x00040000` bit is clear), and DWM
//! strokes no border on it: its corners measured clean before any of this. Calling this on it
//! would be a no-op dressed up as a fix.

/// Ask DWM not to stroke its 1px border around `window`, leaving the CSS arc as the only edge.
///
/// Best effort, and deliberately not an error: a window that keeps its border is the window we
/// shipped yesterday, which is a cosmetic wart and not a reason to fail a window build. The
/// attribute needs Windows 11 build 22000+; older builds answer `E_INVALIDARG` and get a warning
/// in the log.
#[cfg(windows)]
pub fn suppress_dwm_border<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
    };

    let label = window.label();
    // `window.hwnd()` hands back the `windows` crate's HWND; this crate pins a different major
    // of that crate than Tauri does, so the pointer is taken out rather than the type reused.
    let hwnd = match window.hwnd() {
        Ok(h) => h.0.cast(),
        Err(e) => {
            log::warn!("frame: no HWND for {label} — DWM border left alone: {e}");
            return;
        }
    };
    let color = DWMWA_COLOR_NONE;
    let size = u32::try_from(std::mem::size_of::<u32>()).unwrap_or(4);
    // SAFETY: `hwnd` is the live handle Tauri just handed us, and `pvattribute` points at a live
    // `u32` of exactly the `cbattribute` DWM is told to read.
    let hr = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            std::ptr::from_ref(&color).cast(),
            size,
        )
    };
    if hr < 0 {
        log::warn!(
            "frame: DWMWA_BORDER_COLOR failed for {label} (hr {hr:#010x}) — needs Windows 11 22000+"
        );
    } else {
        log::debug!("frame: DWM border suppressed for {label}");
    }
}

/// The non-Windows twin: DWM is a Windows compositor, so there is no border to suppress.
///
/// ⭐ Every windows-gated function in this crate has one of these, and that is what keeps
/// `docs/plans/10-cross-platform.md` a behaviour port rather than a rewrite.
#[cfg(not(windows))]
pub fn suppress_dwm_border<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

/// The window's OWN icon: the 256 px gem folder, handed to the window manager.
///
/// ⚠️ Off Windows only. Tauri gives every window the FIRST icon of `bundle.icon`, which is
/// `32x32.png`; Ubuntu's Alt-Tab and dock then draw a soft 32 px picture, or, with no installed
/// launcher entry to match the window to, the generic cog. A real package supplies the launcher
/// entry (plan 10 Phase G, a `.deb`); this is the half that is ours to fix. Seen 2026-10-02 on a
/// real Ubuntu desktop: the window carried a 32 px icon and nothing larger.
///
/// macOS has no per-window icon (the Dock icon comes from the app bundle), so there it is a no-op
/// that costs a decode. Windows takes its icon from the exe's resource, which is why it is gated.
#[cfg(not(windows))]
pub fn set_window_icon<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    const ICON: &[u8] = include_bytes!("../../icons/128x128@2x.png");
    match tauri::image::Image::from_bytes(ICON) {
        Ok(icon) => {
            if let Err(e) = window.set_icon(icon) {
                log::warn!(
                    "frame: could not set the window icon for {}: {e}",
                    window.label()
                );
            }
        }
        Err(e) => log::warn!("frame: the bundled window icon did not decode: {e}"),
    }
}

/// Windows: the icon is the exe's own resource; nothing to set.
#[cfg(windows)]
pub fn set_window_icon<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

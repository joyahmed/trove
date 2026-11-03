//! What the frontend needs from the Windows personalization settings: the accent colour
//! (`HKCU\Software\Microsoft\Windows\DWM\AccentColor`, a DWORD in ABGR order) and whether
//! transparency effects are on (`...\Themes\Personalize\EnableTransparency` — dormant, see the
//! field). Also the text scale from Settings → Accessibility → Text size
//! (`...\Accessibility\TextScaleFactor`, a percent), which seeds the UI zoom on the first run
//! so this app grows with the rest of Windows. On Linux the text scale is GNOME's
//! `text-scaling-factor` (Settings → Accessibility → Large Text): WebKitGTK does not apply it to
//! page content, so without this the app stayed at 100 % while the rest of the desktop grew.

use serde::Serialize;

use crate::core::registry;

const DWM_KEY: &str = "Software\\Microsoft\\Windows\\DWM";
const PERSONALIZE_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
#[cfg(not(target_os = "linux"))]
const ACCESSIBILITY_KEY: &str = "Software\\Microsoft\\Accessibility";

/// Windows 11's default accent, used when the registry has nothing.
pub const DEFAULT_ACCENT: &str = "#2f4bd0";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemTheme {
    /// `#rrggbb`
    pub accent: String,
    /// ⚠️ **Read, reported, and currently acted on by nothing.** It used to decide whether the
    /// frontend painted `--color-mica` on `body` as a stand-in for the OS backdrop; on
    /// 2026-09-25 `windowEffects` was dropped from every window, so the chrome colour became
    /// unconditional (and the body fill had to go — it propagated to the viewport canvas and
    /// cancelled the window's rounded frame). This is the signal for the day a surface asks the
    /// OS for Mica or Acrylic again; nothing else in Windows' personalization tells you whether
    /// such a request would render, and it is one registry DWORD.
    pub transparency: bool,
    /// The desktop's text size as a factor: 1.0 = 100 %, 1.25 = 125 %. Windows: up to 2.25.
    /// Linux: GNOME's `text-scaling-factor`. Elsewhere 1.0.
    pub text_scale: f64,
}

/// `TextScaleFactor` is a percent (100–225); a missing value or one outside that range is 1.0.
#[cfg(not(target_os = "linux"))]
pub fn text_scale_from(percent: Option<u32>) -> f64 {
    match percent {
        Some(p) if (100..=225).contains(&p) => f64::from(p) / 100.0,
        _ => 1.0,
    }
}

/// GNOME's `text-scaling-factor` as `gsettings get` prints it (`1.25`); GNOME allows 0.5–3.0.
/// Anything else, or no value, is 1.0.
#[cfg(target_os = "linux")]
pub fn text_scale_from_gsettings(out: Option<&str>) -> f64 {
    match out.and_then(|s| s.trim().parse::<f64>().ok()) {
        Some(f) if (0.5..=3.0).contains(&f) => f,
        _ => 1.0,
    }
}

/// GNOME's text scale, read with `gsettings get` (a read, nothing is changed). No gsettings,
/// no GNOME schema or a failed read: 1.0.
#[cfg(target_os = "linux")]
fn gnome_text_scale() -> f64 {
    let out = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "text-scaling-factor"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
    text_scale_from_gsettings(out.as_deref())
}

/// `AccentColor` is stored as `0xAABBGGRR`; CSS wants `#RRGGBB`.
pub fn abgr_to_hex(v: u32) -> String {
    let r = v & 0xff;
    let g = (v >> 8) & 0xff;
    let b = (v >> 16) & 0xff;
    format!("#{r:02x}{g:02x}{b:02x}")
}

pub fn system_theme() -> SystemTheme {
    let accent = registry::read_dword(DWM_KEY, "AccentColor")
        .ok()
        .flatten()
        .map(abgr_to_hex)
        .unwrap_or_else(|| DEFAULT_ACCENT.to_string());
    let transparency = registry::read_dword(PERSONALIZE_KEY, "EnableTransparency")
        .ok()
        .flatten()
        .is_none_or(|v| v != 0);
    #[cfg(target_os = "linux")]
    let text_scale = gnome_text_scale();
    #[cfg(not(target_os = "linux"))]
    let text_scale = text_scale_from(
        registry::read_dword(ACCESSIBILITY_KEY, "TextScaleFactor")
            .ok()
            .flatten(),
    );
    SystemTheme {
        accent,
        transparency,
        text_scale,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abgr_becomes_css_rgb() {
        // Windows 11 default blue 0,95,184 → stored as 0xffb85f00
        assert_eq!(abgr_to_hex(0xffb85f00), "#005fb8");
        assert_eq!(abgr_to_hex(0xff0000ff), "#ff0000");
        assert_eq!(abgr_to_hex(0), "#000000");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn gnome_text_scale_is_a_bounded_factor_with_a_fallback() {
        assert_eq!(text_scale_from_gsettings(Some("1.0\n")), 1.0);
        assert_eq!(text_scale_from_gsettings(Some("1.25\n")), 1.25);
        assert_eq!(text_scale_from_gsettings(Some("0.75")), 0.75);
        assert_eq!(text_scale_from_gsettings(Some("3.5")), 1.0);
        assert_eq!(text_scale_from_gsettings(Some("0.2")), 1.0);
        assert_eq!(text_scale_from_gsettings(Some("No such schema")), 1.0);
        assert_eq!(text_scale_from_gsettings(None), 1.0);
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn text_scale_is_a_bounded_factor_with_a_fallback() {
        assert_eq!(text_scale_from(None), 1.0);
        assert_eq!(text_scale_from(Some(100)), 1.0);
        assert_eq!(text_scale_from(Some(125)), 1.25);
        assert_eq!(text_scale_from(Some(225)), 2.25);
        assert_eq!(text_scale_from(Some(50)), 1.0);
        assert_eq!(text_scale_from(Some(400)), 1.0);
    }

    #[test]
    #[cfg(windows)]
    fn the_machine_gives_a_hex_accent() {
        let t = system_theme();
        assert_eq!(t.accent.len(), 7);
        assert!(t.accent.starts_with('#'));
    }
}

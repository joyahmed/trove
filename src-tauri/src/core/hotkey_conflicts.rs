//! Does the desktop itself already use the Spotlight chord? (plan 15 D.5.2)
//!
//! ⛔ **A chord GNOME holds is swallowed, not refused.** Read on Ubuntu GNOME, 2026-10-23: the
//! then-default `alt+space` is GNOME's `activate-window-menu` (`org.gnome.desktop.wm.keybindings`,
//! `['<Alt>space']`). global-hotkey only learns of a clash when another X client's grab makes
//! `XGrabKey` fail; GNOME's own bindings are never asked, so the press can go to GNOME with no
//! error anywhere. The only way to know is to read those bindings and compare. Read only —
//! nothing is changed.
//!
//! Linux's default is `ctrl+alt+space` since 2026-10-23 (Joy's pick); this still warns anyone who
//! kept `alt+space` from an older install, or picks it again.
//!
//! Only GNOME is read (`XDG_CURRENT_DESKTOP` contains `GNOME`); other desktops and other OSes
//! answer "no conflict".

/// The schemas GNOME keeps its shortcuts in. A schema missing on this box is skipped.
#[cfg(target_os = "linux")]
const SCHEMAS: [&str; 4] = [
    "org.gnome.desktop.wm.keybindings",
    "org.gnome.shell.keybindings",
    "org.gnome.mutter.keybindings",
    "org.gnome.settings-daemon.plugins.media-keys",
];

/// Which GNOME setting holds `chord`, as `(schema, key)`, or None. Runs `gsettings` on every
/// call (four quick reads), so clearing the GNOME key takes effect at the next registration.
#[cfg(target_os = "linux")]
pub fn gnome_holder(chord: &str) -> Option<(String, String)> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    if !desktop.split(':').any(|d| d.eq_ignore_ascii_case("gnome")) {
        return None;
    }
    let listing: String = SCHEMAS
        .iter()
        .filter_map(|schema| {
            std::process::Command::new("gsettings")
                .args(["list-recursively", schema])
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        })
        .collect();
    find_holder(&listing, chord)
}

/// Off Linux there is no GNOME to ask.
#[cfg(not(target_os = "linux"))]
pub fn gnome_holder(_chord: &str) -> Option<(String, String)> {
    None
}

/// The first `schema key value` line of a `gsettings list-recursively` listing whose value
/// binds `chord`. Values are `['<Alt>space', …]`, `@as []`, or (older media-keys) one `'…'`.
#[cfg(any(target_os = "linux", test))]
pub fn find_holder(listing: &str, chord: &str) -> Option<(String, String)> {
    let wanted = canonical(chord)?;
    listing.lines().find_map(|line| {
        let mut parts = line.splitn(3, ' ');
        let (schema, key, value) = (parts.next()?, parts.next()?, parts.next()?);
        value
            .split('\'')
            .skip(1)
            .step_by(2)
            .filter_map(accel_to_chord)
            .any(|c| canonical(&c).as_ref() == Some(&wanted))
            .then(|| (schema.to_string(), key.to_string()))
    })
}

/// One GNOME accelerator (`<Primary><Shift>a`) in Trove's chord form (`ctrl+shift+a`), or None
/// for an empty binding or a modifier Trove cannot register (`<Hyper>`, `<Meta>`, …).
#[cfg(any(target_os = "linux", test))]
fn accel_to_chord(accel: &str) -> Option<String> {
    let mut rest = accel.trim();
    let mut parts = Vec::new();
    while let Some(after) = rest.strip_prefix('<') {
        let (modifier, tail) = after.split_once('>')?;
        parts.push(match modifier.to_ascii_lowercase().as_str() {
            "primary" | "control" | "ctrl" => "ctrl",
            "alt" | "mod1" => "alt",
            "shift" => "shift",
            "super" | "mod4" => "super",
            _ => return None,
        });
        rest = tail;
    }
    if rest.is_empty() {
        return None;
    }
    // X keysym names where Trove's (`utils/hotkeys.ts` `keyName`) differ; the rest only lowercase.
    let key = match rest.to_ascii_lowercase().as_str() {
        "return" => "enter".to_string(),
        "grave" => "backquote".to_string(),
        "apostrophe" => "quote".to_string(),
        other => other.to_string(),
    };
    parts.push(&key);
    Some(parts.join("+"))
}

/// A chord as its sorted modifiers plus its key, so `shift+alt+a` and `alt+shift+a` compare
/// equal. Spellings Trove's parser also accepts (`control`, `cmd`, `meta`) are folded in.
#[cfg(any(target_os = "linux", test))]
fn canonical(chord: &str) -> Option<(Vec<&'static str>, String)> {
    let parts: Vec<String> = chord
        .split('+')
        .map(|p| p.trim().to_ascii_lowercase())
        .collect();
    let (key, modifiers) = parts.split_last()?;
    let mut mods = modifiers
        .iter()
        .map(|m| match m.as_str() {
            "ctrl" | "control" => Some("ctrl"),
            "alt" => Some("alt"),
            "shift" => Some("shift"),
            "super" | "cmd" | "meta" => Some("super"),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    mods.sort_unstable();
    mods.dedup();
    (!key.is_empty()).then(|| (mods, key.clone()))
}

#[cfg(test)]
mod tests {
    use super::{accel_to_chord, find_holder};

    /// `gsettings list-recursively` for the four schemas, from Ubuntu GNOME on 2026-10-23,
    /// unchanged (defaults apart from what that box had).
    const UBUNTU: &str = include_str!("fixtures/gnome-keybindings.txt");

    fn holder(listing: &str, chord: &str) -> Option<(String, String)> {
        find_holder(listing, chord)
    }

    #[test]
    fn the_default_chord_is_gnomes_window_menu() {
        assert_eq!(
            holder(UBUNTU, "alt+space"),
            Some((
                "org.gnome.desktop.wm.keybindings".to_string(),
                "activate-window-menu".to_string()
            ))
        );
    }

    /// Why Linux's default moved (Joy's pick 2026-10-23): a stock GNOME leaves it free.
    #[test]
    fn the_linux_default_chord_is_free_in_gnome() {
        let linux = crate::commands::spotlight::default_hotkey_for(true);
        assert_eq!(holder(UBUNTU, linux), None);
    }

    #[test]
    fn modifier_order_and_spelling_do_not_matter() {
        // `<Super><Shift>Home` is move-to-workspace-1 in the fixture.
        assert!(holder(UBUNTU, "shift+super+home").is_some());
        assert!(holder(UBUNTU, "super+shift+home").is_some());
        // `<Ctrl><Shift><Alt>R` (show-screen-recording-ui): GNOME's `<Ctrl>` and an upper-case key.
        assert!(holder(UBUNTU, "alt+ctrl+shift+r").is_some());
        // `<Super><Control>1`.
        assert!(holder(UBUNTU, "control+super+1").is_some());
    }

    #[test]
    fn a_free_chord_and_a_partial_match_are_not_conflicts() {
        assert_eq!(holder(UBUNTU, "ctrl+shift+space"), None);
        // `<Super>a` is taken; Super+Alt+A is not, and neither is plain A held by nothing.
        assert_eq!(holder(UBUNTU, "super+alt+a"), None);
        assert_eq!(holder(UBUNTU, "super"), None);
        assert_eq!(holder(UBUNTU, ""), None);
    }

    #[test]
    fn a_cleared_gnome_key_frees_the_chord() {
        let cleared = UBUNTU.replace(
            "activate-window-menu ['<Alt>space']",
            "activate-window-menu @as []",
        );
        assert_ne!(
            cleared, UBUNTU,
            "fixture no longer has the line this test edits"
        );
        assert_eq!(holder(&cleared, "alt+space"), None);
    }

    #[test]
    fn single_string_values_and_second_entries_are_read() {
        let listing = "org.gnome.settings-daemon.plugins.media-keys terminal '<Primary><Alt>t'\n\
                       org.gnome.shell.keybindings toggle-message-tray ['<Super>v', '<Super>m']\n";
        assert!(holder(listing, "ctrl+alt+t").is_some());
        assert!(holder(listing, "super+m").is_some());
    }

    #[test]
    fn accelerators_become_trove_chords() {
        assert_eq!(accel_to_chord("<Alt>space").as_deref(), Some("alt+space"));
        assert_eq!(
            accel_to_chord("<Primary><Shift>grave").as_deref(),
            Some("ctrl+shift+backquote")
        );
        assert_eq!(
            accel_to_chord("<Super>Return").as_deref(),
            Some("super+enter")
        );
        assert_eq!(accel_to_chord("F1").as_deref(), Some("f1"));
        assert_eq!(accel_to_chord(""), None);
        assert_eq!(accel_to_chord("<Hyper>a"), None);
        assert_eq!(accel_to_chord("<Alt>"), None);
    }
}

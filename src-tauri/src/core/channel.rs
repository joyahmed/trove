//! Which store this build ships through (plan 22, 22.2.2). One source tree, many channels: the
//! channel is a compile-time fact, `TROVE_CHANNEL` read by `option_env!` while cargo builds.
//! Unset (every build today, the GitHub `setup.exe`) is `direct`; the Microsoft Store MSIX
//! build is made with `TROVE_CHANNEL=msstore` and `--config src-tauri/tauri.msix.conf.json`.
//!
//! What changes per channel is decided here and nowhere else:
//! - "Start with Windows": the HKCU `Run` key is virtualized inside an MSIX package, so it
//!   never fires. The Store build asks the package's `windows.startupTask` instead
//!   (`core/startup.rs`).
//! - "Use as default file manager": its four `HKCU\Software\Classes` writes land in the
//!   package's private hive, which Explorer never reads. The Store build hides the row and
//!   refuses the command, rather than offering a switch that does nothing.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    /// GitHub download (NSIS `setup.exe`, `.dmg`, `.deb`, AppImage), and every dev build.
    Direct,
    /// Microsoft Store, packed as MSIX.
    Msstore,
}

/// What the Store build says instead of the default-file-manager switch.
pub const DEFAULT_HANDLER_UNAVAILABLE: &str = "Not available in the Store version yet";

/// The MSIX `windows.startupTask` `TaskId` the Store manifest declares (22.2.3).
#[cfg_attr(not(windows), allow(dead_code))]
pub const STARTUP_TASK_ID: &str = "TroveStartup";

impl Channel {
    /// `None` and an empty value are `direct`; an unknown name is refused, so a typo in the
    /// release job fails the build instead of shipping the wrong behaviour.
    pub const fn parse(raw: Option<&str>) -> Option<Channel> {
        match raw {
            None => Some(Channel::Direct),
            Some(s) => match s.as_bytes() {
                b"" | b"direct" => Some(Channel::Direct),
                b"msstore" => Some(Channel::Msstore),
                _ => None,
            },
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Channel::Direct => "direct",
            Channel::Msstore => "msstore",
        }
    }

    /// Start at login goes through the package's StartupTask, not the `Run` key.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub const fn uses_startup_task(self) -> bool {
        matches!(self, Channel::Msstore)
    }

    /// Whether this build may write the default-file-manager keys at all.
    pub const fn offers_default_handler(self) -> bool {
        matches!(self, Channel::Direct)
    }

    /// Whether this channel may update itself (plan 22.5). A store updates its own builds, so
    /// only the GitHub downloads do.
    pub const fn self_updates(self) -> bool {
        matches!(self, Channel::Direct)
    }
}

/// Whether this build carries the updater: the cargo feature `updater` (off by default) AND a
/// channel that self-updates. Settings and the status bar show nothing about updates when false.
pub const fn updater_on(feature: bool, channel: Channel) -> bool {
    feature && channel.self_updates()
}

/// This build's answer to [`updater_on`].
pub const UPDATER: bool = updater_on(cfg!(feature = "updater"), CURRENT);

// ⛔ A store build never self-updates (plan 22 rules): `TROVE_CHANNEL=msstore` with
// `--features updater` is refused at compile time rather than shipping a plugin the Store forbids.
const _: () = assert!(
    !(cfg!(feature = "updater") && !CURRENT.self_updates()),
    "the updater feature is for the GitHub builds only; build msstore without --features updater"
);

/// This build's channel. An unknown `TROVE_CHANNEL` is a compile error.
pub const CURRENT: Channel = match Channel::parse(option_env!("TROVE_CHANNEL")) {
    Some(c) => c,
    None => panic!("TROVE_CHANNEL must be unset, \"direct\" or \"msstore\""),
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_and_empty_and_direct_are_direct() {
        assert_eq!(Channel::parse(None), Some(Channel::Direct));
        assert_eq!(Channel::parse(Some("")), Some(Channel::Direct));
        assert_eq!(Channel::parse(Some("direct")), Some(Channel::Direct));
    }

    #[test]
    fn msstore_parses_and_unknown_names_are_refused() {
        assert_eq!(Channel::parse(Some("msstore")), Some(Channel::Msstore));
        assert_eq!(Channel::parse(Some("MSSTORE")), None);
        assert_eq!(Channel::parse(Some("store")), None);
        assert_eq!(Channel::parse(Some(" msstore")), None);
    }

    #[test]
    fn what_each_channel_does() {
        assert!(!Channel::Direct.uses_startup_task());
        assert!(Channel::Direct.offers_default_handler());
        assert!(Channel::Msstore.uses_startup_task());
        assert!(!Channel::Msstore.offers_default_handler());
    }

    #[test]
    fn only_the_direct_channel_with_the_feature_self_updates() {
        assert!(Channel::Direct.self_updates());
        assert!(!Channel::Msstore.self_updates());
        assert!(updater_on(true, Channel::Direct));
        assert!(!updater_on(false, Channel::Direct));
        assert!(!updater_on(true, Channel::Msstore));
        assert!(!updater_on(false, Channel::Msstore));
        assert_eq!(
            UPDATER,
            cfg!(feature = "updater") && CURRENT == Channel::Direct
        );
    }

    /// The MSIX config never asks for updater bundles: the Store updates that build.
    #[test]
    fn msix_config_makes_no_updater_artifacts() {
        let raw =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.msix.conf.json"))
                .expect("tauri.msix.conf.json");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            v["bundle"]["createUpdaterArtifacts"],
            serde_json::Value::Bool(false)
        );
        assert!(v.get("plugins").and_then(|p| p.get("updater")).is_none());
    }

    #[test]
    fn serializes_as_the_name_the_frontend_reads() {
        for c in [Channel::Direct, Channel::Msstore] {
            assert_eq!(
                serde_json::to_string(&c).unwrap(),
                format!("\"{}\"", c.as_str())
            );
        }
    }

    /// The MSIX config bundles nothing itself (winapp / makeappx packs it, 22.2.3).
    #[test]
    fn msix_config_turns_tauris_own_bundling_off() {
        let raw =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.msix.conf.json"))
                .expect("tauri.msix.conf.json");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["bundle"]["active"], serde_json::Value::Bool(false));
        // the identifier stays the base one: the Store identity lives in the MSIX manifest
        assert!(v.get("identifier").is_none());
    }
}

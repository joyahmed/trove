//! Self-update for the GitHub downloads (plan 22.5.2). Off unless the build has the cargo
//! feature `updater` AND a self-updating channel (`channel::UPDATER`); every build today has
//! neither, so nothing here runs and the frontend shows no update line.
//!
//! The plugin's settings (public key, endpoint, `createUpdaterArtifacts`) live in
//! `src-tauri/tauri.updater.conf.json`, merged only into an updater build with `--config`, so
//! the base `tauri.conf.json` and today's installers are unchanged.
//!
//! ⛔ Never forced. A found update is downloaded and checked against the key in the background;
//! then the status bar offers "Restart to update" and waits for the person to click it.

/// How the placeholder public key starts. Joy generates the real key pair (plan 22.5.1, JOY Q9)
/// and pastes the public half into `tauri.updater.conf.json`; until then no check runs.
pub const PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_";

/// Wait this long after start before asking: the first seconds belong to the window and the
/// name index, and an update is never urgent.
#[cfg_attr(not(feature = "updater"), allow(dead_code))]
pub const CHECK_DELAY: std::time::Duration = std::time::Duration::from_secs(20);

/// The event every explorer window hears once an update is downloaded and verified. Payload:
/// the new version, e.g. `"0.1.1"`.
#[cfg_attr(not(feature = "updater"), allow(dead_code))]
pub const UPDATE_READY_EVENT: &str = "update:ready";

/// Whether a real public key is in place: not empty and not the placeholder.
#[cfg_attr(not(feature = "updater"), allow(dead_code))]
pub fn key_is_set(pubkey: &str) -> bool {
    let k = pubkey.trim();
    !k.is_empty() && !k.starts_with(PUBKEY_PLACEHOLDER)
}

/// A downloaded, verified update waiting for the person's click. The install step is a closure
/// so this type (and the commands that hold it) look the same with the feature on or off.
pub struct Ready {
    pub version: String,
    pub install: Box<dyn FnOnce() -> Result<(), String> + Send>,
}

/// The one update waiting, shared by every window. `None` until a check finds one.
#[derive(Default)]
pub struct Pending(std::sync::Mutex<Option<Ready>>);

impl Pending {
    #[cfg_attr(not(any(feature = "updater", test)), allow(dead_code))]
    pub fn set(&self, ready: Ready) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(ready);
    }

    pub fn version(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|r| r.version.clone())
    }

    pub fn take(&self) -> Option<Ready> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// Start the background check (once, at app start). Does nothing in a build without the
/// updater; with it, nothing until the public key is set.
#[cfg_attr(not(feature = "updater"), allow(unused_variables))]
pub fn start<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // without the feature there is nothing to start; with it, UPDATER still says no in a Store
    // build (which cannot compile with the feature anyway, `channel.rs`)
    #[cfg(feature = "updater")]
    if super::channel::UPDATER {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(CHECK_DELAY);
            if let Err(e) = tauri::async_runtime::block_on(fetch(&app)) {
                log::warn!("update check: {e}");
            }
        });
    }
}

#[cfg(feature = "updater")]
async fn fetch<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    use tauri_plugin_updater::UpdaterExt;

    let key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .unwrap_or("");
    if !key_is_set(key) {
        log::info!("update check skipped: no updater public key yet (plan 22.5.1)");
        return Ok(());
    }
    let Some(update) = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
    else {
        log::info!("update check: up to date");
        return Ok(());
    };
    // `download` verifies the signature against the key before it returns the bytes.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    let version = update.version.clone();
    log::info!("update {version} downloaded and verified; waiting for Restart to update");
    app.state::<Pending>().set(Ready {
        version: version.clone(),
        install: Box::new(move || update.install(&bytes).map_err(|e| e.to_string())),
    });
    app.emit(UPDATE_READY_EVENT, &version)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conf(name: &str) -> serde_json::Value {
        let path = format!("{}/{name}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(&path).expect(name)).unwrap()
    }

    #[test]
    fn the_placeholder_and_an_empty_key_are_not_a_key() {
        assert!(!key_is_set(""));
        assert!(!key_is_set("   "));
        assert!(!key_is_set("REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY_JOY_Q9"));
        assert!(key_is_set(
            "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk="
        ));
    }

    /// Today's builds are unchanged: the base config neither makes updater bundles nor
    /// configures the plugin. Only the updater config, merged by hand, does.
    #[test]
    fn only_the_updater_config_turns_updates_on() {
        let base = conf("tauri.conf.json");
        assert!(base["bundle"].get("createUpdaterArtifacts").is_none());
        assert!(base.get("plugins").and_then(|p| p.get("updater")).is_none());

        let up = conf("tauri.updater.conf.json");
        assert_eq!(up["bundle"]["createUpdaterArtifacts"], true);
        let plugin = &up["plugins"]["updater"];
        assert!(plugin["pubkey"].as_str().is_some());
        assert_eq!(
            plugin["endpoints"][0],
            "https://github.com/joyahmed/trove-releases/releases/latest/download/latest.json"
        );
        // a crafted latest.json cannot pair a new version number with an old signed build
        assert_eq!(plugin["requireSignedVersion"], true);
    }

    #[test]
    fn pending_holds_one_update_and_hands_it_out_once() {
        let p = Pending::default();
        assert_eq!(p.version(), None);
        p.set(Ready {
            version: "0.1.1".into(),
            install: Box::new(|| Ok(())),
        });
        assert_eq!(p.version().as_deref(), Some("0.1.1"));
        let ready = p.take().expect("waiting");
        assert!((ready.install)().is_ok());
        assert_eq!(p.version(), None);
        assert!(p.take().is_none());
    }
}

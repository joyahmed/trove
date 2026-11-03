use std::sync::Once;

use tauri::{AppHandle, Manager};

use crate::core::settings;

static MIGRATED: Once = Once::new();

fn dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// The config folder the app used under its placeholder identifier: the same parent folder
/// (`%APPDATA%`), the old name.
fn old_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let new = dir(app).ok()?;
    Some(new.parent()?.join(settings::OLD_IDENTIFIER))
}

#[tauri::command(async)]
pub fn read_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    let new = dir(&app)?;
    MIGRATED.call_once(|| {
        if let Some(old) = old_dir(&app) {
            // on failure no partial settings file is left, so the old folder stays the
            // authority and the next start tries again
            if let Err(e) = settings::migrate_from(&old, &new) {
                log::warn!("settings: could not carry the old settings folder over: {e}");
                log::debug!("settings: could not carry {} over: {e}", old.display());
            }
        }
    });
    settings::read(&new).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn write_settings(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    settings::write(&dir(&app)?, &value).map_err(|e| e.to_string())
}

/// Save only the fields a window changed, keeping the rest of the file (see `settings::merge`).
/// Windows other than `main` save this way; `main` still writes its whole snapshot.
#[tauri::command(async)]
pub fn merge_settings(app: AppHandle, patch: serde_json::Value) -> Result<(), String> {
    settings::merge(&dir(&app)?, &patch).map_err(|e| e.to_string())
}

/// The saved Theme setting as the appearance to force on an explorer window: `Light`/`Dark`,
/// or `None` (follow the system) for System, a missing file or anything unreadable.
/// ⚠️ Only a Mac calls it outside the test below (the glass is Mac-only), so on Windows and Linux
/// it is dead code and `clippy -D warnings` refuses the build without this allow.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn window_theme_of(saved: &serde_json::Value) -> Option<tauri::Theme> {
    match saved["theme"].as_str() {
        Some("light") => Some(tauri::Theme::Light),
        Some("dark") => Some(tauri::Theme::Dark),
        _ => None,
    }
}

/// macOS: the explorer windows' glass (the `sidebar` material) follows the WINDOW's appearance,
/// and the frontend can only set it once its settings load — about a second after the window
/// is on screen. Read the saved choice here, before the window shows, so Trove Light on a Mac
/// in Dark mode does not open on a second of dark glass. The frontend keeps it in step after
/// (`hooks/use-theme`). Mac-only, as both its callers are.
#[cfg(target_os = "macos")]
pub fn saved_window_theme<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<tauri::Theme> {
    let dir = app.path().app_config_dir().ok()?;
    window_theme_of(&settings::read(&dir).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_saved_theme_maps_to_a_forced_window_appearance_or_none() {
        assert_eq!(
            window_theme_of(&json!({ "theme": "light" })),
            Some(tauri::Theme::Light)
        );
        assert_eq!(
            window_theme_of(&json!({ "theme": "dark" })),
            Some(tauri::Theme::Dark)
        );
        assert_eq!(window_theme_of(&json!({ "theme": "system" })), None);
        assert_eq!(window_theme_of(&json!({})), None);
        assert_eq!(window_theme_of(&serde_json::Value::Null), None);
    }
}

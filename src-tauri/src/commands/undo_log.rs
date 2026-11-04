//! `undo.json` read and written for the frontend (`core::undo_log`), beside settings.json.

use tauri::{AppHandle, Manager};

use crate::core::undo_log;

fn dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn read_undo_log(app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(undo_log::read(&dir(&app)?))
}

#[tauri::command(async)]
pub fn write_undo_log(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    undo_log::write(&dir(&app)?, &value).map_err(|e| e.to_string())
}

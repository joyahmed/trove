//! Set as the default file manager: status, apply, revert. HKCU only on Windows, `xdg-mime`
//! on Linux, backed up first either way. The Store build (`core/channel.rs`) refuses apply and
//! revert and reports not-applied. The only caller of `apply` / `revert` is the
//! person's own toggle in the … menu.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::core::channel;
use crate::core::default_handler::{self, Status};
#[cfg(all(unix, not(target_os = "macos")))]
use crate::core::default_handler_linux as linux;

/// The real root; tests in `core` use a throw-away key instead.
#[cfg(not(all(unix, not(target_os = "macos"))))]
const CLASSES: &str = r"Software\Classes";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlerInfo {
    pub exe_path: String,
    /// false under a build folder, a temp folder or Downloads — the exe may not stay there
    pub stable: bool,
}

fn exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
const BACKUP_FILE: &str = default_handler::BACKUP_FILE;
#[cfg(all(unix, not(target_os = "macos")))]
const BACKUP_FILE: &str = linux::BACKUP_FILE;

fn backup_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join(BACKUP_FILE))
        .map_err(|e| e.to_string())
}

/// `~/.local/share/applications/<id>.desktop` (`$XDG_DATA_HOME` respected).
#[cfg(all(unix, not(target_os = "macos")))]
fn desktop_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is not set")?;
    Ok(linux::desktop_file_path(
        std::env::var("XDG_DATA_HOME").ok().as_deref(),
        &home,
    ))
}

#[tauri::command(async)]
pub fn default_handler_status() -> Result<Status, String> {
    // the Store build never writes the keys, so whatever its private hive holds is not ours
    if !channel::CURRENT.offers_default_handler() {
        return Ok(Status::NotApplied);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    return Ok(linux::status(&linux::run_xdg_mime));
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    Ok(default_handler::status(CLASSES, &exe()?))
}

#[tauri::command(async)]
pub fn default_handler_info() -> Result<HandlerInfo, String> {
    let exe = exe()?;
    Ok(HandlerInfo {
        stable: default_handler::is_stable_path(&exe),
        exe_path: exe.to_string_lossy().into_owned(),
    })
}

#[tauri::command(async)]
pub fn default_handler_apply(app: AppHandle) -> Result<(), String> {
    default_handler::allowed(channel::CURRENT).map_err(|e| e.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    return linux::apply(
        &linux::run_xdg_mime,
        &exe()?,
        &desktop_path()?,
        &backup_path(&app)?,
    )
    .map_err(|e| e.to_string());
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    default_handler::apply(CLASSES, &exe()?, &backup_path(&app)?).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn default_handler_revert(app: AppHandle) -> Result<(), String> {
    default_handler::allowed(channel::CURRENT).map_err(|e| e.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    return linux::revert(&linux::run_xdg_mime, &desktop_path()?, &backup_path(&app)?)
        .map_err(|e| e.to_string());
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    default_handler::revert(CLASSES, &backup_path(&app)?).map_err(|e| e.to_string())
}

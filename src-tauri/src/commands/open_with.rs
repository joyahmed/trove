//! "Open with ▸" on a file's right-click menu (plan 15 G.61). Thin: `core::open_with` lists and
//! opens; a failure here is the same plain sentence a failed double-click shows
//! (`fs::open_failed`), the raw reason left to the log.

use std::path::Path;

use crate::commands::fs::open_failed;
use crate::core::open_with::{self, OpenWithApp};

/// The apps registered for `path`'s type, default first. `(async)`: the OS reads its
/// association lists from disk and the registry.
#[tauri::command(async)]
pub fn open_with_apps(path: String) -> Vec<OpenWithApp> {
    open_with::apps_for(Path::new(&path))
}

/// Open `paths` (one type, the menu checks) in the app `id` the list gave.
#[tauri::command(async)]
pub fn open_with_app(id: String, paths: Vec<String>) -> Result<(), String> {
    let first = paths.first().cloned().ok_or("Nothing to open.")?;
    open_with::open_in(&id, &paths).map_err(|e| {
        log::warn!("open_with_app {id} ({} path(s)): {e}", paths.len());
        log::debug!("open_with_app {id} {paths:?}: {e}");
        open_failed(Path::new(&first), None)
    })
}

/// Windows' own "Open with" dialog for `path` ("Choose another app…"); the file opens in what
/// the person picks. `(async)`: the dialog is modal and this waits for it to close.
#[tauri::command(async)]
pub fn open_with_dialog(path: String) -> Result<(), String> {
    open_with::choose_dialog(&path).map_err(|e| {
        log::warn!("open_with_dialog: {e}");
        log::debug!("open_with_dialog {path}: {e}");
        open_failed(Path::new(&path), None)
    })
}

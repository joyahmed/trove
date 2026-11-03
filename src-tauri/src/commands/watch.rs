//! Live refresh: a tab asks to watch its folder and gets `fs:changed` events back. One
//! watcher for the process, created on the first call; WSL shares are never watched (no
//! events cross the 9P boundary — the frontend polls there).

use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

use crate::core::watch::{FsChanged, Watchers};
use crate::core::wsl;

/// Payload `FsChanged { path, kind: "changed" | "gone" }`; `changed` is debounced 200 ms.
pub const FS_CHANGED_EVENT: &str = "fs:changed";

static WATCHERS: Mutex<Option<Watchers>> = Mutex::new(None);

fn with_watchers<T>(
    app: Option<&AppHandle>,
    f: impl FnOnce(&mut Watchers) -> T,
) -> Result<Option<T>, String> {
    let mut guard = WATCHERS.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let Some(app) = app.cloned() else {
            return Ok(None);
        };
        let watchers = Watchers::new(move |change: FsChanged| {
            let _ = app.emit(FS_CHANGED_EVENT, change);
        })
        .map_err(|e| e.to_string())?;
        *guard = Some(watchers);
    }
    Ok(guard.as_mut().map(f))
}

/// Watch `path` (non-recursive). Reference-counted: two tabs on one folder share a watch.
#[tauri::command(async)]
pub fn watch_path(app: AppHandle, path: String) -> Result<(), String> {
    if wsl::is_wsl_path(&path) {
        return Ok(());
    }
    match with_watchers(Some(&app), |w| w.watch(&path))? {
        Some(result) => result.map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Drop one reference to `path`'s watch; the OS watch ends with the last one.
#[tauri::command(async)]
pub fn unwatch_path(path: String) {
    let _ = with_watchers(None, |w| w.unwatch(&path));
}

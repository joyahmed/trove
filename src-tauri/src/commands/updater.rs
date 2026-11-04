//! The update line in the status bar (plan 22.5.3). Mirrors `src/lib/api/updater.ts`. Both
//! commands exist in every build; without the updater nothing is ever pending, and the
//! frontend does not even ask (`selfUpdates()` is false).

use tauri::{AppHandle, State};

use crate::core::updater::Pending;

/// The version downloaded and waiting for "Restart to update", if any.
#[tauri::command(async)]
pub fn update_ready(pending: State<'_, Pending>) -> Option<String> {
    pending.version()
}

/// The person clicked "Restart to update": install the waiting update and start again. On
/// Windows the installer itself closes Trove and opens the new one; elsewhere we restart.
#[tauri::command(async)]
pub fn update_restart(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    let ready = pending
        .take()
        .ok_or_else(|| "No update is waiting".to_string())?;
    log::info!("installing update {}", ready.version);
    // the tabs are already on disk (each window saves them on every change); what is not yet is
    // a window move in the debounce and the index's unsaved parts. On Windows `install` ends the
    // process itself, so the run loop's own save on exit never runs.
    crate::save_on_the_way_out(&app);
    (ready.install)()?;
    // from this (async) thread `restart` asks the run loop to exit: ExitRequested then Exit
    // run, so the session is kept as quit, and single-instance releases its lock before the
    // new process starts
    app.restart()
}

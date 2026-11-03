use crate::core::fs::FileEntry;
use crate::core::recent;

/// The OS's recent files, newest first, for Home's Recent section: Windows' Recent shortcuts,
/// or Linux's `recently-used.xbel`. Other systems have none here. Never errors.
#[tauri::command(async)]
pub fn recent_files() -> Vec<FileEntry> {
    // `cfg!`, not `#[cfg]`: both readers compile everywhere (so both stay tested and neither
    // is dead code on some OS); only the one that has a source on this OS runs.
    if cfg!(target_os = "linux") {
        recent::xbel_path()
            .map(|p| recent::recent_files_xbel(&p))
            .unwrap_or_default()
    } else {
        recent::recent_dir()
            .map(|d| recent::recent_files(&d))
            .unwrap_or_default()
    }
}

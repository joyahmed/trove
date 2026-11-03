use crate::core::shell::{self, DriveInfo, KnownFolder};

/// ⚠️ Counts, not paths (A.4). These two return a bare `Vec`, so they have no way to say
/// "the call failed" — an empty list is all the frontend ever sees, and This PC rendering
/// nothing is what that looks like. Until the shape changes, the log is the only place the
/// difference between "none" and "could not ask" can show up.
#[tauri::command(async)]
pub fn drives() -> Vec<DriveInfo> {
    let d = shell::drives();
    log::info!("drives: {} drive(s)", d.len());
    d
}

#[tauri::command(async)]
pub fn known_folders() -> Vec<KnownFolder> {
    let profile = shell::user_profile();
    if profile.is_none() {
        log::error!(
            "known_folders: no user profile — {} will have no folders",
            shell::THIS_PC_LABEL
        );
    }
    let f = profile
        .map(|p| shell::known_folders(&p))
        .unwrap_or_default();
    log::info!("known_folders: {} folder(s)", f.len());
    f
}

/// The OneDrive root, when the client is set up and its folder exists.
#[tauri::command(async)]
pub fn one_drive_root() -> Option<String> {
    shell::one_drive_root()
}

#[tauri::command(async)]
pub fn user_profile() -> Option<String> {
    shell::user_profile().map(|p| p.to_string_lossy().into_owned())
}

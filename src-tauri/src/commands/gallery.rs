use std::path::{Path, PathBuf};

use crate::core::fs::FileEntry;
use crate::core::gallery;
use crate::core::shell;

/// Everything the Gallery shows, newest first. The walk runs on the blocking pool (it waits
/// up to the budget for its folder threads) and returns what it found within the budget.
#[tauri::command]
pub async fn gallery_items(max: Option<usize>) -> Vec<FileEntry> {
    tauri::async_runtime::spawn_blocking(move || list(max))
        .await
        .unwrap_or_default()
}

fn list(max: Option<usize>) -> Vec<FileEntry> {
    let profile = shell::user_profile();
    let known_pictures: Option<PathBuf> = profile.as_deref().and_then(|p| {
        shell::known_folders(p)
            .into_iter()
            .find(|f| f.key == "pictures")
            .map(|f| PathBuf::from(f.path))
    });
    let one_drive = shell::one_drive_root().map(PathBuf::from);
    let roots = gallery::gallery_roots(
        profile.as_deref(),
        known_pictures.as_deref().map(Path::new),
        one_drive.as_deref(),
    );
    let protected = profile
        .as_deref()
        .map(|home| gallery::protected_dirs(home, cfg!(target_os = "macos")))
        .unwrap_or_default();
    log::info!(
        "gallery: walking {} folder(s), never entering {} protected one(s) or any package",
        roots.len(),
        protected.len()
    );
    log::debug!("gallery: walking {roots:?}, never entering {protected:?}");
    gallery::gallery_items(
        &roots,
        &protected,
        max.unwrap_or(gallery::DEFAULT_MAX),
        gallery::MAX_DEPTH,
        gallery::BUDGET,
    )
}

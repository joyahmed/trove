//! Who holds a file open, and ending that program (plan 21B). Mirrors `src/lib/api/lockers.ts`.
use crate::core::lockers::{self, Ended, LockedPath};
use std::path::{Path, PathBuf};

/// Who holds each of `paths` open, when `error` (the failure the frontend got) is "in use".
/// Never errors: anything else, or any other OS, is an empty list and the plain error stays.
#[tauri::command(async)]
pub fn who_is_locking(paths: Vec<String>, error: String) -> Vec<LockedPath> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    lockers::locked(&paths, &error)
}

/// Ask the program `pid` that holds `path` to close; `force` kills it. The frontend has asked
/// the person first; this side still refuses Trove, Explorer, services and critical programs.
#[tauri::command(async)]
pub fn end_locking_app(path: String, pid: u32, force: bool) -> Result<Ended, String> {
    lockers::end(Path::new(&path), pid, force)
}

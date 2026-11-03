//! The Properties panel: one item's details, its two writable attribute bits, and a folder's
//! contents counted on a thread that streams `props:totals`. Also the list's Size column for
//! folders (plan 21 A): many folders sized at once, streaming `props:folder-size`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::preview::{read_failed, refuse_archive_row};
use crate::core::folder_sizes::{self, DriveKind};
use crate::core::props::{self, Cap, FolderTotals, Props};

/// The last part of `path`, for a sentence.
fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Running totals while a count runs, then one payload with `done: true`.
pub const TOTALS_EVENT: &str = "props:totals";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotalsEvent {
    pub job_id: u64,
    pub files: u64,
    pub folders: u64,
    pub bytes: u64,
    pub size_on_disk: u64,
    /// folders counted as one item but not walked (a Mac media library, ~/Library)
    pub not_counted: u64,
    pub done: bool,
}

impl TotalsEvent {
    fn from(job_id: u64, t: &FolderTotals, done: bool) -> Self {
        Self {
            job_id,
            files: t.files,
            folders: t.folders,
            bytes: t.bytes,
            size_on_disk: t.size_on_disk,
            not_counted: t.not_counted,
            done,
        }
    }
}

static NEXT_JOB: AtomicU64 = AtomicU64::new(1);
static JOBS: Mutex<Option<HashMap<u64, Arc<AtomicBool>>>> = Mutex::new(None);

fn with_jobs<T>(f: impl FnOnce(&mut HashMap<u64, Arc<AtomicBool>>) -> T) -> T {
    let mut guard = JOBS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

#[tauri::command(async)]
pub fn file_props(path: String) -> Result<Props, String> {
    refuse_archive_row(&path)?;
    props::props(Path::new(&path)).map_err(|e| read_failed("file_props", &path, &e))
}

/// Flip read-only and/or hidden; a bit that is not given is left alone.
#[tauri::command(async)]
pub fn set_file_attributes(
    path: String,
    read_only: Option<bool>,
    hidden: Option<bool>,
) -> Result<(), String> {
    refuse_archive_row(&path)?;
    props::set_attributes(Path::new(&path), read_only, hidden).map_err(|e| {
        log::warn!("set_file_attributes: {e}");
        log::debug!("set_file_attributes {path}: {e}");
        let name = file_name(&path);
        match e.kind() {
            std::io::ErrorKind::PermissionDenied => {
                format!("Trove can't change \"{name}\": access is denied.")
            }
            std::io::ErrorKind::NotFound => format!("\"{name}\" is no longer there."),
            _ => format!("Couldn't change \"{name}\"."),
        }
    })
}

/// Count a folder's contents on a thread; returns the job id at once, totals arrive as events.
#[tauri::command(async)]
pub fn start_folder_totals(app: AppHandle, path: String) -> u64 {
    let job_id = NEXT_JOB.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    with_jobs(|j| j.insert(job_id, Arc::clone(&cancel)));
    std::thread::spawn(move || {
        let mut sink = |t: &FolderTotals| {
            let _ = app.emit(TOTALS_EVENT, TotalsEvent::from(job_id, t, false));
        };
        let totals = props::folder_totals(Path::new(&path), &cancel, &mut sink);
        with_jobs(|j| j.remove(&job_id));
        let _ = app.emit(TOTALS_EVENT, TotalsEvent::from(job_id, &totals, true));
    });
    job_id
}

/// Stop a running count after the current entry. Unknown ids are ignored.
#[tauri::command(async)]
pub fn cancel_folder_totals(job_id: u64) {
    if let Some(flag) = with_jobs(|j| j.get(&job_id).cloned()) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// One folder's size for the list, once its walk is done.
pub const FOLDER_SIZE_EVENT: &str = "props:folder-size";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSizeEvent {
    pub job_id: u64,
    pub path: String,
    pub bytes: u64,
    /// the walk stopped at `Cap::LIST`; the list shows "≥ 12.3 GB"
    pub capped: bool,
}

/// Which kind of drive a folder is on; the frontend's setting decides whether it is sized.
#[tauri::command(async)]
pub fn folder_drive_kind(path: String) -> DriveKind {
    folder_sizes::drive_kind(Path::new(&path))
}

/// Size these folders in the background, at most `MAX_WALKS` at a time across all jobs, each
/// stopped at `Cap::LIST`. Returns the job id at once; every size arrives as its own event.
/// Cancelled with `cancel_folder_totals`, the same job map as the Properties count.
#[tauri::command(async)]
pub fn start_folder_sizes(app: AppHandle, paths: Vec<String>) -> u64 {
    let job_id = NEXT_JOB.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    with_jobs(|j| j.insert(job_id, Arc::clone(&cancel)));
    std::thread::spawn(move || {
        let sink = |s: folder_sizes::FolderSize| {
            let _ = app.emit(
                FOLDER_SIZE_EVENT,
                FolderSizeEvent {
                    job_id,
                    path: s.path,
                    bytes: s.bytes,
                    capped: s.capped,
                },
            );
        };
        folder_sizes::size_folders(paths, &cancel, Cap::LIST, &sink);
        with_jobs(|j| j.remove(&job_id));
    });
    job_id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn props_of_an_archive_row_is_a_sentence_not_the_os_error() {
        let row = "/home/j/a.zip\u{0}docs/a.txt".to_string();
        let said = file_props(row.clone()).unwrap_err();
        assert_eq!(
            said,
            "\"a.txt\" is inside an archive, so Trove can't read it as a file."
        );
        let said = set_file_attributes(row, Some(true), None).unwrap_err();
        assert!(said.starts_with("\"a.txt\" is inside an archive"), "{said}");
    }

    #[test]
    fn props_of_a_missing_path_hides_the_os_text() {
        let said = file_props("/no/such/dir/zz-trove-gone.bin".into()).unwrap_err();
        assert_eq!(said, "\"zz-trove-gone.bin\" is no longer there.");
    }
}

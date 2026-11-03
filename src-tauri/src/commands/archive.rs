//! Archive jobs (plan 16): extract a zip, "Extract here", compress to zip. Each runs on its
//! own thread and reports through the SAME two events as a copy (`commands/transfer.rs`), so
//! the progress panel, Cancel (`cancel_transfer`) and Undo need no second path.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use super::transfer::{with_jobs, DONE_EVENT, NEXT_JOB, PROGRESS_EVENT};
use crate::core::archive::index;
use crate::core::archive::job::{self, ArchiveDone};
use crate::core::archive::ArchiveFormat;
use crate::core::fs::{self, DirListing, FileEntry};
use crate::core::icons;
use crate::core::transfer::{Resolution, TransferProgress};

/// Register a job, run `work` on its own thread with the job's cancel flag and progress sink,
/// then forget the job and emit `transfer:done`. Returns the id at once.
fn spawn_job(
    app: AppHandle,
    work: impl FnOnce(u64, &AtomicBool, &dyn Fn(TransferProgress)) -> ArchiveDone + Send + 'static,
) -> u64 {
    let job_id = NEXT_JOB.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    with_jobs(|jobs| jobs.insert(job_id, Arc::clone(&cancel)));
    std::thread::spawn(move || {
        let sink = |p: TransferProgress| {
            let _ = app.emit(PROGRESS_EVENT, p);
        };
        let done = work(job_id, &cancel, &sink);
        with_jobs(|jobs| jobs.remove(&job_id));
        let _ = app.emit(DONE_EVENT, done);
    });
    job_id
}

/// Top-level names of the archive (or of `entries` in it) that already exist in
/// `destination` — what the conflict dialog asks about. An unreadable archive lists nothing;
/// the extract that follows reports the error.
#[tauri::command(async)]
pub fn archive_conflicts(
    archive: String,
    destination: String,
    entries: Option<Vec<String>>,
) -> Vec<String> {
    job::conflicts(
        Path::new(&archive),
        Path::new(&destination),
        entries.as_deref(),
    )
    .unwrap_or_default()
}

/// Extract `archive` (or only `entries` of it) into `destination`, answering a top-level
/// conflict with `resolution`. Returns the job id at once.
#[tauri::command(async)]
pub fn start_extract(
    app: AppHandle,
    archive: String,
    destination: String,
    entries: Option<Vec<String>>,
    resolution: Resolution,
) -> u64 {
    spawn_job(app, move |job_id, cancel, sink| {
        job::run_extract(
            job_id,
            Path::new(&archive),
            Path::new(&destination),
            entries.as_deref(),
            resolution,
            cancel,
            sink,
        )
    })
}

/// "Extract here": into a new folder beside the archive named after it (`photos`, then
/// `photos (2)`), so nothing can conflict.
#[tauri::command(async)]
pub fn start_extract_here(app: AppHandle, archive: String) -> u64 {
    spawn_job(app, move |job_id, cancel, sink| {
        job::run_extract_here(job_id, Path::new(&archive), cancel, sink)
    })
}

/// Compress `sources` into one archive beside them (Phase 1: zip only).
#[tauri::command(async)]
pub fn start_compress(app: AppHandle, sources: Vec<String>, format: ArchiveFormat) -> u64 {
    let sources: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
    spawn_job(app, move |job_id, cancel, sink| {
        job::run_compress(job_id, &sources, format, cancel, sink)
    })
}

/// What `read_archive_dir` puts between the archive and the inner path in a `path`: NUL can
/// be in no real path on any OS, so a listing row handed to a real-path command by mistake
/// (rename, delete, open) fails instead of touching the archive or anything next to it.
pub const INNER_SEP: char = '\u{0}';

/// One folder level of an archive as a `DirListing`, so the file list needs no second kind of
/// row. `inner` is `/`-separated, `""` for the top. `icon_key` is `folder` or `ext/<ext>`
/// only: never `file/<path>`, which would ask the shell about a path that does not exist.
#[tauri::command(async)]
pub fn read_archive_dir(archive: String, inner: String) -> Result<DirListing, String> {
    let all = index::list(Path::new(&archive)).map_err(|e| e.to_string())?;
    let rows = index::children(&all, &inner).map_err(|e| e.to_string())?;
    Ok(listing_of(&archive, &inner, &rows))
}

fn listing_of(archive: &str, inner: &str, rows: &[&index::IndexEntry]) -> DirListing {
    let mut types: HashMap<Option<String>, String> = HashMap::new();
    let mut entries: Vec<FileEntry> = rows
        .iter()
        .map(|e| {
            let name = e.inner.rsplit('/').next().unwrap_or_default().to_string();
            let ext = (!e.is_dir)
                .then(|| name.rsplit_once('.').map(|(_, x)| x.to_lowercase()))
                .flatten()
                .filter(|x| !x.is_empty());
            let icon_key = match (&ext, e.is_dir) {
                (_, true) => "folder".to_string(),
                (Some(x), false) => format!("ext/{x}"),
                (None, false) => "ext/".to_string(),
            };
            let type_name = if e.is_dir {
                fs::FOLDER_TYPE.to_string()
            } else {
                types
                    .entry(ext.clone())
                    .or_insert_with(|| icons::type_name(ext.as_deref()))
                    .clone()
            };
            FileEntry {
                path: format!("{archive}{INNER_SEP}{}", e.inner),
                is_hidden: name.starts_with('.'),
                name,
                is_dir: e.is_dir,
                size: e.size,
                modified_ms: e.modified_ms,
                created_ms: None,
                ext,
                icon_key,
                type_name,
                is_link: false,
            }
        })
        .collect();
    entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));
    DirListing {
        path: format!("{archive}{INNER_SEP}{}", inner.trim_matches('/')),
        entries,
    }
}

/// The folder open-inside copies live in: `<app cache>/archive-open`.
pub fn open_cache_root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_cache_dir()
        .ok()
        .map(|d| d.join("archive-open"))
}

/// Open a file inside an archive: extract it to a read-only temp copy (reused by a second
/// open, never overwritten) and return that path for `open_path`.
#[tauri::command(async)]
pub fn start_open_inner(app: AppHandle, archive: String, inner: String) -> Result<String, String> {
    let root = open_cache_root(&app).ok_or("No cache folder for this app")?;
    index::open_inner(&root, Path::new(&archive), &inner)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::archive::job::tests::make_zip;
    use crate::core::archive::test_util::scratch;

    fn listing(name: &str, files: &[(&str, &[u8])], inner: &str) -> (PathBuf, DirListing) {
        let root = scratch(name);
        let zip = root.join("l.zip");
        make_zip(&zip, files);
        let all = index::read_index(&zip).unwrap();
        let rows = index::children(&all, inner).unwrap();
        let out = listing_of(&zip.to_string_lossy(), inner, &rows);
        (root, out)
    }

    #[test]
    fn listing_paths_contain_nul() {
        let (root, out) = listing("cmd-nul", &[("docs/a.txt", b"a"), ("b.txt", b"b")], "");
        assert!(out.path.ends_with('\u{0}'));
        let names: Vec<_> = out.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["docs", "b.txt"], "folders first");
        for e in &out.entries {
            assert!(e.path.contains('\u{0}'), "{}", e.path);
            assert!(std::fs::metadata(&e.path).is_err());
        }
        assert!(out.entries[1].path.ends_with("\u{0}b.txt"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn icon_keys_never_point_at_a_real_file() {
        let (root, out) = listing(
            "cmd-icons",
            &[
                ("setup.exe", b"x"),
                ("link.lnk", b"x"),
                ("noext", b"x"),
                ("d/", b""),
            ],
            "",
        );
        for e in &out.entries {
            assert!(
                e.icon_key == "folder" || e.icon_key.starts_with("ext/"),
                "{}",
                e.icon_key
            );
        }
        let exe = out.entries.iter().find(|e| e.name == "setup.exe").unwrap();
        assert_eq!(exe.icon_key, "ext/exe");
        assert_eq!(exe.ext.as_deref(), Some("exe"));
        std::fs::remove_dir_all(root).unwrap();
    }
}

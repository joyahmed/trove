//! Recursive search. A search runs on its own thread and streams `search:results` batches;
//! the commands only start and cancel. Starting a new search never cancels an older one — the
//! frontend does that explicitly.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::core::fs::FileEntry;
use crate::core::search::{self, SearchQuery, BATCH_SIZE};
use crate::core::{wsl, wsl_search};

/// How many hits `find` may print per distro; the walker has no cap, `find` needs one.
const WSL_MAX_HITS: usize = 2000;

/// Batches of matches while a search runs, then one payload with `done: true`.
pub const RESULTS_EVENT: &str = "search:results";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub search_id: u64,
    pub entries: Vec<FileEntry>,
    pub done: bool,
    pub cancelled: bool,
    pub error: Option<String>,
    /// Entries visited so far, for the status bar.
    pub scanned: u64,
    /// Mac: the privacy-guarded folders the person has not opened, which this search left out
    /// (`core::privacy_folders`). Filled on the `done` payload only; empty elsewhere and off a Mac.
    pub skipped_guarded: Vec<String>,
}

static NEXT_SEARCH: AtomicU64 = AtomicU64::new(1);
static SEARCHES: Mutex<Option<HashMap<u64, Arc<AtomicBool>>>> = Mutex::new(None);

fn with_searches<T>(f: impl FnOnce(&mut HashMap<u64, Arc<AtomicBool>>) -> T) -> T {
    let mut guard = SEARCHES.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Start a search under `roots` (a folder, or every drive from a place) and return its id at
/// once; results arrive as events.
#[tauri::command(async)]
pub fn start_search(
    app: AppHandle,
    roots: Vec<String>,
    query: SearchQuery,
    include_hidden: bool,
) -> u64 {
    let search_id = NEXT_SEARCH.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    with_searches(|s| s.insert(search_id, Arc::clone(&cancel)));
    std::thread::spawn(move || {
        // ⛔ said from the first batch, not only at the end: a long search of This Mac showed
        // "Search results in This Mac (0)" and no "Not searched … Allow" line until it finished
        // (Mac test, 2026-11-04). The walker never enters these, so they are known up front.
        let local: Vec<PathBuf> = roots
            .iter()
            .filter(|r| wsl::split_wsl_path(r).is_none())
            .map(PathBuf::from)
            .collect();
        let guarded = crate::core::privacy_folders::all();
        let ahead: Vec<PathBuf> = crate::core::privacy_folders::under_any(
            &local,
            &crate::core::privacy_folders::unopened(),
        )
        .into_iter()
        .filter(|g| std::fs::symlink_metadata(g).is_ok())
        .collect();
        let ahead = crate::core::privacy_folders::in_order(&ahead, &guarded);
        let batch = |entries: Vec<FileEntry>, scanned: u64| SearchResults {
            search_id,
            entries,
            done: false,
            cancelled: false,
            error: None,
            scanned,
            skipped_guarded: ahead.clone(),
        };
        let mut sink = |entries: Vec<FileEntry>, scanned: u64| {
            let _ = app.emit(RESULTS_EVENT, batch(entries, scanned));
        };
        // Windows roots go to the walker; a `\\wsl.localhost\<distro>\…` root goes to `find`
        // inside that distro (grouped per distro), all under this one search id.
        let mut windows_roots: Vec<PathBuf> = Vec::new();
        let mut wsl_roots: Vec<(String, Vec<String>)> = Vec::new();
        for root in roots {
            match wsl::split_wsl_path(&root) {
                Some((distro, linux)) => match wsl_roots.iter_mut().find(|(d, _)| *d == distro) {
                    Some((_, paths)) => paths.push(linux),
                    None => wsl_roots.push((distro, vec![linux])),
                },
                None => windows_roots.push(PathBuf::from(root)),
            }
        }
        let mut scanned = 0u64;
        let mut errors: Vec<String> = Vec::new();
        let mut skipped: Vec<PathBuf> = Vec::new();
        if !windows_roots.is_empty() {
            match search::walk(
                &windows_roots,
                &query,
                include_hidden,
                &cancel,
                BATCH_SIZE,
                &mut sink,
                &mut skipped,
            ) {
                Ok(n) => scanned += n,
                Err(e) => errors.push(e),
            }
        }
        for (distro, linux_roots) in wsl_roots {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let base = scanned;
            let mut filtered = |entries: Vec<FileEntry>, n: u64| {
                // `find` matched the name; the chips (kind, size, date) and the hidden rule
                // are ours to apply, as the walker does
                let kept: Vec<FileEntry> = entries
                    .into_iter()
                    .filter(|e| (include_hidden || !e.is_hidden) && search::matches(e, &query))
                    .collect();
                sink(kept, base + n);
            };
            match wsl_search::run(
                &distro,
                &linux_roots,
                &query.text,
                WSL_MAX_HITS,
                &cancel,
                &mut filtered,
            ) {
                Ok(n) => scanned += n,
                // a failed distro is a notice, not the end of the search
                Err(e) => {
                    let _ = app.emit(
                        RESULTS_EVENT,
                        SearchResults {
                            search_id,
                            entries: Vec::new(),
                            done: false,
                            cancelled: false,
                            error: Some(format!("{distro}: {e}")),
                            scanned,
                            skipped_guarded: Vec::new(),
                        },
                    );
                }
            }
        }
        // the walker's "no root is a folder" is the search's error only when nothing else ran
        let result: Result<u64, String> = if errors.is_empty() || scanned > 0 {
            Ok(scanned)
        } else {
            Err(errors.join("; "))
        };
        with_searches(|s| s.remove(&search_id));
        let (scanned, error) = match result {
            Ok(n) => (n, None),
            Err(e) => (0, Some(e)),
        };
        let _ = app.emit(
            RESULTS_EVENT,
            SearchResults {
                search_id,
                entries: Vec::new(),
                done: true,
                cancelled: cancel.load(Ordering::Relaxed),
                error,
                scanned,
                skipped_guarded: crate::core::privacy_folders::in_order(
                    &skipped,
                    &crate::core::privacy_folders::all(),
                ),
            },
        );
    });
    search_id
}

/// Ask a running search to stop after the current entry. Unknown ids are ignored.
#[tauri::command(async)]
pub fn cancel_search(search_id: u64) {
    if let Some(flag) = with_searches(|s| s.get(&search_id).cloned()) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The registry is process-wide and tests run in parallel: each test uses its own id range.

    #[test]
    fn registry_inserts_and_removes() {
        let id = 9_000_001;
        let flag = Arc::new(AtomicBool::new(false));
        with_searches(|s| s.insert(id, Arc::clone(&flag)));
        assert!(with_searches(|s| s.contains_key(&id)));
        assert!(with_searches(|s| s.remove(&id)).is_some());
        assert!(!with_searches(|s| s.contains_key(&id)));
    }

    #[test]
    fn cancel_sets_the_registered_flag() {
        let id = 9_000_002;
        let flag = Arc::new(AtomicBool::new(false));
        with_searches(|s| s.insert(id, Arc::clone(&flag)));
        cancel_search(id);
        assert!(flag.load(Ordering::Relaxed));
        with_searches(|s| s.remove(&id));
    }

    #[test]
    fn cancel_unknown_id_is_ignored() {
        let id = 9_000_003;
        assert!(!with_searches(|s| s.contains_key(&id)));
        cancel_search(id);
        assert!(!with_searches(|s| s.contains_key(&id)));
    }

    #[test]
    fn cancel_after_removal_leaves_flag_clear() {
        let id = 9_000_004;
        let flag = Arc::new(AtomicBool::new(false));
        with_searches(|s| s.insert(id, Arc::clone(&flag)));
        with_searches(|s| s.remove(&id));
        cancel_search(id);
        assert!(!flag.load(Ordering::Relaxed));
    }
}

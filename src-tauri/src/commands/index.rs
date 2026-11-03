//! The file-name index (plan 21C) as the palette asks it. Mirrors `src/lib/api/palette.ts`
//! (`indexSearch`, `indexProgress`).

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use crate::core::fs::{entry_from, FileEntry};
use crate::core::icons;
use crate::core::index::{Filling, Hit, Index};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexAnswer {
    /// `false` while no root has finished its first walk: the caller searches the way it did
    /// before.
    pub ready: bool,
    /// The folders whose every name the index holds; a walk of them adds nothing.
    pub roots: Vec<String>,
    pub hits: Vec<FileEntry>,
    /// How many names matched, of which `hits` are the best.
    pub total: usize,
    /// The roots still on their first walk, for the palette footer.
    pub filling: Vec<FillingRoot>,
    /// The roots served from their saved file and not caught up yet: a name made or deleted
    /// while Trove was closed may be missing or still listed.
    pub stale: Vec<String>,
}

/// "indexing D: — 412,000 so far" (plan 21C.2a).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillingRoot {
    pub label: String,
    pub seen: usize,
}

fn filling(index: &Index) -> Vec<FillingRoot> {
    index
        .filling()
        .into_iter()
        .map(|Filling { label, seen }| FillingRoot { label, seen })
        .collect()
}

/// The roots still on their first walk: the palette footer asks again while any is.
#[tauri::command]
pub fn index_progress(index: State<Index>) -> Vec<FillingRoot> {
    filling(&index)
}

/// The best `max_results` names under the indexed folders, ranked (`Table::search`). Only the
/// rows shown are looked up on disk; one deleted since the last event is left out.
#[tauri::command(async)]
pub fn index_search(index: State<Index>, text: String, max_results: usize) -> IndexAnswer {
    // the roots before the search: a root that turns ready in between is searched, not claimed
    let roots = index.roots();
    let Some((found, total)) = index.search(&text, max_results.clamp(1, 500)) else {
        return IndexAnswer {
            ready: false,
            roots: Vec::new(),
            hits: Vec::new(),
            total: 0,
            filling: filling(&index),
            stale: Vec::new(),
        };
    };
    let mut types = HashMap::new();
    let hits = found
        .into_iter()
        .filter_map(|hit| entry_of(hit, &mut types))
        .collect();
    IndexAnswer {
        ready: true,
        roots: roots
            .iter()
            .map(|r| r.to_string_lossy().into_owned())
            .collect(),
        hits,
        total,
        filling: filling(&index),
        stale: index.stale(),
    }
}

/// The row for one hit. A disk hit is looked up (one deleted since is left out); a WSL
/// snapshot hit is built from the snapshot alone — ⛔ never looked up, a look at a stopped
/// distro's share starts it.
fn entry_of(hit: Hit, types: &mut HashMap<Option<String>, String>) -> Option<FileEntry> {
    if !hit.snapshot {
        let meta = std::fs::symlink_metadata(&hit.path).ok()?;
        return Some(entry_from(hit.path, Some(meta), types));
    }
    let mut e = entry_from(hit.path, None, types);
    if hit.is_dir {
        e.is_dir = true;
        e.ext = None;
        e.icon_key = icons::icon_key(true, None, &e.path);
        e.type_name = crate::core::fs::dir_type_name(&e.name).to_string();
    }
    Some(e)
}

/// Bring the WSL snapshots up to date for the distros the palette saw running
/// (`Index::refresh_wsl`). Returns at once.
#[tauri::command]
pub fn index_wsl(index: State<Index>, distros: Vec<String>) {
    index.refresh_wsl(distros);
}

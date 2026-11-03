//! Recursive search under a folder: a `walkdir` walk that never follows links or reparse
//! points, filters each entry against a `SearchQuery`, and hands matches to a sink in batches
//! so the frontend can paint while the walk goes on. No tauri types; the command layer wires
//! the sink to an event.

use std::collections::HashMap;
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::core::fs::{self, FileEntry};

/// Entries per batch handed to the sink (unless the time limit fires first).
pub const BATCH_SIZE: usize = 200;
/// A partial batch is flushed after this long so results keep arriving on a sparse match.
pub const BATCH_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchKind {
    #[default]
    Any,
    File,
    Folder,
}

/// What the search box asks for. Every field narrows; an empty query matches everything.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    /// Case-insensitive substring of the file name; may be empty.
    #[serde(default)]
    pub text: String,
    /// Lower-case extension without the dot (from `*.png`).
    #[serde(default)]
    pub ext: Option<String>,
    #[serde(default)]
    pub kind: SearchKind,
    /// Modified at or after this Unix time in milliseconds.
    #[serde(default)]
    pub modified_after_ms: Option<u64>,
    /// Size bounds, inclusive; folders ignore them.
    #[serde(default)]
    pub min_bytes: Option<u64>,
    #[serde(default)]
    pub max_bytes: Option<u64>,
    /// How deep below the root to look; `None` is unbounded. The palette uses 3.
    #[serde(default)]
    pub max_depth: Option<usize>,
}

/// Does one entry satisfy the query?
pub fn matches(entry: &FileEntry, q: &SearchQuery) -> bool {
    match q.kind {
        SearchKind::File if entry.is_dir => return false,
        SearchKind::Folder if !entry.is_dir => return false,
        _ => {}
    }
    if !q.text.is_empty() && !entry.name.to_lowercase().contains(&q.text.to_lowercase()) {
        return false;
    }
    if let Some(ext) = &q.ext {
        if entry.ext.as_deref() != Some(ext.as_str()) {
            return false;
        }
    }
    if let Some(after) = q.modified_after_ms {
        if entry.modified_ms.is_none_or(|m| m < after) {
            return false;
        }
    }
    if !entry.is_dir {
        if q.min_bytes.is_some_and(|min| entry.size < min) {
            return false;
        }
        if q.max_bytes.is_some_and(|max| entry.size > max) {
            return false;
        }
    }
    true
}

/// Folders never worth descending into, by name at any depth (case-insensitive): the bin,
/// the volume's own bookkeeping, Windows' component store, and the two dependency caches a
/// developer's disk is full of. A search that walks a whole drive spends most of its time in
/// these and finds nothing a person asked for.
pub const SKIP_DIRS: [&str; 6] = [
    "$Recycle.Bin",
    "System Volume Information",
    "WinSxS",
    "servicing",
    "node_modules",
    ".git",
];

/// `WinSxS` and `servicing` are only skipped under a `Windows` folder; the rest anywhere.
pub fn skip_dir(name: &str, parent: Option<&str>) -> bool {
    let under_windows = parent.is_some_and(|p| p.eq_ignore_ascii_case("Windows"));
    SKIP_DIRS.iter().any(|d| {
        name.eq_ignore_ascii_case(d)
            && (under_windows
                || !(d.eq_ignore_ascii_case("WinSxS") || d.eq_ignore_ascii_case("servicing")))
    })
}

/// Walk every root in turn and hand every match to `sink` in batches of `batch_size` or every
/// `BATCH_INTERVAL`. Returns the number of entries visited over all roots. Individual
/// unreadable entries are skipped, a root that is not a folder is skipped; only when no root
/// is a folder is it an error. `cancel` is checked per entry and stops the whole walk.
pub fn walk(
    roots: &[PathBuf],
    q: &SearchQuery,
    include_hidden: bool,
    cancel: &AtomicBool,
    batch_size: usize,
    sink: &mut dyn FnMut(Vec<FileEntry>, u64),
) -> Result<u64, String> {
    walk_every(
        roots,
        q,
        include_hidden,
        cancel,
        batch_size,
        BATCH_INTERVAL,
        sink,
    )
}

/// `walk` with the flush interval as a parameter. When the interval passes with nothing
/// matched, an EMPTY batch goes out anyway — a heartbeat that carries `scanned`, so a big
/// tree with no hits still shows progress.
///
/// ⛔ A network share mounted below a root is never entered (`core/mounts.rs`): a search from
/// `/` on a Mac used to walk into `/Volumes/<share>`, and that is macOS's "access files on a
/// network volume" prompt; on Linux, a hang on a dead NFS server. A root that IS a share is
/// walked — the person opened it.
pub fn walk_every(
    roots: &[PathBuf],
    q: &SearchQuery,
    include_hidden: bool,
    cancel: &AtomicBool,
    batch_size: usize,
    interval: Duration,
    sink: &mut dyn FnMut(Vec<FileEntry>, u64),
) -> Result<u64, String> {
    let network = crate::core::mounts::network_mount_points();
    walk_skipping(
        roots,
        q,
        include_hidden,
        cancel,
        batch_size,
        interval,
        &network,
        sink,
    )
}

/// `walk_every` with the network mount points as a parameter, so a test can name one.
#[allow(clippy::too_many_arguments)]
fn walk_skipping(
    roots: &[PathBuf],
    q: &SearchQuery,
    include_hidden: bool,
    cancel: &AtomicBool,
    batch_size: usize,
    interval: Duration,
    network: &[PathBuf],
    sink: &mut dyn FnMut(Vec<FileEntry>, u64),
) -> Result<u64, String> {
    let folders: Vec<&PathBuf> = roots.iter().filter(|r| r.is_dir()).collect();
    if folders.is_empty() {
        let shown: Vec<String> = roots.iter().map(|r| r.display().to_string()).collect();
        return Err(format!("{}: not a folder", shown.join(", ")));
    }
    let mut types: HashMap<Option<String>, String> = HashMap::new();
    let mut batch: Vec<FileEntry> = Vec::with_capacity(batch_size.max(1));
    let mut last_flush = Instant::now();
    let mut scanned: u64 = 0;

    'roots: for root in folders {
        let mut walker = walkdir::WalkDir::new(root).follow_links(false).min_depth(1);
        if let Some(depth) = q.max_depth {
            walker = walker.max_depth(depth);
        }
        let mut it = walker.into_iter();
        loop {
            if cancel.load(Ordering::Relaxed) {
                break 'roots;
            }
            let Some(next) = it.next() else { break };
            let entry = match next {
                Ok(e) => e,
                Err(_) => continue, // a permission wall or a vanished entry: skip, keep walking
            };
            scanned += 1;
            let meta = entry.metadata().ok();
            let name = entry.file_name().to_string_lossy().into_owned();
            // Never descend into links, junctions, the system's own folders, or (when hidden
            // are off) hidden folders.
            let hidden = fs::is_hidden_entry(&name, meta.as_ref());
            if entry.file_type().is_dir() {
                let parent = entry
                    .path()
                    .parent()
                    .and_then(Path::file_name)
                    .map(|p| p.to_string_lossy().into_owned());
                if is_reparse_point(meta.as_ref())
                    || skip_dir(&name, parent.as_deref())
                    || crate::core::mounts::is_network_point(entry.path(), network)
                {
                    it.skip_current_dir();
                    continue;
                }
                if hidden && !include_hidden {
                    it.skip_current_dir();
                }
            }
            if hidden && !include_hidden {
                continue;
            }
            let file = fs::entry_from(entry.into_path(), meta, &mut types);
            if matches(&file, q) {
                batch.push(file);
            }
            if batch.len() >= batch_size || last_flush.elapsed() >= interval {
                sink(std::mem::take(&mut batch), scanned);
                last_flush = Instant::now();
            }
        }
    }
    if !batch.is_empty() {
        sink(batch, scanned);
    }
    Ok(scanned)
}

#[cfg(windows)]
pub(crate) fn is_reparse_point(meta: Option<&Metadata>) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.is_some_and(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

#[cfg(not(windows))]
pub(crate) fn is_reparse_point(meta: Option<&Metadata>) -> bool {
    meta.is_some_and(|m| m.file_type().is_symlink())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as stdfs;

    fn entry(name: &str, is_dir: bool, size: u64, modified_ms: Option<u64>) -> FileEntry {
        let ext = if is_dir {
            None
        } else {
            name.rsplit_once('.').map(|(_, e)| e.to_lowercase())
        };
        FileEntry {
            name: name.to_string(),
            path: format!("C:\\x\\{name}"),
            is_dir,
            size,
            modified_ms,
            created_ms: modified_ms,
            ext,
            is_hidden: false,
            is_link: false,
            icon_key: String::new(),
            type_name: String::new(),
        }
    }

    fn query(text: &str) -> SearchQuery {
        SearchQuery {
            text: text.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn text_matches_case_insensitively_and_empty_matches_all() {
        let e = entry("Straße-Report.TXT", false, 10, None);
        assert!(matches(&e, &query("report")));
        assert!(!matches(&e, &query("STRASSE"))); // ß does not fold to ss; substring only
        assert!(matches(&e, &query("straße")));
        assert!(matches(&e, &query("")));
        assert!(!matches(&e, &query("nope")));
    }

    #[test]
    fn ext_kind_size_and_date_filters() {
        let f = entry("a.PNG", false, 500, Some(1_000));
        let d = entry("pics", true, 0, Some(1_000));
        let png = SearchQuery {
            ext: Some("png".into()),
            ..Default::default()
        };
        assert!(matches(&f, &png));
        assert!(!matches(&d, &png));
        let folders = SearchQuery {
            kind: SearchKind::Folder,
            ..Default::default()
        };
        assert!(matches(&d, &folders));
        assert!(!matches(&f, &folders));
        let files = SearchQuery {
            kind: SearchKind::File,
            ..Default::default()
        };
        assert!(matches(&f, &files));
        let sized = SearchQuery {
            min_bytes: Some(500),
            max_bytes: Some(500),
            ..Default::default()
        };
        assert!(matches(&f, &sized));
        assert!(matches(&d, &sized), "folders ignore the size bounds");
        let too_small = SearchQuery {
            min_bytes: Some(501),
            ..Default::default()
        };
        assert!(!matches(&f, &too_small));
        let recent = SearchQuery {
            modified_after_ms: Some(1_000),
            ..Default::default()
        };
        assert!(matches(&f, &recent));
        let newer = SearchQuery {
            modified_after_ms: Some(1_001),
            ..Default::default()
        };
        assert!(!matches(&f, &newer));
        assert!(
            !matches(&entry("x", false, 1, None), &recent),
            "no date never passes a date filter"
        );
    }

    #[test]
    fn query_deserializes_camel_case_with_defaults() {
        let q: SearchQuery =
            serde_json::from_str(r#"{"text":"a","kind":"folder","modifiedAfterMs":5}"#).unwrap();
        assert_eq!(q.text, "a");
        assert_eq!(q.kind, SearchKind::Folder);
        assert_eq!(q.modified_after_ms, Some(5));
        assert_eq!(q.ext, None);
        let q: SearchQuery = serde_json::from_str(r#"{"text":""}"#).unwrap();
        assert_eq!(q.kind, SearchKind::Any);
    }

    // ── on a scratch tree ──────────────────────────────────────────────────────

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = stdfs::remove_dir_all(&self.0);
        }
    }

    fn tree(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("trove-search-{name}-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(dir.join("photos").join("2024")).unwrap();
        stdfs::create_dir_all(dir.join("docs")).unwrap();
        stdfs::write(dir.join("readme.txt"), b"hello").unwrap();
        stdfs::write(dir.join("photos").join("cat.png"), b"png").unwrap();
        stdfs::write(dir.join("photos").join("2024").join("dog.PNG"), b"png!").unwrap();
        stdfs::write(dir.join("docs").join("Report.docx"), b"docx").unwrap();
        stdfs::write(dir.join(".secret"), b"shh").unwrap();
        Scratch(dir)
    }

    fn collect(root: &Path, q: &SearchQuery, include_hidden: bool) -> (Vec<String>, u64) {
        let cancel = AtomicBool::new(false);
        let mut names = Vec::new();
        let scanned = walk(
            std::slice::from_ref(&root.to_path_buf()),
            q,
            include_hidden,
            &cancel,
            BATCH_SIZE,
            &mut |batch, _| {
                names.extend(batch.into_iter().map(|e| e.name));
            },
        )
        .unwrap();
        names.sort();
        (names, scanned)
    }

    #[test]
    fn text_search_finds_nested_files_and_folders() {
        let t = tree("text");
        let (names, scanned) = collect(&t.0, &query("o"), true);
        assert_eq!(names, vec!["Report.docx", "docs", "dog.PNG", "photos"]);
        assert_eq!(scanned, 8, "every entry in the tree is visited once");
    }

    #[test]
    fn extension_filter_is_case_insensitive_on_the_file() {
        let t = tree("ext");
        let q = SearchQuery {
            ext: Some("png".into()),
            ..Default::default()
        };
        let (names, _) = collect(&t.0, &q, true);
        assert_eq!(names, vec!["cat.png", "dog.PNG"]);
    }

    #[test]
    fn folder_kind_lists_only_folders() {
        let t = tree("kind");
        let q = SearchQuery {
            kind: SearchKind::Folder,
            ..Default::default()
        };
        let (names, _) = collect(&t.0, &q, true);
        assert_eq!(names, vec!["2024", "docs", "photos"]);
    }

    #[test]
    fn hidden_entries_are_skipped_unless_asked_for() {
        let t = tree("hidden");
        let (with, _) = collect(&t.0, &query("secret"), true);
        assert_eq!(with, vec![".secret"]);
        let (without, _) = collect(&t.0, &query("secret"), false);
        assert!(without.is_empty());
    }

    #[test]
    fn cancel_stops_after_the_current_batch() {
        let t = tree("cancel");
        let cancel = AtomicBool::new(false);
        let mut batches = 0;
        let mut got = 0;
        let scanned = walk(
            std::slice::from_ref(&t.0),
            &query(""),
            true,
            &cancel,
            2,
            &mut |batch, _| {
                batches += 1;
                got += batch.len();
                cancel.store(true, Ordering::Relaxed);
            },
        )
        .unwrap();
        assert_eq!(batches, 1);
        assert_eq!(got, 2);
        assert!(scanned < 8, "the walk stopped early: {scanned}");
    }

    #[test]
    fn a_network_share_below_the_root_is_never_entered() {
        let t = tree("netshare");
        let share = t.0.join("photos");
        let cancel = AtomicBool::new(false);
        let mut names = Vec::new();
        walk_skipping(
            std::slice::from_ref(&t.0),
            &query(""),
            true,
            &cancel,
            BATCH_SIZE,
            BATCH_INTERVAL,
            std::slice::from_ref(&share),
            &mut |batch, _| names.extend(batch.into_iter().map(|e| e.name)),
        )
        .unwrap();
        // neither the share nor anything inside it is listed
        assert!(
            !names.iter().any(|n| n == "photos" || n == "2024"),
            "{names:?}"
        );
        assert!(names.iter().any(|n| n == "docs"), "{names:?}");
        // a root that is the share itself is walked: the person opened it
        let mut inside = Vec::new();
        walk_skipping(
            std::slice::from_ref(&share),
            &query(""),
            true,
            &cancel,
            BATCH_SIZE,
            BATCH_INTERVAL,
            std::slice::from_ref(&share),
            &mut |batch, _| inside.extend(batch.into_iter().map(|e| e.name)),
        )
        .unwrap();
        assert!(inside.iter().any(|n| n == "2024"), "{inside:?}");
    }

    #[test]
    fn a_walk_with_no_matches_still_heartbeats() {
        let t = tree("heartbeat");
        let cancel = AtomicBool::new(false);
        let mut heartbeats = 0;
        let mut last_scanned = 0;
        walk_every(
            std::slice::from_ref(&t.0),
            &query("nothing-here-matches"),
            true,
            &cancel,
            BATCH_SIZE,
            Duration::ZERO,
            &mut |batch, scanned| {
                assert!(batch.is_empty());
                heartbeats += 1;
                last_scanned = scanned;
            },
        )
        .unwrap();
        assert!(heartbeats >= 1, "no heartbeat arrived");
        assert!(last_scanned > 0);
    }

    #[test]
    fn system_folders_are_skipped_by_name_and_two_roots_share_one_walk() {
        assert!(skip_dir("node_modules", Some("app")));
        assert!(skip_dir(".GIT", None));
        assert!(skip_dir("$recycle.bin", None));
        assert!(skip_dir("WinSxS", Some("windows")));
        assert!(!skip_dir("WinSxS", Some("backup"))); // only under Windows
        assert!(!skip_dir("src", None));

        let a = tree("roots-a");
        let b = tree("roots-b");
        stdfs::create_dir_all(a.0.join("node_modules").join("pkg")).unwrap();
        stdfs::write(
            a.0.join("node_modules").join("pkg").join("readme.txt"),
            b"x",
        )
        .unwrap();
        let cancel = AtomicBool::new(false);
        let mut names = Vec::new();
        let missing = std::env::temp_dir().join("trove-search-roots-missing");
        let scanned = walk(
            &[missing, a.0.clone(), b.0.clone()],
            &query("readme"),
            true,
            &cancel,
            BATCH_SIZE,
            &mut |batch, _| names.extend(batch.into_iter().map(|e| e.path)),
        )
        .unwrap();
        // one readme per tree; the one under node_modules is never seen
        assert_eq!(names.len(), 2, "{names:?}");
        let a_root = a.0.to_string_lossy().to_string();
        let b_root = b.0.to_string_lossy().to_string();
        assert!(names.iter().any(|p| p.starts_with(&a_root)));
        assert!(names.iter().any(|p| p.starts_with(&b_root)));
        assert!(scanned >= 16, "both trees walked: {scanned}");
    }

    #[test]
    fn a_missing_root_is_an_error() {
        let cancel = AtomicBool::new(false);
        let missing = std::env::temp_dir().join("trove-search-nope-does-not-exist");
        let err = walk(
            std::slice::from_ref(&missing),
            &query(""),
            true,
            &cancel,
            BATCH_SIZE,
            &mut |_, _| {},
        )
        .unwrap_err();
        assert!(err.contains("not a folder"), "{err}");
    }
}

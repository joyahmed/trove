//! Browse an archive like a folder (plan 16, Phase 4): one listing per archive, cached, and the
//! read-only temp copy that "open a file inside" hands to the default app.
//!
//! - `list`: every entry of the archive as `inner` paths (`docs/a.txt`), with the folders that
//!   only appear as part of a longer name made up (`a/b/c.txt` alone gives `a` and `a/b`).
//!   Zip and 7z read their directory only; a tar.* has none, so it is decompressed once.
//! - The cache keys on (path, length, mtime): a changed archive is read again, never served
//!   stale. Four archives at most — a hand-rolled LRU, no crate.
//! - `open_inner`: one entry extracted (through the same safe engine as an extract job) into
//!   `<cache root>/<hash>/name`, made read-only, never overwritten by a second open, and
//!   cleaned by `clean_open_cache` only when old AND untouched since Trove wrote it.

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{Error, ErrorKind, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::job::{self, ExtractJob};
use super::{free_space, safe_path};
use crate::core::transfer::Resolution;

/// One thing inside an archive, as the file list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    /// `/`-separated path inside the archive, no leading or trailing `/`
    pub inner: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

/// macOS Finder's leftovers: the `__MACOSX/` resource-fork folder and `._name` AppleDouble
/// files. Archive Utility hides them; so does Trove (taste Q6).
fn is_mac_junk(parts: &[String]) -> bool {
    parts.first().is_some_and(|p| p == "__MACOSX") || parts.iter().any(|p| p.starts_with("._"))
}

fn time_ms(t: Option<SystemTime>) -> Option<u64> {
    t.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// Read the whole listing of `archive` (no cache). Unsafe names (`../x`, `C:\x`) are left out:
/// nothing could be copied out of them anyway.
pub fn read_index(archive: &Path) -> Result<Vec<IndexEntry>> {
    let mut source = job::open_source(archive, None)?;
    let mut by_inner: BTreeMap<String, IndexEntry> = BTreeMap::new();
    for info in source.entries()? {
        let Ok(parts) = safe_path::entry_parts(&info.name) else {
            continue;
        };
        if is_mac_junk(&parts) {
            continue;
        }
        for depth in 1..parts.len() {
            let folder = parts[..depth].join("/");
            by_inner.entry(folder.clone()).or_insert(IndexEntry {
                inner: folder,
                is_dir: true,
                size: 0,
                modified_ms: None,
            });
        }
        let inner = parts.join("/");
        let entry = IndexEntry {
            inner: inner.clone(),
            is_dir: info.is_dir,
            size: if info.is_dir { 0 } else { info.size },
            modified_ms: time_ms(info.modified),
        };
        // a folder named by its own entry keeps that entry's date; a file listed twice (zip
        // allows it, tar appends updates): the later one is what an extract ends with
        by_inner.insert(inner, entry);
    }
    Ok(by_inner.into_values().collect())
}

/// What makes a cached listing still true: same file, same length, same mtime.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Key {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

fn key_of(archive: &Path) -> Result<Key> {
    let meta = fs::metadata(archive)?;
    Ok(Key {
        path: archive.to_path_buf(),
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

/// The last few listings, most recent first.
pub struct Cache {
    slots: VecDeque<(Key, Arc<Vec<IndexEntry>>)>,
    cap: usize,
}

impl Cache {
    pub const fn new(cap: usize) -> Self {
        Cache {
            slots: VecDeque::new(),
            cap,
        }
    }

    /// The listing of `archive`, from the cache when the file has not changed, else from
    /// `read` (and remembered). A changed archive drops its old listing.
    pub fn get_or_read(
        &mut self,
        archive: &Path,
        read: impl FnOnce(&Path) -> Result<Vec<IndexEntry>>,
    ) -> Result<Arc<Vec<IndexEntry>>> {
        let key = key_of(archive)?;
        if let Some(at) = self.slots.iter().position(|(k, _)| k.path == key.path) {
            let (k, list) = self.slots.remove(at).expect("position is in range");
            if k == key {
                self.slots.push_front((k, Arc::clone(&list)));
                return Ok(list);
            }
        }
        let list = Arc::new(read(archive)?);
        self.slots.push_front((key, Arc::clone(&list)));
        self.slots.truncate(self.cap);
        Ok(list)
    }
}

static CACHE: Mutex<Cache> = Mutex::new(Cache::new(4));

/// The cached listing of `archive`. The lock is held while a tar.* decompresses, so two tabs
/// opening the same big archive read it once, not twice.
pub fn list(archive: &Path) -> Result<Arc<Vec<IndexEntry>>> {
    let mut cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cache.get_or_read(archive, read_index)
}

/// The entries directly inside `inner` (`""` = the archive's top). A missing `inner` is an
/// error, as a missing folder is.
pub fn children<'a>(all: &'a [IndexEntry], inner: &str) -> Result<Vec<&'a IndexEntry>> {
    let inner = inner.trim_matches('/');
    if !inner.is_empty() && !all.iter().any(|e| e.is_dir && e.inner == inner) {
        return Err(Error::new(
            ErrorKind::NotFound,
            format!("No folder \"{inner}\" in this archive"),
        ));
    }
    let prefix = if inner.is_empty() {
        String::new()
    } else {
        format!("{inner}/")
    };
    Ok(all
        .iter()
        .filter(|e| {
            e.inner
                .strip_prefix(&prefix)
                .is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))
        })
        .collect())
}

/// Name of the stamp beside a copy's folder: when Trove wrote the copy (mtime, ms).
fn stamp_of(folder: &Path) -> PathBuf {
    folder.with_extension("stamp")
}

/// The folder an open of (`archive`, `inner`) uses: the same archive, entry and archive mtime
/// always give the same folder, so a second open finds the first copy.
fn open_folder(cache_root: &Path, archive: &Path, inner: &str) -> Result<PathBuf> {
    let modified = fs::metadata(archive)?.modified().ok();
    let mut h = DefaultHasher::new();
    archive.hash(&mut h);
    inner.hash(&mut h);
    modified.hash(&mut h);
    Ok(cache_root.join(format!("{:016x}", h.finish())))
}

/// Extract one file of `archive` to a read-only copy under `cache_root` and return its path.
///
/// ⛔ Edits to that copy are never saved back into the archive, so it is written read-only:
/// the editor then says so on save, instead of the work vanishing with the cache. A copy
/// already there is returned as is — never overwritten, even if the person changed it.
pub fn open_inner(cache_root: &Path, archive: &Path, inner: &str) -> Result<PathBuf> {
    let parts = safe_path::entry_parts(inner)?;
    let name = parts.last().cloned().unwrap_or_default();
    let folder = open_folder(cache_root, archive, inner)?;
    let target = folder.join(&name);
    if fs::symlink_metadata(&target).is_ok() {
        return Ok(target);
    }
    fs::create_dir_all(&folder)?;
    let filter = [parts.join("/")];
    let job = ExtractJob {
        archive,
        dest: &folder,
        filter: Some(&filter),
        resolution: Resolution::Skip,
        free: &free_space,
    };
    let cancel = AtomicBool::new(false);
    let done = job::extract_job(0, &job, &cancel, &|_| {});
    let meta = match fs::symlink_metadata(&target) {
        Ok(m) if m.is_file() => m,
        _ => {
            let _ = fs::remove_dir(&folder);
            let why = done
                .failed
                .first()
                .map(|f| f.error.clone())
                .or(done.error)
                .unwrap_or_else(|| "The file is not in this archive".into());
            return Err(Error::other(why));
        }
    };
    let mut perms = meta.permissions();
    perms.set_readonly(true);
    fs::set_permissions(&target, perms)?;
    let written = time_ms(fs::metadata(&target)?.modified().ok()).unwrap_or(0);
    fs::write(stamp_of(&folder), written.to_string())?;
    Ok(target)
}

/// How old an open-inside copy must be before app start may clean it.
pub const OPEN_CACHE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Remove the open-inside copies older than `max_age` (by their stamp). A file whose mtime is
/// no longer the one Trove wrote was changed by the person: it is KEPT, with its folder.
/// `remove_file` per file and `remove_dir` on what is then empty — never `remove_dir_all`.
/// Returns how many files were removed.
pub fn clean_open_cache(cache_root: &Path, now: SystemTime, max_age: Duration) -> usize {
    let Ok(dir) = fs::read_dir(cache_root) else {
        return 0;
    };
    let mut removed = 0;
    for stamp in dir.filter_map(|e| e.ok()).map(|e| e.path()) {
        if stamp.extension().is_none_or(|e| e != "stamp") {
            continue;
        }
        let old = fs::metadata(&stamp)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age >= max_age);
        if !old {
            continue;
        }
        let written: Option<u64> = fs::read_to_string(&stamp)
            .ok()
            .and_then(|s| s.trim().parse().ok());
        let folder = stamp.with_extension("");
        let mut kept = 0;
        if let Ok(files) = fs::read_dir(&folder) {
            for file in files.filter_map(|e| e.ok()) {
                let path = file.path();
                let meta = match fs::symlink_metadata(&path) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let untouched =
                    meta.is_file() && written.is_some() && time_ms(meta.modified().ok()) == written;
                if !untouched {
                    kept += 1;
                    continue;
                }
                // a read-only file cannot be removed on Windows; it is ours, so lift the flag
                let mut perms = meta.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                perms.set_readonly(false);
                let _ = fs::set_permissions(&path, perms);
                if fs::remove_file(&path).is_ok() {
                    removed += 1;
                } else {
                    kept += 1;
                }
            }
        }
        if kept == 0 {
            let _ = fs::remove_dir(&folder);
            let _ = fs::remove_file(&stamp);
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::archive::job::tests::make_zip;
    use crate::core::archive::test_util::scratch;

    fn names(list: &[IndexEntry]) -> Vec<(String, bool)> {
        list.iter().map(|e| (e.inner.clone(), e.is_dir)).collect()
    }

    #[test]
    fn implicit_folders_appear() {
        let root = scratch("index-implicit");
        let zip = root.join("a.zip");
        make_zip(
            &zip,
            &[
                ("a/b/c.txt", b"c"),
                ("top.txt", b"t"),
                ("__MACOSX/a/._c.txt", b"x"),
                ("._top.txt", b"x"),
            ],
        );
        let list = read_index(&zip).unwrap();
        assert_eq!(
            names(&list),
            vec![
                ("a".into(), true),
                ("a/b".into(), true),
                ("a/b/c.txt".into(), false),
                ("top.txt".into(), false),
            ]
        );
        let top: Vec<_> = children(&list, "")
            .unwrap()
            .iter()
            .map(|e| e.inner.clone())
            .collect();
        assert_eq!(top, vec!["a", "top.txt"]);
        let ab: Vec<_> = children(&list, "a/b")
            .unwrap()
            .iter()
            .map(|e| e.inner.clone())
            .collect();
        assert_eq!(ab, vec!["a/b/c.txt"]);
        assert!(children(&list, "nope").is_err());
        assert_eq!(list[2].size, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn names_with_backslashes_list_as_folders() {
        let root = scratch("index-backslash");
        let zip = root.join("w.zip");
        make_zip(&zip, &[("docs\\notes\\a.txt", b"a"), ("../evil.txt", b"x")]);
        let list = read_index(&zip).unwrap();
        assert_eq!(
            names(&list),
            vec![
                ("docs".into(), true),
                ("docs/notes".into(), true),
                ("docs/notes/a.txt".into(), false),
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_drops_when_archive_changes() {
        let root = scratch("index-cache");
        let zip = root.join("c.zip");
        make_zip(&zip, &[("one.txt", b"1")]);
        let mut cache = Cache::new(4);
        let mut reads = 0;
        let mut read = |p: &Path| {
            reads += 1;
            read_index(p)
        };
        let first = cache.get_or_read(&zip, &mut read).unwrap();
        let again = cache.get_or_read(&zip, &mut read).unwrap();
        assert!(
            Arc::ptr_eq(&first, &again),
            "same archive: served from cache"
        );
        make_zip(&zip, &[("one.txt", b"1"), ("two.txt", b"22")]);
        let f = fs::File::options().write(true).open(&zip).unwrap();
        f.set_modified(SystemTime::now() + Duration::from_secs(5))
            .unwrap();
        drop(f);
        let changed = cache.get_or_read(&zip, &mut read).unwrap();
        assert_eq!(changed.len(), 2);
        assert_eq!(reads, 2);
        // only four archives are remembered
        for i in 0..5 {
            let other = root.join(format!("o{i}.zip"));
            make_zip(&other, &[("x.txt", b"x")]);
            cache.get_or_read(&other, read_index).unwrap();
        }
        assert_eq!(cache.slots.len(), 4);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn open_inner_copy_is_read_only() {
        let root = scratch("open-inner");
        let zip = root.join("o.zip");
        make_zip(&zip, &[("docs/a.txt", b"hello")]);
        let cache = root.join("cache").join("archive-open");
        let copy = open_inner(&cache, &zip, "docs/a.txt").unwrap();
        assert!(copy.starts_with(&cache));
        assert_eq!(copy.file_name().unwrap(), "a.txt");
        assert_eq!(fs::read(&copy).unwrap(), b"hello");
        assert!(fs::metadata(&copy).unwrap().permissions().readonly());
        // a second open finds the same copy and does not write over it
        let again = open_inner(&cache, &zip, "docs/a.txt").unwrap();
        assert_eq!(again, copy);
        assert!(open_inner(&cache, &zip, "docs/missing.txt").is_err());
        assert!(open_inner(&cache, &zip, "../x").is_err());
        let removed = clean_open_cache(&cache, SystemTime::now(), Duration::ZERO);
        assert_eq!(removed, 1);
        assert!(!copy.exists());
        assert!(!copy.parent().unwrap().exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn open_inner_cleanup_keeps_a_modified_copy() {
        let root = scratch("open-keep");
        let zip = root.join("k.zip");
        make_zip(&zip, &[("a.txt", b"a"), ("b.txt", b"b")]);
        let cache = root.join("cache").join("archive-open");
        let changed = open_inner(&cache, &zip, "a.txt").unwrap();
        let fresh = open_inner(&cache, &zip, "b.txt").unwrap();
        // the person saved into it somehow: its mtime is no longer the one Trove wrote
        let mut perms = fs::metadata(&changed).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&changed, perms).unwrap();
        fs::write(&changed, b"my edits").unwrap();
        let f = fs::File::options().write(true).open(&changed).unwrap();
        f.set_modified(SystemTime::now() + Duration::from_secs(60))
            .unwrap();
        drop(f);
        // too young: nothing goes
        assert_eq!(
            clean_open_cache(&cache, SystemTime::now(), OPEN_CACHE_MAX_AGE),
            0
        );
        assert!(fresh.exists());
        let removed = clean_open_cache(&cache, SystemTime::now(), Duration::ZERO);
        assert_eq!(removed, 1);
        assert!(!fresh.exists());
        assert_eq!(fs::read(&changed).unwrap(), b"my edits");
        let _ = fs::remove_dir_all(root);
    }
}

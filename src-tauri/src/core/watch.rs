//! Folder watching for live refresh: one `notify` watcher shared by every open tab, a
//! reference count per folder, a 200 ms debounce so a burst of writes is one event, and
//! "gone" when the watched folder itself disappears. No tauri types; the command layer
//! supplies the sink that emits.

use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

/// A burst of changes inside one folder becomes one `changed` this long after its first event.
pub const DEBOUNCE: Duration = Duration::from_millis(200);
/// How often the thread wakes to check that watched folders still exist (Windows reports
/// nothing when the watched folder itself is renamed while a handle is open).
const EXISTENCE_POLL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    /// Something inside the folder changed; re-read it.
    Changed,
    /// The folder itself was removed or renamed away; the watch is dropped.
    Gone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChanged {
    /// The watched folder, spelled as it was passed to `watch`.
    pub path: String,
    pub kind: ChangeKind,
}

/// Comparison form of a path: no trailing separator, case-folded on Windows.
///
/// Only `/` is a separator off Windows. A backslash there is an ordinary character in a file
/// name, so trimming it would make `a\` and `a` one key; the macOS test that spelled "a second
/// tab, with a trailing separator" as `dir + "\\"` was really naming a folder that does not exist.
fn key_of(path: &str) -> String {
    let separators: &[char] = if cfg!(windows) { &['\\', '/'] } else { &['/'] };
    let trimmed = path.trim_end_matches(separators);
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

fn parent_key(path: &Path) -> Option<String> {
    path.parent().map(|p| key_of(&p.to_string_lossy()))
}

/// The folder spelled the way the OS will spell it in events.
///
/// ⛔ On macOS FSEvents reports the RESOLVED path, so a folder reached through a symlink —
/// `/var/folders/…` is really `/private/var/…`, and so is `/tmp` — never matched its own events
/// and live refresh silently did nothing. Found 2026-10-02 by a `cargo test` on a Mac: three
/// watcher tests timed out, deterministically. The fix is to hand the OS the resolved path in
/// the first place, so every event arrives spelled the way the key is, instead of resolving each
/// event: a removed folder cannot be resolved, and the "gone" case must keep working.
///
/// Windows keeps the path as given. Its events carry the spelling that was passed in, and
/// `canonicalize` would turn `C:\x` into `\\?\C:\x` and break that match.
fn resolve(path: &str) -> String {
    #[cfg(windows)]
    {
        path.to_string()
    }
    #[cfg(not(windows))]
    {
        std::fs::canonicalize(path)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_string())
    }
}

/// The key a folder is stored under: by its resolved spelling, else by the one it was given
/// (a folder that no longer exists cannot be resolved, but it may still be stored).
fn key_for(shared: &Shared, path: &str) -> String {
    let resolved = key_of(&resolve(path));
    if shared.refs.contains_key(&resolved) {
        resolved
    } else {
        key_of(path)
    }
}

/// What one watcher event means for the folder `watched` (a key from `key_of`).
/// The folder itself removed or renamed → `Gone`; a child created / modified / removed /
/// renamed → `Changed`; anything else → `None`.
pub fn classify(event: &Event, watched: &str) -> Option<ChangeKind> {
    let is_self = |p: &Path| key_of(&p.to_string_lossy()) == watched;
    match &event.kind {
        EventKind::Access(_) | EventKind::Other => return None,
        EventKind::Remove(_) if event.paths.iter().any(|p| is_self(p)) => {
            return Some(ChangeKind::Gone)
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From | RenameMode::Any))
            if event.paths.iter().any(|p| is_self(p)) =>
        {
            return Some(ChangeKind::Gone)
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Both))
            if event.paths.first().is_some_and(|p| is_self(p)) =>
        {
            return Some(ChangeKind::Gone)
        }
        _ => {}
    }
    event
        .paths
        .iter()
        .any(|p| parent_key(p).as_deref() == Some(watched))
        .then_some(ChangeKind::Changed)
}

/// The debounce: a key noted once starts a window; `due` hands back the keys whose window
/// has elapsed. Pure, so it is testable without a file system.
#[derive(Default)]
pub struct Debouncer {
    pending: HashMap<String, Instant>,
}

impl Debouncer {
    /// Note a change at `now`; a second note inside an open window is absorbed.
    pub fn note(&mut self, key: &str, now: Instant) {
        self.pending.entry(key.to_string()).or_insert(now);
    }

    pub fn forget(&mut self, key: &str) {
        self.pending.remove(key);
    }

    /// Keys whose window ended by `now`, removed from the pending set.
    pub fn due(&mut self, now: Instant) -> Vec<String> {
        let due: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, since)| now.duration_since(**since) >= DEBOUNCE)
            .map(|(k, _)| k.clone())
            .collect();
        for k in &due {
            self.pending.remove(k);
        }
        due
    }

    /// When the earliest open window ends, if any.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().min().map(|since| *since + DEBOUNCE)
    }
}

struct Entry {
    /// spelled as the caller passed it; what the frontend is told about
    display: String,
    /// spelled as the OS watch was registered, which is what its events will say
    os_path: String,
    count: usize,
}

#[derive(Default)]
struct Shared {
    refs: HashMap<String, Entry>,
    debouncer: Debouncer,
}

/// Every watched folder, reference-counted, behind one OS watcher and one emitting thread.
pub struct Watchers {
    watcher: Arc<Mutex<RecommendedWatcher>>,
    shared: Arc<Mutex<Shared>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Watchers {
    /// Start the watcher and the thread that debounces and emits through `sink`.
    pub fn new(sink: impl Fn(FsChanged) + Send + 'static) -> notify::Result<Self> {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let watcher = RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            notify::Config::default(),
        )?;
        let watcher = Arc::new(Mutex::new(watcher));
        let shared = Arc::new(Mutex::new(Shared::default()));
        {
            let watcher = Arc::clone(&watcher);
            let shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("fs-watch".into())
                .spawn(move || run(&rx, &watcher, &shared, &sink))
                .map_err(notify::Error::io)?;
        }
        Ok(Self { watcher, shared })
    }

    /// Watch `path` (non-recursive); a second call for the same folder only counts.
    pub fn watch(&mut self, path: &str) -> notify::Result<()> {
        let resolved = resolve(path);
        let key = key_of(&resolved);
        let mut shared = lock(&self.shared);
        if let Some(entry) = shared.refs.get_mut(&key) {
            entry.count += 1;
            return Ok(());
        }
        lock(&self.watcher).watch(Path::new(&resolved), RecursiveMode::NonRecursive)?;
        shared.refs.insert(
            key,
            Entry {
                display: path.to_string(),
                os_path: resolved,
                count: 1,
            },
        );
        Ok(())
    }

    /// Drop one reference; the OS watch ends when the last one goes.
    pub fn unwatch(&mut self, path: &str) {
        let mut shared = lock(&self.shared);
        let key = key_for(&shared, path);
        let Some(entry) = shared.refs.get_mut(&key) else {
            return;
        };
        entry.count -= 1;
        if entry.count == 0 {
            let os_path = entry.os_path.clone();
            shared.refs.remove(&key);
            shared.debouncer.forget(&key);
            let _ = lock(&self.watcher).unwatch(Path::new(&os_path));
        }
    }

    /// How many references a folder has; 0 when it is not watched.
    #[cfg(test)]
    pub fn refs(&self, path: &str) -> usize {
        let shared = lock(&self.shared);
        let key = key_for(&shared, path);
        shared.refs.get(&key).map_or(0, |e| e.count)
    }
}

/// The emitting thread: classify events per watched folder, debounce `changed`, emit `gone`
/// at once, and every `EXISTENCE_POLL` confirm each watched folder is still there.
fn run(
    rx: &mpsc::Receiver<notify::Result<Event>>,
    watcher: &Mutex<RecommendedWatcher>,
    shared: &Mutex<Shared>,
    sink: &dyn Fn(FsChanged),
) {
    loop {
        let timeout = lock(shared)
            .debouncer
            .next_deadline()
            .map(|d| d.saturating_duration_since(Instant::now()))
            .unwrap_or(EXISTENCE_POLL)
            .min(EXISTENCE_POLL);
        let now = Instant::now();
        let mut gone: Vec<String> = Vec::new();
        match rx.recv_timeout(timeout) {
            Ok(Ok(event)) => {
                let mut s = lock(shared);
                let keys: Vec<String> = s.refs.keys().cloned().collect();
                for key in keys {
                    match classify(&event, &key) {
                        Some(ChangeKind::Gone) => gone.push(key),
                        Some(ChangeKind::Changed) => s.debouncer.note(&key, now),
                        None => {}
                    }
                }
            }
            // an error names no folder reliably; the existence check below decides
            Ok(Err(_)) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }

        let mut emit: Vec<FsChanged> = Vec::new();
        {
            let mut s = lock(shared);
            for (key, entry) in &s.refs {
                if !gone.contains(key) && !Path::new(&entry.display).is_dir() {
                    gone.push(key.clone());
                }
            }
            for key in &gone {
                if let Some(entry) = s.refs.remove(key) {
                    s.debouncer.forget(key);
                    let _ = lock(watcher).unwatch(Path::new(&entry.os_path));
                    emit.push(FsChanged {
                        path: entry.display,
                        kind: ChangeKind::Gone,
                    });
                }
            }
            for key in s.debouncer.due(Instant::now()) {
                if let Some(entry) = s.refs.get(&key) {
                    emit.push(FsChanged {
                        path: entry.display.clone(),
                        kind: ChangeKind::Changed,
                    });
                }
            }
        }
        for change in emit {
            sink(change);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, RemoveKind};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn event(kind: EventKind, paths: &[&str]) -> Event {
        Event {
            kind,
            paths: paths.iter().map(PathBuf::from).collect(),
            attrs: Default::default(),
        }
    }

    /// A path under a home folder, spelled the way this OS spells it.
    ///
    /// ⛔ These tests were written with `C:\Users\alex\...` literals. On Linux `\` is not a
    /// separator, so each literal is one file name with no parent: no child ever looked like
    /// a child, and `C:\Users\alex\Docs\` kept its trailing `\`. The code was right — the real
    /// inotify events (`Create(File)`, `Modify(Name(From))` on the folder itself,
    /// `Remove(Folder)`) classify correctly; the literals were Windows-only.
    fn home(rest: &[&str]) -> String {
        let root = if cfg!(windows) {
            r"C:\Users\alex"
        } else {
            "/home/alex"
        };
        rest.iter().fold(root.to_string(), |acc, part| {
            format!("{acc}{}{part}", std::path::MAIN_SEPARATOR)
        })
    }

    #[test]
    fn a_child_change_is_changed_and_another_folder_is_nothing() {
        let watched = key_of(&home(&["Docs"]));
        let a = home(&["Docs", "a.txt"]);
        let b = home(&["Docs", "b.txt"]);
        let e = event(EventKind::Create(CreateKind::File), &[&a]);
        assert_eq!(classify(&e, &watched), Some(ChangeKind::Changed));
        let e = event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &[&a, &b],
        );
        assert_eq!(classify(&e, &watched), Some(ChangeKind::Changed));
        let e = event(
            EventKind::Create(CreateKind::File),
            &[&home(&["Other", "a.txt"])],
        );
        assert_eq!(classify(&e, &watched), None);
        let e = event(EventKind::Access(notify::event::AccessKind::Any), &[&a]);
        assert_eq!(classify(&e, &watched), None);
    }

    #[test]
    fn the_watched_folder_removed_or_renamed_is_gone() {
        // spelled with a trailing separator, as a second tab may pass it
        let watched = key_of(&format!("{}{}", home(&["Docs"]), std::path::MAIN_SEPARATOR));
        let e = event(EventKind::Remove(RemoveKind::Folder), &[&home(&["Docs"])]);
        assert_eq!(classify(&e, &watched), Some(ChangeKind::Gone));
        let e = event(
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            &[&home(&["Docs"])],
        );
        assert_eq!(classify(&e, &watched), Some(ChangeKind::Gone));
        // Windows names are case-blind, so `docs` IS the watched folder there; on Linux it is
        // a different folder, and its rename is nothing to us
        let e = event(
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            &[&home(&["docs"])],
        );
        let other_case = if cfg!(windows) {
            Some(ChangeKind::Gone)
        } else {
            None
        };
        assert_eq!(classify(&e, &watched), other_case);
        // a child removed is only a change
        let e = event(
            EventKind::Remove(RemoveKind::File),
            &[&home(&["Docs", "a.txt"])],
        );
        assert_eq!(classify(&e, &watched), Some(ChangeKind::Changed));
    }

    #[test]
    fn debounce_coalesces_a_burst_into_one() {
        let mut d = Debouncer::default();
        let t0 = Instant::now();
        d.note("a", t0);
        d.note("a", t0 + Duration::from_millis(20));
        d.note("b", t0 + Duration::from_millis(150));
        assert!(d.due(t0 + Duration::from_millis(100)).is_empty());
        assert_eq!(d.next_deadline(), Some(t0 + DEBOUNCE));
        assert_eq!(
            d.due(t0 + Duration::from_millis(200)),
            vec!["a".to_string()]
        );
        assert_eq!(d.due(t0 + Duration::from_millis(300)), Vec::<String>::new());
        assert_eq!(
            d.due(t0 + Duration::from_millis(350)),
            vec!["b".to_string()]
        );
        assert_eq!(d.next_deadline(), None);
    }

    // ── against the real file system ─────────────────────────────────────────

    static N: AtomicUsize = AtomicUsize::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "explorer-watch-{}-{}-{}",
            std::process::id(),
            tag,
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn watchers() -> (Watchers, mpsc::Receiver<FsChanged>) {
        let (tx, rx) = mpsc::channel();
        let w = Watchers::new(move |c| {
            let _ = tx.send(c);
        })
        .unwrap();
        (w, rx)
    }

    const WAIT: Duration = Duration::from_secs(3);

    #[test]
    fn a_created_file_arrives_as_one_changed() {
        let dir = scratch("create");
        let dir_s = dir.to_string_lossy().into_owned();
        let (mut w, rx) = watchers();
        w.watch(&dir_s).unwrap();
        std::fs::write(dir.join("a.txt"), b"one").unwrap();
        let got = rx.recv_timeout(WAIT).expect("a change arrives");
        assert_eq!(
            got,
            FsChanged {
                path: dir_s.clone(),
                kind: ChangeKind::Changed
            }
        );
        w.unwatch(&dir_s);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_quick_writes_are_one_changed() {
        let dir = scratch("burst");
        let dir_s = dir.to_string_lossy().into_owned();
        let (mut w, rx) = watchers();
        w.watch(&dir_s).unwrap();
        std::fs::write(dir.join("a.txt"), b"one").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("b.txt"), b"two").unwrap();
        let first = rx.recv_timeout(WAIT).expect("a change arrives");
        assert_eq!(first.kind, ChangeKind::Changed);
        let mut more = 0;
        let until = Instant::now() + Duration::from_millis(600);
        while rx
            .recv_timeout(until.saturating_duration_since(Instant::now()))
            .is_ok()
        {
            more += 1;
        }
        assert_eq!(more, 0, "the burst must coalesce into one event");
        w.unwatch(&dir_s);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn renaming_the_watched_folder_away_is_gone() {
        let dir = scratch("gone");
        let dir_s = dir.to_string_lossy().into_owned();
        let (mut w, rx) = watchers();
        w.watch(&dir_s).unwrap();
        let moved = dir.with_extension("moved");
        let _ = std::fs::remove_dir_all(&moved);
        std::fs::rename(&dir, &moved).unwrap();
        let got = rx.recv_timeout(WAIT).expect("gone arrives");
        assert_eq!(
            got,
            FsChanged {
                path: dir_s.clone(),
                kind: ChangeKind::Gone
            }
        );
        assert_eq!(w.refs(&dir_s), 0, "the watch is dropped");
        let _ = std::fs::remove_dir_all(&moved);
    }

    #[test]
    fn a_second_reference_keeps_the_watch_alive() {
        let dir = scratch("refs");
        let dir_s = dir.to_string_lossy().into_owned();
        let (mut w, rx) = watchers();
        w.watch(&dir_s).unwrap();
        // a second tab, spelled with a trailing separator — the platform's own one
        w.watch(&format!("{dir_s}{}", std::path::MAIN_SEPARATOR))
            .unwrap();
        assert_eq!(w.refs(&dir_s), 2);
        w.unwatch(&dir_s);
        assert_eq!(w.refs(&dir_s), 1);
        std::fs::write(dir.join("a.txt"), b"one").unwrap();
        let got = rx.recv_timeout(WAIT).expect("still watched");
        assert_eq!(got.kind, ChangeKind::Changed);
        w.unwatch(&dir_s);
        assert_eq!(w.refs(&dir_s), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(all(test, unix))]
mod symlink_tests {
    use super::*;
    use std::sync::mpsc;

    /// ⛔ The macOS bug, reproduced without relying on `temp_dir()` happening to sit behind a
    /// symlink: a folder reached THROUGH a symlink must still get its own events.
    #[test]
    fn a_folder_reached_through_a_symlink_still_reports_its_changes() {
        let base = std::env::temp_dir().join(format!("trove-watch-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let (tx, rx) = mpsc::channel();
        let mut w = Watchers::new(move |c| {
            let _ = tx.send(c);
        })
        .unwrap();
        let through_link = link.to_string_lossy().into_owned();
        w.watch(&through_link).unwrap();
        std::fs::write(real.join("a.txt"), b"x").unwrap();
        let got = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("a change arrives for a folder watched through a symlink");
        assert_eq!(got.kind, ChangeKind::Changed);
        // the frontend is told the folder the way it asked, not the resolved spelling
        assert_eq!(got.path, through_link);
        // a second reference and an unwatch work by the spelling it was given
        assert_eq!(w.refs(&through_link), 1);
        w.unwatch(&through_link);
        assert_eq!(w.refs(&through_link), 0);
        let _ = std::fs::remove_dir_all(&base);
    }
}

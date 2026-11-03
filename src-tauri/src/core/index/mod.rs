//! Trove's own file-name index (plan 21C): every name under the home folder and every fixed
//! local drive in memory, kept fresh by a watcher and (Windows) the NTFS change journal, saved
//! to disk, so the palette answers in milliseconds instead of walking the disk.
//!
//! One part per root: the home folder first (its walk is the quickest, ~2 s), then each fixed
//! drive (`drives::fixed_local`), the home folder left out of its drive's walk. The first walks
//! run one at a time, in that order. While a part's first walk runs it is "filling": `search`
//! leaves it out (callers walk that root the old way) and `filling` says how far it has got.
//! No admin, no other program.
//!
//! Saved (plan 21C.2b, 21C.3c): with a store folder set ([`Index::set_store`]) each part loads
//! its saved table at once and serves it, marked stale, then catches up — from the change
//! journal where the drive has one (no walk), else by a walk in the background that swaps in
//! when done. It is saved after the first walk or catch-up, every [`SAVE_EVERY`] while it
//! changes, and on exit ([`Index::save_all`]). A damaged file, or one from another version, is
//! deleted and the part walks again.
//!
//! WSL (plan 21C.4): each **running** distro's `/home` and `/root` as a snapshot of its own
//! ([`Index::refresh_wsl`]), refreshed when over 10 minutes old. A stopped distro is never
//! listed, and its rows are never searched (a look at its share would start it).

pub mod drives;
pub mod folders;
#[cfg(all(test, windows))]
mod measure;
pub mod store;
pub mod table;
#[cfg(windows)]
pub mod usn;
pub mod walk;
pub mod watch;
pub mod wsl;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};

use table::{Table, TOP};
use walk::Skip;

/// The walk's threads (plan 21C: 6.4 s for 1.57 M entries on 8 warm).
pub const WALK_THREADS: usize = 8;
/// How often a part with unsaved changes is written to disk.
pub const SAVE_EVERY: Duration = Duration::from_secs(10 * 60);
/// How often the change journal is read while Trove runs.
#[cfg(windows)]
const JOURNAL_EVERY: Duration = Duration::from_secs(1);
/// How often a part no watcher keeps live is walked again (plan 21C.9b: Linux's `/`, and the
/// home folder once inotify runs out of watches).
pub const REWALK_EVERY: Duration = Duration::from_secs(30 * 60);

/// What keeps a part fresh after its first walk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Live {
    /// `notify` recursive on the root: Windows, and a Mac's FSEvents (one stream, no per-folder
    /// cost)
    Recursive,
    /// a watch of its own on each folder the walk goes into ([`folders`]): Linux's home folder,
    /// where every inotify watch is kernel memory and skipped folders hold most of them
    Folders,
    /// no watcher: walked again every `rewalk_every`
    Off,
}

/// How one part is kept: the watcher, and how often it is walked again while no watcher runs
/// (none started, or one that gave up). `rewalk_every: None` walks again only on lost events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Keep {
    pub live: Live,
    pub rewalk_every: Option<Duration>,
}

impl Keep {
    /// Today's Windows and Mac part: watched whole, walked again only on lost events.
    pub const RECURSIVE: Keep = Keep {
        live: Live::Recursive,
        rewalk_every: None,
    };

    /// The home folder's part: on Linux one inotify watch per folder, walked every 30 min if
    /// those run out.
    fn home() -> Keep {
        if cfg!(target_os = "linux") {
            Keep {
                live: Live::Folders,
                rewalk_every: Some(REWALK_EVERY),
            }
        } else {
            Keep::RECURSIVE
        }
    }

    /// A drive's part: on Linux (`/`) never watched — inotify cannot watch a whole disk, and
    /// fanotify's whole-disk marks need `CAP_SYS_ADMIN` — only walked again every 30 min.
    fn drive() -> Keep {
        if cfg!(target_os = "linux") {
            Keep {
                live: Live::Off,
                rewalk_every: Some(REWALK_EVERY),
            }
        } else {
            Keep::RECURSIVE
        }
    }
}

/// Whether a part walks again now: no watcher keeps it, and `every` has passed since its last
/// walk.
fn rewalk_due(every: Option<Duration>, watching: bool, since_walk: Duration) -> bool {
    !watching && every.is_some_and(|every| since_walk >= every)
}

/// One indexed root: the home folder or a drive.
struct Part {
    root: PathBuf,
    /// what the palette footer calls it: `home`, `D:`
    label: String,
    /// where it stands in line for its first walk
    turn: usize,
    /// `None` until the first walk is done (or a saved table loaded); a re-walk swaps a new
    /// table in
    table: RwLock<Option<Table>>,
    /// names the first walk has read so far
    seen: AtomicUsize,
    /// served from the saved file and not caught up yet: rows may be missing or gone
    stale: AtomicBool,
    /// changed since it was last saved
    dirty: AtomicBool,
    /// (journal id, next USN) the table holds every change before; saved beside the table
    pos: Mutex<Option<(u64, i64)>>,
    /// one save at a time (the part's own thread and `save_all` on exit)
    saving: Mutex<()>,
    keep: Keep,
}

impl Part {
    fn ready(&self) -> bool {
        self.table
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }
}

/// One running WSL distro's snapshot, searched like a part.
struct WslPart {
    /// `taken_at` and the name; `entries` emptied once the table is built
    snap: wsl::Snapshot,
    table: Table,
    /// the folders listed, as Windows paths (`\\wsl.localhost\Ubuntu\home`)
    covers: Vec<PathBuf>,
}

#[derive(Default)]
struct Inner {
    parts: RwLock<Vec<Arc<Part>>>,
    stop: AtomicBool,
    /// The part whose first walk may run now. One at a time: drives share disks, and two walks
    /// at once would each take longer than both in a row.
    turn: Mutex<usize>,
    next: Condvar,
    /// where each part's table is saved; `None` keeps it in memory only
    store: RwLock<Option<PathBuf>>,
    wsl: RwLock<Vec<Arc<WslPart>>>,
    /// the distros last seen running: only their snapshots are searched
    awake: RwLock<Vec<String>>,
    /// a WSL refresh is running
    wsl_busy: AtomicBool,
    /// Held through every walk of a part not watched recursively (Linux): one at a time across
    /// those parts, first walks and re-walks, so a 30-minute timer never stacks a walk on
    /// another. A recursive part (Windows, Mac) never takes it: its re-walks run as before.
    rewalking: Mutex<()>,
    /// tests only: the most folder watches a part may hold; 0 asks the kernel
    #[cfg(test)]
    folder_budget: AtomicUsize,
    /// tests only: while set, the watcher's events are thrown away unread; cleared, the part
    /// walks again as after lost events (a kernel queue overflow, made on purpose)
    #[cfg(test)]
    deaf: AtomicBool,
}

impl Inner {
    /// The file `root`'s table is saved in, when a store folder is set.
    fn file_of(&self, root: &Path) -> Option<PathBuf> {
        let dir = self
            .store
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()?;
        Some(dir.join(file_name(root)))
    }
}

/// `C:\Users\alex` → `C__Users_alex.trvi`: one file per root, the same name every run.
fn file_name(root: &Path) -> String {
    let stem: String = root
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    format!("{stem}.trvi")
}

/// A root still on its first walk, as the palette footer shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Filling {
    pub label: String,
    /// names read so far; 0 while it waits for the walk before it
    pub seen: usize,
}

/// One search hit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub path: PathBuf,
    pub is_dir: bool,
    /// From a WSL snapshot: the caller builds the row from this, never looks at the path on
    /// disk — a look at a distro's share starts it if it stopped since.
    pub snapshot: bool,
}

/// The index, shared by the commands and the threads that keep it.
#[derive(Clone, Default)]
pub struct Index(Arc<Inner>);

/// C.1's name, while a caller on another branch still says it.
#[allow(dead_code, reason = "kept for callers on branches not merged yet")]
pub type HomeIndex = Index;

impl Index {
    /// Save each part's table in `dir` (the app's `index/` folder) and load it from there on
    /// the next start. Call before [`Index::start`] ([`start_with`] does).
    pub fn set_store(&self, dir: PathBuf) {
        *self.0.store.write().unwrap_or_else(|e| e.into_inner()) = Some(dir);
    }

    /// Add `root` behind every root added before it: walk it when its turn comes (or load its
    /// saved table and catch up), then keep watching it, on a thread of its own at background
    /// priority. Returns at once.
    #[cfg(test)]
    pub fn start(&self, root: PathBuf, skip: Skip, threads: usize) {
        self.start_kept(root, skip, threads, Keep::RECURSIVE);
    }

    /// [`Index::start`], kept as `keep` says once walked.
    pub fn start_kept(&self, root: PathBuf, skip: Skip, threads: usize, how: Keep) {
        let part = self.add(root, how);
        let inner = self.0.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("index-{}", part.label))
            .spawn(move || keep(&inner, &part, &skip, threads));
        if let Err(e) = spawned {
            log::warn!("index: could not start: {e}");
        }
    }

    fn add(&self, root: PathBuf, keep: Keep) -> Arc<Part> {
        let mut parts = self.0.parts.write().unwrap_or_else(|e| e.into_inner());
        let part = Arc::new(Part {
            label: drives::label_of(&root),
            root,
            turn: parts.len(),
            table: RwLock::new(None),
            seen: AtomicUsize::new(0),
            stale: AtomicBool::new(false),
            dirty: AtomicBool::new(false),
            pos: Mutex::new(None),
            saving: Mutex::new(()),
            keep,
        });
        parts.push(part.clone());
        part
    }

    /// Only tests stop it; the app keeps it until the process ends.
    #[cfg(test)]
    pub fn stop(&self) {
        self.0.stop.store(true, Ordering::Relaxed);
        self.0.next.notify_all();
    }

    fn parts(&self) -> Vec<Arc<Part>> {
        self.0
            .parts
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The WSL snapshots of the distros last seen running.
    fn awake_wsl(&self) -> Vec<Arc<WslPart>> {
        let awake = self.0.awake.read().unwrap_or_else(|e| e.into_inner());
        self.0
            .wsl
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|w| wsl::is_running(&w.snap.distro, &awake))
            .cloned()
            .collect()
    }

    /// The folders whose every name the index holds now: the parts done with their first walk
    /// (or served from disk), then the running distros' snapshot folders.
    pub fn roots(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = self
            .parts()
            .into_iter()
            .filter(|p| p.ready())
            .map(|p| p.root.clone())
            .collect();
        for w in self.awake_wsl() {
            roots.extend(w.covers.iter().cloned());
        }
        roots
    }

    /// The first root ready (the home folder, once walked): C.1's one-root answer.
    #[allow(
        dead_code,
        reason = "C.1's API, kept for callers on branches not merged yet"
    )]
    pub fn root(&self) -> Option<PathBuf> {
        self.roots().into_iter().next()
    }

    /// The roots still on their first walk, in walk order.
    pub fn filling(&self) -> Vec<Filling> {
        self.parts()
            .into_iter()
            .filter(|p| !p.ready())
            .map(|p| Filling {
                label: p.label.clone(),
                seen: p.seen.load(Ordering::Relaxed),
            })
            .collect()
    }

    /// The roots served from their saved file and not caught up yet (`home`, `D:`).
    pub fn stale(&self) -> Vec<String> {
        self.parts()
            .into_iter()
            .filter(|p| p.ready() && p.stale.load(Ordering::Relaxed))
            .map(|p| p.label.clone())
            .collect()
    }

    /// The best `max` hits for `text` over every ready root and running distro, and the total
    /// that matched. `None` while no root is ready yet.
    ///
    /// Each table ranks its own rows (`Table::search_or_fuzzy`: fuzzy only when the text itself
    /// is in no name there); across tables the merge puts every substring hit before any fuzzy
    /// one, then goes by name tier (exact, starts with, a word starts with, anywhere), then by
    /// place in its own table's order — so a table's cache-folder rows, which it ranks last,
    /// stay behind another table's good ones.
    pub fn search(&self, text: &str, max: usize) -> Option<(Vec<Hit>, usize)> {
        let lower = text.trim().to_lowercase();
        let mut any = false;
        let mut total = 0;
        let mut found: Vec<(Rank, Hit)> = Vec::new();
        for part in self.parts() {
            let table = part.table.read().unwrap_or_else(|e| e.into_inner());
            if let Some(t) = table.as_ref() {
                any = true;
                total += collect(t, text, &lower, max, false, &mut found);
            }
        }
        for w in self.awake_wsl() {
            any = true;
            total += collect(&w.table, text, &lower, max, true, &mut found);
        }
        if !any {
            return None;
        }
        // stable: on a tie the earlier part (the home folder) keeps its place
        found.sort_by_key(|(rank, _)| *rank);
        found.truncate(max);
        Some((found.into_iter().map(|(_, h)| h).collect(), total))
    }

    /// Write every part with unsaved changes to the store folder now (the app calls this on
    /// exit). Blocks until done.
    pub fn save_all(&self) {
        for part in self.parts() {
            if part.dirty.load(Ordering::Relaxed) {
                save_part(&self.0, &part);
            }
        }
    }

    /// Forget: drop every part and WSL snapshot and turn saving off, so the 10-minute save and
    /// the exit save write nothing back over files the user just deleted. The walkers stop; the
    /// index starts again on the next launch, per the settings.
    pub fn forget(&self) {
        self.0.stop.store(true, Ordering::Relaxed);
        self.0.next.notify_all();
        *self.0.store.write().unwrap_or_else(|e| e.into_inner()) = None;
        self.0
            .parts
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.0
            .wsl
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.0
            .awake
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// Bring the WSL snapshots up to date for `asked`, the distros the palette saw running
    /// (plan 21C.4b: when the palette opens). Only a distro also in `wsl.exe`'s own running list
    /// now is listed, and only when it has no snapshot or one over 10 minutes old. Returns at
    /// once; the listing runs on a thread of its own.
    pub fn refresh_wsl(&self, asked: Vec<String>) {
        // a distro the palette no longer sees running is left out of search at once
        self.0
            .awake
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|d| wsl::is_running(d, &asked));
        if asked.is_empty() || self.0.wsl_busy.swap(true, Ordering::AcqRel) {
            return;
        }
        let inner = self.0.clone();
        let spawned = std::thread::Builder::new()
            .name("index-wsl".into())
            .spawn(move || {
                refresh_wsl_now(&inner, &asked, &wsl::running_distros());
                inner.wsl_busy.store(false, Ordering::Release);
            });
        if let Err(e) = spawned {
            self.0.wsl_busy.store(false, Ordering::Release);
            log::warn!("index: could not start the WSL refresh: {e}");
        }
    }
}

/// Merge key: substring before fuzzy, then name tier, then place in its own table.
type Rank = (bool, u8, usize);

/// One table's best `max` for `text` into `found`; returns how many matched there.
fn collect(
    t: &Table,
    text: &str,
    lower: &str,
    max: usize,
    snapshot: bool,
    found: &mut Vec<(Rank, Hit)>,
) -> usize {
    let (rows, n, fuzzy) = t.search_or_fuzzy(text, max);
    found.extend(rows.into_iter().enumerate().map(|(at, r)| {
        // a fuzzy hit has no tier: its letters are spread out
        let tier = if fuzzy { 4 } else { tier(t.name(r), lower) };
        (
            (fuzzy, tier, at),
            Hit {
                path: t.path_of(r),
                is_dir: t.is_dir(r),
                snapshot,
            },
        )
    }));
    n
}

/// How well a name matches, for the merge across tables: 0 the name is the text, 1 it starts
/// with it, 2 a word in it does, 3 anywhere. `Table::search` ranks within one table alike.
fn tier(name: &str, text: &str) -> u8 {
    let name = name.to_lowercase();
    let first = text.split_whitespace().next().unwrap_or("");
    if name == text {
        0
    } else if name.starts_with(first) {
        1
    } else if name
        .match_indices(first)
        .any(|(i, _)| !name[..i].ends_with(char::is_alphanumeric))
    {
        2
    } else {
        3
    }
}

/// The distros of `asked` to list now: running per `wsl.exe` too, with no snapshot or a stale
/// one. ⛔ A stopped distro is never in it: listing would boot it (plan 21C, the 81 s row).
fn wsl_to_list(
    asked: &[String],
    running: &[String],
    have: &[Arc<WslPart>],
    now: Instant,
) -> Vec<String> {
    asked
        .iter()
        .filter(|d| wsl::is_running(d, asked))
        .filter(|d| {
            let current = have
                .iter()
                .find(|w| w.snap.distro.eq_ignore_ascii_case(d))
                .map(|w| &w.snap);
            wsl::needs_refresh(d, running, current, now)
        })
        .cloned()
        .collect()
}

fn refresh_wsl_now(inner: &Inner, asked: &[String], running: &[String]) {
    walk::lower_priority();
    // searched from now: asked by the palette and running per wsl.exe
    *inner.awake.write().unwrap_or_else(|e| e.into_inner()) = asked
        .iter()
        .filter(|d| wsl::is_running(d, running))
        .cloned()
        .collect();
    let have = inner.wsl.read().unwrap_or_else(|e| e.into_inner()).clone();
    for distro in wsl_to_list(asked, running, &have, Instant::now()) {
        let started = Instant::now();
        match wsl::snapshot(&distro, &[], running) {
            Ok(mut snap) => {
                let (table, covers) = wsl_table(&distro, &snap.entries);
                log::info!(
                    "index: WSL {distro} {} rows in {} ms",
                    table.len(),
                    started.elapsed().as_millis()
                );
                snap.entries = Vec::new();
                let fresh = Arc::new(WslPart {
                    snap,
                    table,
                    covers,
                });
                let mut all = inner.wsl.write().unwrap_or_else(|e| e.into_inner());
                all.retain(|w| !w.snap.distro.eq_ignore_ascii_case(&distro));
                all.push(fresh);
            }
            Err(e) => log::info!("index: WSL {distro} not listed: {e:?}"),
        }
    }
}

/// A distro's listing as a table rooted at its share (`\\wsl.localhost\<distro>\`), and the
/// top folders it holds (`/home`, `/root`) as Windows paths. `find` lists a folder before what
/// is in it; a row whose folder was not listed (unreadable) is left out.
fn wsl_table(distro: &str, entries: &[wsl::WslEntry]) -> (Table, Vec<PathBuf>) {
    let root = PathBuf::from(crate::core::wsl::root_of(distro));
    let mut t = Table::new(root.clone());
    let mut folders: HashMap<&str, u32> = HashMap::new();
    let mut covers = Vec::new();
    for e in entries {
        let path = e.path.trim_end_matches('/');
        let Some((parent, name)) = path.rsplit_once('/') else {
            continue;
        };
        let parent_row = if parent.is_empty() {
            TOP
        } else {
            match folders.get(parent) {
                Some(&row) => row,
                None => continue,
            }
        };
        let is_dir = e.kind == wsl::Kind::Dir;
        if let Some(row) = t.insert(parent_row, name, is_dir) {
            if is_dir {
                folders.insert(path, row);
                if parent_row == TOP {
                    covers.push(root.join(name));
                }
            }
        }
    }
    (t, covers)
}

/// The change journal of one part's drive (plan 21C.3c). Windows only; elsewhere it does
/// nothing and every restart walks again.
#[cfg(windows)]
#[derive(Default)]
struct Journal {
    tail: Option<usn::UsnTail>,
    /// rows the journal says are gone or moved, but whose id has no row (see `apply_journal`)
    ghosts: usize,
}

#[cfg(not(windows))]
#[derive(Default)]
struct Journal;

/// More rows left behind than this, and the part walks again.
#[cfg_attr(not(windows), allow(dead_code))]
fn ghost_limit(rows: usize) -> usize {
    (rows / 100).max(2_000)
}

#[cfg(windows)]
impl Journal {
    /// Resume from the saved position and apply what changed while Trove was closed. `true`
    /// when the table is now current and needs no walk. The journal wrapped past the saved
    /// position or was made again (`Wrapped`), the drive has none (`NoJournal`), or reading it is
    /// refused (`NoAccess`): `false`, walk again.
    fn catch_up(&mut self, part: &Part, saved: Option<(u64, i64)>, skip: &Skip) -> bool {
        let Some((id, at)) = saved else {
            log::info!(
                "index: {} has no saved journal position, walking",
                part.label
            );
            return false;
        };
        let mut tail = match usn::UsnTail::resume(&part.root, id, at) {
            Ok(tail) => tail,
            Err(e) => {
                log::info!("index: {} walks again: {e}", part.label);
                return false;
            }
        };
        let started = Instant::now();
        let events = match tail.read() {
            Ok(events) => events,
            Err(e) => {
                log::info!("index: {} walks again: {e}", part.label);
                return false;
            }
        };
        let (done, rows) = {
            let mut table = part.table.write().unwrap_or_else(|e| e.into_inner());
            let Some(t) = table.as_mut() else {
                return false;
            };
            // nothing else saw these: deletes and renames read here may leave rows behind
            (apply_journal(t, &events, skip, false), t.len())
        };
        self.tail = Some(tail);
        self.publish(part);
        part.dirty.store(true, Ordering::Relaxed);
        log::info!(
            "index: {} caught up {} changes from the journal in {} ms: {} applied, {} ignored, {} rows left behind",
            part.label,
            events.len(),
            started.elapsed().as_millis(),
            done.applied,
            done.ignored,
            done.ghosts
        );
        if done.ghosts > ghost_limit(rows) {
            log::info!(
                "index: {} walks again: too many rows left behind",
                part.label
            );
            return false;
        }
        true
    }

    /// Tail the journal from now, before a walk: what changes during it is read after.
    fn start(&mut self, part: &Part) {
        self.ghosts = 0;
        if self.tail.is_none() {
            match usn::UsnTail::open(&part.root) {
                Ok(tail) => {
                    log::info!(
                        "index: {} tails the journal, names in records: {}",
                        part.label,
                        tail.has_names()
                    );
                    self.tail = Some(tail);
                }
                // the watcher alone keeps it; the next start walks again
                Err(e) => log::info!("index: {} has no journal tail: {e}", part.label),
            }
        }
    }

    /// The journal's position into `part`, for the next save.
    fn publish(&self, part: &Part) {
        *part.pos.lock().unwrap_or_else(|e| e.into_inner()) =
            self.tail.as_ref().map(|t| (t.journal().id, t.next_usn()));
    }

    /// Apply what the journal has since the last read. `true` when the part must walk again.
    fn drain(&mut self, part: &Part, skip: &Skip, watching: bool) -> bool {
        let Some(tail) = self.tail.as_mut() else {
            return false;
        };
        match tail.read() {
            Ok(events) if events.is_empty() => {}
            Ok(events) => {
                let mut table = part.table.write().unwrap_or_else(|e| e.into_inner());
                if let Some(t) = table.as_mut() {
                    self.ghosts += apply_journal(t, &events, skip, watching).ghosts;
                    part.dirty.store(true, Ordering::Relaxed);
                    if self.ghosts > ghost_limit(t.len()) {
                        drop(table);
                        self.publish(part);
                        log::info!(
                            "index: {} walks again: too many rows left behind",
                            part.label
                        );
                        return true;
                    }
                }
            }
            Err(usn::UsnError::Wrapped) => {
                log::info!("index: {} journal moved on, walking again", part.label);
                self.tail = None;
                self.publish(part);
                return true;
            }
            Err(e) => {
                log::warn!("index: {} stops reading the journal: {e}", part.label);
                self.tail = None;
            }
        }
        self.publish(part);
        false
    }
}

#[cfg(not(windows))]
impl Journal {
    fn catch_up(&mut self, _: &Part, _: Option<(u64, i64)>, _: &Skip) -> bool {
        false
    }
    fn start(&mut self, _: &Part) {}
    #[allow(dead_code)]
    fn drain(&mut self, _: &Part, _: &Skip, _: bool) -> bool {
        false
    }
}

/// What one batch of journal events did to a part's table.
#[cfg(windows)]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Applied {
    /// events that changed (or confirmed) a row of this part
    applied: usize,
    /// events this part never indexed: under a skipped folder, outside its root (the journal is
    /// the whole drive's), a folder whose parent it does not know, or already followed live
    ignored: usize,
    /// events inside this part whose id has no row: the old row may stay (see `apply_journal`)
    ghosts: usize,
}

/// Apply journal events to `t`; returns how many were applied, ignored and left behind.
///
/// Rows are found by file id (`Table::row_by_id`; the walk records every row's id). A create
/// comes with the path the file has now (`OpenFileById`) and is added as the watcher would
/// (`watch::apply`: skip list, a folder walked whole), its id recorded. A rename moves the row
/// its id names, children and all, to the path it has now — or drops it when that path is gone,
/// outside the root or skipped. A delete drops the row its id names.
///
/// ⚠️ An id with no row (a row the watcher added before the journal saw it) cannot be followed:
/// its old row may stay. That is harmless at search time — `index_search` drops a hit no longer
/// on disk — but such rows are counted as ghosts, and past `ghost_limit` the part walks again.
/// Only an event this part would have indexed counts (`in_part`): the journal is the whole
/// drive's, so a delete under `target/`, `node_modules`, another part's folder or outside the
/// root is ignored, not a ghost. When `watching`, the folder watcher already removed them live,
/// so nothing is counted. A delete of a file made in the same batch never had a row.
#[cfg(windows)]
fn apply_journal(t: &mut Table, events: &[usn::Event], skip: &Skip, watching: bool) -> Applied {
    use notify::event::{CreateKind, EventKind, ModifyKind, RenameMode};
    use usn::Change;
    let made: std::collections::HashSet<u128> = events
        .iter()
        .filter(|e| e.change == Change::Created)
        .map(|e| e.id)
        .collect();
    // the root's own id, looked up once and only when an event needs it
    let mut root_id: Option<Option<u128>> = None;
    let mut out = Applied::default();
    for e in events {
        let known = t.row_by_id(e.id);
        match (e.change, known, &e.path) {
            (Change::Deleted, Some(row), _) | (Change::Renamed, Some(row), None) => {
                t.remove(row);
                out.applied += 1;
                continue;
            }
            (Change::Renamed, Some(row), Some(to)) => {
                let from = t.path_of(row);
                let both = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
                watch::apply(
                    t,
                    &notify::Event::new(both).add_path(from).add_path(to.clone()),
                    skip,
                );
                set_id_at(t, to, e.id);
                out.applied += 1;
                continue;
            }
            (Change::Created | Change::Renamed, None, Some(path)) => {
                let create = EventKind::Create(CreateKind::Any);
                watch::apply(t, &notify::Event::new(create).add_path(path.clone()), skip);
                set_id_at(t, path, e.id);
            }
            _ => {}
        }
        let ghost = !watching
            && matches!(e.change, Change::Deleted | Change::Renamed)
            && !made.contains(&e.id)
            && in_part(t, e, skip, &mut root_id);
        if ghost {
            out.ghosts += 1;
        } else if e.path.as_ref().is_some_and(|p| t.row_of(p).is_some()) {
            out.applied += 1;
        } else {
            out.ignored += 1;
        }
    }
    out
}

/// Whether this part would have indexed the file event `e` names: where it is now is under the
/// root and not skipped, or (a delete has no path) its folder is the root or a row of `t` and
/// its own name, when the record has one, is not a skipped folder. `root_id` caches the root's
/// file id across one batch.
#[cfg(windows)]
fn in_part(t: &Table, e: &usn::Event, skip: &Skip, root_id: &mut Option<Option<u128>>) -> bool {
    if let Some(path) = &e.path {
        return !skip.covers(t.root(), path);
    }
    let parent = match t.row_by_id(e.parent) {
        Some(row) => row,
        None => {
            let root = *root_id.get_or_insert_with(|| usn::file_id(t.root()).ok());
            if root != Some(e.parent) {
                return false;
            }
            TOP
        }
    };
    match &e.name {
        Some(name) => !skip.covers(t.root(), &t.path_of(parent).join(name)),
        None => true,
    }
}

/// Record file id `id` on the row at `path`, if the table holds one there.
#[cfg(windows)]
fn set_id_at(t: &mut Table, path: &Path, id: u128) {
    if let Some(row) = t.row_of(path).filter(|&r| r != TOP) {
        t.set_id(row, id);
    }
}

/// Load `part`'s saved table and serve it at once, marked stale. `Some(position)` when a table
/// was loaded (the position `None` when no journal one was saved). A file that is damaged, from
/// another version or for another folder is deleted.
fn load_saved(file: &Path, part: &Part) -> Option<Option<(u64, i64)>> {
    let started = Instant::now();
    match store::load(file) {
        Ok(t) if t.root() == part.root => {
            log::info!(
                "index: {} loaded {} rows from disk in {} ms",
                part.label,
                t.len(),
                started.elapsed().as_millis()
            );
            *part.table.write().unwrap_or_else(|e| e.into_inner()) = Some(t);
            part.stale.store(true, Ordering::Relaxed);
            let pos = read_pos(&pos_file(file));
            *part.pos.lock().unwrap_or_else(|e| e.into_inner()) = pos;
            Some(pos)
        }
        Ok(_) => {
            log::info!("index: {} saved file is for another folder", part.label);
            forget(file);
            None
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            log::warn!(
                "index: {} saved file refused, walking again: {e}",
                part.label
            );
            forget(file);
            None
        }
    }
}

fn forget(file: &Path) {
    let _ = std::fs::remove_file(file);
    let _ = std::fs::remove_file(pos_file(file));
}

/// The journal position beside a table file: `C__.usn`.
fn pos_file(file: &Path) -> PathBuf {
    file.with_extension("usn")
}

const POS_MAGIC: &[u8; 4] = b"TRVU";

fn read_pos(file: &Path) -> Option<(u64, i64)> {
    let b = std::fs::read(file).ok()?;
    if b.len() != 20 || &b[..4] != POS_MAGIC {
        return None;
    }
    let id = u64::from_le_bytes(b[4..12].try_into().ok()?);
    let next = i64::from_le_bytes(b[12..20].try_into().ok()?);
    Some((id, next))
}

fn write_pos(file: &Path, pos: Option<(u64, i64)>) {
    let file = pos_file(file);
    let Some((id, next)) = pos else {
        let _ = std::fs::remove_file(&file);
        return;
    };
    let mut b = Vec::with_capacity(20);
    b.extend_from_slice(POS_MAGIC);
    b.extend_from_slice(&id.to_le_bytes());
    b.extend_from_slice(&next.to_le_bytes());
    if let Err(e) = std::fs::write(&file, b) {
        log::warn!("index: could not save the journal position: {e}");
    }
}

/// Write `part`'s table (and its journal position) to the store folder.
fn save_part(inner: &Inner, part: &Part) {
    let Some(file) = inner.file_of(&part.root) else {
        return;
    };
    let _one = part.saving.lock().unwrap_or_else(|e| e.into_inner());
    // the position before the rows: a change between the two is read again, never skipped
    let pos = *part.pos.lock().unwrap_or_else(|e| e.into_inner());
    part.dirty.store(false, Ordering::Relaxed);
    let table = part.table.read().unwrap_or_else(|e| e.into_inner());
    let Some(t) = table.as_ref() else {
        return;
    };
    let started = Instant::now();
    // the table first: a position newer than the rows would skip changes
    match store::save(t, &file) {
        Ok(()) => {
            write_pos(&file, pos);
            log::info!(
                "index: {} saved {} rows in {} ms, {} KB",
                part.label,
                t.len(),
                started.elapsed().as_millis(),
                std::fs::metadata(&file).map_or(0, |m| m.len() / 1024)
            );
        }
        Err(e) => {
            part.dirty.store(true, Ordering::Relaxed);
            log::warn!("index: {} not saved: {e}", part.label);
        }
    }
}

/// Wait for `part`'s turn at its first walk; `false` when stopped while waiting.
fn wait_turn(inner: &Inner, part: &Part) -> bool {
    let mut turn = inner.turn.lock().unwrap_or_else(|e| e.into_inner());
    while *turn < part.turn {
        if inner.stop.load(Ordering::Relaxed) {
            return false;
        }
        turn = inner
            .next
            .wait_timeout(turn, Duration::from_millis(250))
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
    true
}

/// The part after `part` may start its first walk.
fn pass_turn(inner: &Inner, part: &Part) {
    let mut turn = inner.turn.lock().unwrap_or_else(|e| e.into_inner());
    *turn = (*turn).max(part.turn + 1);
    inner.next.notify_all();
}

/// The watcher a part runs. Dropped, it gives its watches back to the kernel.
enum Watch {
    None,
    Recursive(
        #[allow(dead_code, reason = "held, never read: dropping it stops the watch")]
        notify::RecommendedWatcher,
    ),
    Folders(folders::Folders<notify::RecommendedWatcher>),
}

impl Watch {
    /// Start what `live` asks for on `root`, events into `tx`. `None` when it cannot start: the
    /// part is then walked on its timer, if it has one.
    fn start(
        live: Live,
        part: &Part,
        skip: &Skip,
        tx: mpsc::Sender<notify::Result<notify::Event>>,
        #[cfg(test)] budget_override: &AtomicUsize,
    ) -> Watch {
        let root = part.root.as_path();
        if live == Live::Off {
            return Watch::None;
        }
        let w = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(e) => {
                log::warn!("index: no live updates: {e}");
                return Watch::None;
            }
        };
        if live == Live::Recursive {
            let mut w = w;
            return match w.watch(root, RecursiveMode::Recursive) {
                Ok(()) => Watch::Recursive(w),
                Err(e) => {
                    log::warn!("index: no live updates: {e}");
                    log::debug!("index: no live updates for {}: {e}", root.display());
                    Watch::None
                }
            };
        }
        let started = Instant::now();
        #[cfg(test)]
        let budget = match budget_override.load(Ordering::Relaxed) {
            0 => folders::budget(),
            n => n,
        };
        #[cfg(not(test))]
        let budget = folders::budget();
        let mut f = folders::Folders::new(w, root, budget);
        match f.add_tree(root, skip) {
            Ok(()) => {
                log::info!(
                    "index: {} watching {} folders, {} ms",
                    part.label,
                    f.len(),
                    started.elapsed().as_millis()
                );
                Watch::Folders(f)
            }
            Err(full) => {
                gave_up(part, full);
                Watch::None
            }
        }
    }

    fn on(&self) -> bool {
        !matches!(self, Watch::None)
    }
}

/// Said once per part: its folder watches ran out (or its root was gone), so it is walked on
/// its timer instead.
fn gave_up(part: &Part, full: folders::Full) {
    let why = match full {
        folders::Full::Gone => "nothing left to watch: the folder was removed",
        folders::Full::Budget | folders::Full::Kernel => {
            "the inotify watch limit, fs.inotify.max_user_watches"
        }
    };
    log::warn!(
        "index: {} live updates off ({full:?}: {why}); walking it again every {} min instead",
        part.label,
        part.keep.rewalk_every.unwrap_or(REWALK_EVERY).as_secs() / 60
    );
}

/// A part's thread: load its saved table (served at once), wait its turn, catch up from the
/// journal or walk, swap the table in, save it, then apply the watcher's and the journal's
/// events until stopped. Lost events (`notify` overflowed, the journal wrapped) mean one more
/// walk. The folder watcher runs on every drive: it removes a row the journal cannot find by
/// file id (see `apply_journal`), and it is the only live source on a drive with no journal.
/// A part no watcher keeps (Linux's `/`, or a home folder whose inotify watches ran out) is
/// walked again every `keep.rewalk_every` instead (plan 21C.9b).
fn keep(inner: &Inner, part: &Part, skip: &Skip, threads: usize) {
    walk::lower_priority();
    let saved = inner
        .file_of(&part.root)
        .and_then(|file| load_saved(&file, part));
    // the watcher waits too: one started now would queue a drive's events for minutes
    if !wait_turn(inner, part) {
        return;
    }
    let root = part.root.as_path();
    let (tx, rx) = mpsc::channel();
    // started BEFORE the walk: what changes while it runs is queued, then applied over it
    let mut watch = Watch::start(
        part.keep.live,
        part,
        skip,
        tx,
        #[cfg(test)]
        &inner.folder_budget,
    );
    #[cfg_attr(not(windows), allow(unused_variables, unused_mut))]
    let mut watching = watch.on();
    #[cfg_attr(not(windows), allow(clippy::default_constructed_unit_structs))]
    let mut journal = Journal::default();
    let mut walk_now = match saved {
        Some(pos) => !journal.catch_up(part, pos, skip),
        None => true,
    };
    let mut first = true;
    loop {
        if walk_now {
            // one walk at a time across the Linux parts, a first walk too (its `turn` does not
            // wait for a re-walk); a recursive part (Windows, Mac) never waits, as before
            let _one = (part.keep.live != Live::Recursive)
                .then(|| inner.rewalking.lock().unwrap_or_else(|e| e.into_inner()));
            if !first {
                // events were lost and the queue was drained unread: a folder removed, moved
                // or made since has a watch that is stale or missing, so every watch is set
                // again from what is on disk now
                if let Watch::Folders(f) = &mut watch {
                    if let Err(full) = f.rewatch(skip) {
                        gave_up(part, full);
                        watch = Watch::None;
                    }
                }
            }
            journal.start(part);
            let started = Instant::now();
            let fresh = walk::walk_counting(root, skip, threads, &inner.stop, &part.seen);
            if inner.stop.load(Ordering::Relaxed) {
                return;
            }
            if fresh.is_empty() {
                log::warn!("index: nothing readable under the root");
                log::debug!("index: nothing readable under {}", root.display());
            }
            log::info!(
                "index: {} {} rows in {} ms, {} KB, {} names with their own case",
                part.label,
                fresh.len(),
                started.elapsed().as_millis(),
                fresh.bytes() / 1024,
                fresh.cased()
            );
            *part.table.write().unwrap_or_else(|e| e.into_inner()) = Some(fresh);
            #[cfg(windows)]
            journal.publish(part);
            part.dirty.store(true, Ordering::Relaxed);
        }
        first = false;
        part.stale.store(false, Ordering::Relaxed);
        pass_turn(inner, part);
        // after the first walk or catch-up, and after each re-walk
        save_part(inner, part);
        walk_now = true;
        let walked_at = Instant::now();
        let mut saved_at = Instant::now();
        #[cfg(windows)]
        let mut read_at = Instant::now();
        #[cfg(test)]
        let mut was_deaf = false;
        let timed = loop {
            match rx.recv_timeout(Duration::from_millis(250)) {
                #[cfg(test)]
                Ok(Ok(_)) if inner.deaf.load(Ordering::Relaxed) => was_deaf = true,
                Ok(Ok(event)) => {
                    // a new folder is watched before the table lists it
                    if let Watch::Folders(f) = &mut watch {
                        if let Err(full) = f.follow(&event, skip) {
                            gave_up(part, full);
                            // the folders it could not watch are walked
                            watch = Watch::None;
                            break false;
                        }
                    }
                    let mut table = part.table.write().unwrap_or_else(|e| e.into_inner());
                    if let Some(t) = table.as_mut() {
                        part.dirty.store(true, Ordering::Relaxed);
                        if watch::apply(t, &event, skip) {
                            break false;
                        }
                    }
                }
                Ok(Err(e)) => log::warn!("index: watcher error: {e}"),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    // no watcher: the journal (if any) keeps it, deletes counted as left behind
                    #[cfg(windows)]
                    {
                        watching = false;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
            if inner.stop.load(Ordering::Relaxed) {
                return;
            }
            #[cfg(test)]
            if was_deaf && !inner.deaf.load(Ordering::Relaxed) {
                break false;
            }
            #[cfg(windows)]
            if read_at.elapsed() >= JOURNAL_EVERY {
                read_at = Instant::now();
                if journal.drain(part, skip, watching) {
                    break false;
                }
            }
            if part.dirty.load(Ordering::Relaxed) && saved_at.elapsed() >= SAVE_EVERY {
                save_part(inner, part);
                saved_at = Instant::now();
            }
            if rewalk_due(part.keep.rewalk_every, watch.on(), walked_at.elapsed()) {
                break true;
            }
        };
        if timed {
            log::info!("index: {} walking again on its timer", part.label);
        } else {
            log::info!("index: the watcher lost events, walking again");
        }
        log::debug!("index: walking {} again", root.display());
        // what is queued now is covered by the walk about to start
        while rx.try_recv().is_ok() {}
    }
}

/// What the app starts the index with (its settings, plan 21C.5). Plain values: lib.rs fills
/// them from `index_settings`.
pub struct Startup {
    /// the home folder, walked first as a part of its own
    pub home: Option<PathBuf>,
    /// the drives to walk (fixed local, minus the ones turned off)
    pub drives: Vec<PathBuf>,
    /// folders left out of every walk, on top of `Skip::defaults`
    pub skip_folders: Vec<PathBuf>,
    /// Index off: nothing is walked, loaded or watched; `search` answers `None`.
    pub enabled: bool,
    /// where the tables are saved (`<app data>/index`); `None` keeps them in memory only
    pub index_dir: Option<PathBuf>,
    /// Mac: the privacy-guarded folders under the home folder (`core::privacy_folders`). The
    /// home folder's walk never enters one: reading inside raises a prompt. Empty elsewhere.
    pub guarded: Vec<PathBuf>,
    /// The guarded folders the person has opened in Trove: each walked as a part of its own.
    pub opened: Vec<PathBuf>,
}

/// Start the index the app keeps (plan 21C.2a): the home folder, then each drive, each
/// drive's walk leaving the home folder out (its own part walks and watches it).
pub fn start_with(index: &Index, s: Startup) {
    if !s.enabled {
        log::info!("index: turned off");
        return;
    }
    if let Some(dir) = s.index_dir {
        index.set_store(dir);
    }
    let skip = || {
        s.skip_folders
            .iter()
            .fold(Skip::defaults(), |k, f| k.and_folder(f.clone()))
    };
    if let Some(home) = &s.home {
        let home_skip = s
            .guarded
            .iter()
            .fold(skip(), |k, f| k.and_folder(f.clone()));
        index.start_kept(home.clone(), home_skip, WALK_THREADS, Keep::home());
    }
    for folder in s.opened {
        index.start_kept(folder, skip(), WALK_THREADS, Keep::home());
    }
    log::info!("index: drives {:?}", s.drives);
    for drive in s.drives {
        let skip = match &s.home {
            Some(h) if h.starts_with(&drive) => skip().and_folder(h.clone()),
            _ => skip(),
        };
        index.start_kept(drive, skip, WALK_THREADS, Keep::drive());
    }
}

/// A guarded folder the person has just opened for the first time (`core::privacy_folders`):
/// walked and watched from now on as a part of its own, as `start_with` does on the next start.
pub fn start_opened(index: &Index, folder: PathBuf, skip_folders: &[PathBuf]) {
    let skip = skip_folders
        .iter()
        .fold(Skip::defaults(), |k, f| k.and_folder(f.clone()));
    index.start_kept(folder, skip, WALK_THREADS, Keep::home());
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::path::{Path, PathBuf};

    /// A fresh folder under the temp dir, deleted when dropped.
    pub struct Scratch(PathBuf);

    impl Scratch {
        pub fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("trove-index-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            // the canonical spelling, as the watcher reports it (`/private/var` on a Mac)
            Scratch(dir.canonicalize().map(strip_verbatim).unwrap_or(dir))
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    /// `canonicalize` on Windows answers `\\?\C:\…`; the watcher and the walk use `C:\…`.
    fn strip_verbatim(p: PathBuf) -> PathBuf {
        let s = p.to_string_lossy();
        match s.strip_prefix(r"\\?\") {
            Some(rest) => PathBuf::from(rest),
            None => p,
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real home folder, once, for the numbers plan 21C.1 writes down. Slow and
    /// machine-bound, so `#[ignore]`d:
    /// `cargo test --release --lib walk_the_real_home_folder -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn walk_the_real_home_folder() {
        let home = crate::core::shell::user_profile().unwrap();
        let started = Instant::now();
        let t = walk::walk(
            &home,
            &Skip::defaults(),
            WALK_THREADS,
            &AtomicBool::new(false),
        );
        eprintln!(
            "home walk: {} rows in {} ms, {} bytes, {} names with their own case",
            t.len(),
            started.elapsed().as_millis(),
            t.bytes(),
            t.cased()
        );
        for q in ["report", "zzqx", "a", "readme"] {
            let started = Instant::now();
            let (_, total) = t.search(q, 20);
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            eprintln!("search {q:?}: {total} hits, {ms:.1} ms");
        }
    }

    /// `/` with the real Linux skips, then what the 30-minute save and a restart's load cost
    /// (plan 21C.9b numbers):
    /// `cargo test --release --lib walk_save_load_the_real_root -- --ignored --nocapture`.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "walks the whole disk"]
    fn walk_save_load_the_real_root() {
        let started = Instant::now();
        let t = walk::walk(
            Path::new("/"),
            &Skip::defaults(),
            WALK_THREADS,
            &AtomicBool::new(false),
        );
        eprintln!(
            "root walk: {} rows in {:.1} s, table {} bytes ({:.1} MB)",
            t.len(),
            started.elapsed().as_secs_f64(),
            t.bytes(),
            t.bytes() as f64 / 1_048_576.0
        );
        let file = std::env::temp_dir().join(format!("trove-root-{}.idx", std::process::id()));
        let started = Instant::now();
        store::save(&t, &file).unwrap();
        let save_ms = started.elapsed().as_secs_f64() * 1000.0;
        let on_disk = std::fs::metadata(&file).unwrap().len();
        let started = Instant::now();
        let back = store::load(&file).unwrap();
        let load_ms = started.elapsed().as_secs_f64() * 1000.0;
        let _ = std::fs::remove_file(&file);
        eprintln!(
            "save {save_ms:.0} ms, {on_disk} bytes on disk ({:.1} MB), load {load_ms:.0} ms ({} rows)",
            on_disk as f64 / 1_048_576.0,
            back.len()
        );
        assert_eq!(back.len(), t.len());
    }

    use super::test_util::Scratch;

    /// Wait up to 10 s for every part to finish its first walk.
    fn settled(index: &Index) {
        let until = Instant::now() + Duration::from_secs(10);
        while !index.filling().is_empty() {
            assert!(
                Instant::now() < until,
                "still filling: {:?}",
                index.filling()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn index_searches_every_ready_root_and_merges_by_tier() {
        let home = Scratch::new("parts-home");
        let drive = Scratch::new("parts-drive");
        std::fs::write(home.path().join("my-report-notes.txt"), "").unwrap();
        std::fs::write(drive.path().join("report"), "").unwrap();
        let index = Index::default();
        index.start(home.path().to_path_buf(), Skip::defaults(), 2);
        index.start(drive.path().to_path_buf(), Skip::defaults(), 2);
        settled(&index);
        assert_eq!(
            index.roots(),
            vec![home.path().to_path_buf(), drive.path().to_path_buf()]
        );
        assert_eq!(index.root(), Some(home.path().to_path_buf()));
        let (hits, total) = index.search("report", 20).unwrap();
        assert_eq!(total, 2);
        // the exact name on the second root beats a word match on the first
        assert_eq!(hits[0].path, drive.path().join("report"));
        assert_eq!(hits[1].path, home.path().join("my-report-notes.txt"));
        index.stop();
    }

    #[test]
    fn rewalk_due_only_without_a_watcher_and_once_the_time_is_up() {
        let every = Some(Duration::from_secs(30 * 60));
        assert!(!rewalk_due(every, false, Duration::from_secs(29 * 60)));
        assert!(rewalk_due(every, false, Duration::from_secs(30 * 60)));
        // watched: the watcher keeps it, no timer
        assert!(!rewalk_due(every, true, Duration::from_secs(3600)));
        // Windows and Mac: no timer at all
        assert!(!rewalk_due(None, false, Duration::from_secs(3600)));
    }

    fn found(index: &Index, text: &str) -> usize {
        index.search(text, 5).map_or(0, |(_, total)| total)
    }

    /// Wait up to `secs` for `text` to have `want` hits; how long it took.
    fn until(index: &Index, text: &str, want: usize, secs: u64) -> Duration {
        let started = Instant::now();
        while found(index, text) != want {
            assert!(
                started.elapsed() < Duration::from_secs(secs),
                "{text:?}: {} hits, wanted {want}",
                found(index, text)
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        started.elapsed()
    }

    #[test]
    fn an_unwatched_part_walks_again_on_its_timer() {
        let disk = Scratch::new("rewalk-timer");
        let index = Index::default();
        let keep = Keep {
            live: Live::Off,
            rewalk_every: Some(Duration::from_millis(300)),
        };
        index.start_kept(disk.path().to_path_buf(), Skip::defaults(), 2, keep);
        settled(&index);
        std::fs::write(disk.path().join("late-arrival.txt"), "").unwrap();
        until(&index, "late-arrival", 1, 5);
        index.stop();
    }

    /// Out of folder watches (budget 1, three folders): no crash, the part is walked on its
    /// timer instead.
    #[test]
    fn a_part_out_of_folder_watches_walks_on_its_timer() {
        let home = Scratch::new("rewalk-full");
        std::fs::create_dir_all(home.path().join("a/b")).unwrap();
        let index = Index::default();
        index.0.folder_budget.store(1, Ordering::Relaxed);
        let keep = Keep {
            live: Live::Folders,
            rewalk_every: Some(Duration::from_millis(300)),
        };
        index.start_kept(home.path().to_path_buf(), Skip::defaults(), 2, keep);
        settled(&index);
        std::fs::write(home.path().join("a/b/after-full.txt"), "").unwrap();
        until(&index, "after-full", 1, 5);
        index.stop();
    }

    /// Plan 21C.9b's real check, as `start_with` sets Linux up: the home folder watched one
    /// inotify watch per folder, the disk around it never watched and walked again on a timer
    /// (3 s here for 30 min). A file made in home is findable from its inotify event; one made
    /// outside home only after the timed walk.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_home_is_live_and_the_rest_walks_on_its_timer() {
        let disk = Scratch::new("linux-disk");
        let home = disk.path().join("home");
        std::fs::create_dir_all(home.join("docs")).unwrap();
        std::fs::create_dir_all(home.join("node_modules/pkg")).unwrap();
        let index = Index::default();
        index.start_kept(
            home.clone(),
            Skip::defaults(),
            2,
            Keep {
                live: Live::Folders,
                rewalk_every: Some(REWALK_EVERY),
            },
        );
        let every = Duration::from_secs(3);
        index.start_kept(
            disk.path().to_path_buf(),
            Skip::defaults().and_folder(home.clone()),
            2,
            Keep {
                live: Live::Off,
                rewalk_every: Some(every),
            },
        );
        settled(&index);
        let made = Instant::now();
        std::fs::write(home.join("docs/inotify-proof.txt"), "").unwrap();
        std::fs::write(disk.path().join("outside-proof.txt"), "").unwrap();
        let live = until(&index, "inotify-proof", 1, 5);
        assert!(live < every, "home took {} ms", live.as_millis());
        // outside home: nothing until the timer's walk (asked at once, so a slow box still has
        // most of the 3 s left)
        assert_eq!(found(&index, "outside-proof"), 0);
        // a folder made after the start gets its own watch
        std::fs::create_dir_all(home.join("new/deeper")).unwrap();
        std::fs::write(home.join("new/deeper/nested-proof.txt"), "").unwrap();
        until(&index, "nested-proof", 1, 5);
        until(&index, "outside-proof", 1, 10);
        eprintln!(
            "home file via inotify after {} ms; outside file after the timed walk, {} ms",
            live.as_millis(),
            made.elapsed().as_millis()
        );
        index.stop();
    }

    /// Found in the review of plan 21C.9b: after lost events the queue is drained unread, so
    /// a folder removed and made again at the same path stayed listed as watched while the
    /// kernel had dropped its watch, and nothing new in it was ever found. The walk after lost
    /// events sets every watch again.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_a_folder_made_again_while_events_were_lost_is_watched_again() {
        let home = Scratch::new("linux-remade");
        let docs = home.path().join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        let index = Index::default();
        index.start_kept(
            home.path().to_path_buf(),
            Skip::defaults(),
            2,
            Keep {
                live: Live::Folders,
                rewalk_every: Some(REWALK_EVERY),
            },
        );
        settled(&index);
        // events lost: docs removed and made again, and a file put in it, all unread
        index.0.deaf.store(true, Ordering::Relaxed);
        std::fs::remove_dir_all(&docs).unwrap();
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("while-deaf.txt"), "").unwrap();
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(found(&index, "while-deaf"), 0, "its event was thrown away");
        // the lost-events walk finds the file, and sets the watches before it walks
        index.0.deaf.store(false, Ordering::Relaxed);
        until(&index, "while-deaf", 1, 10);
        // only a live watch on the new docs finds this one (no timer: REWALK_EVERY is 30 min)
        std::fs::write(docs.join("after-remade.txt"), "").unwrap();
        until(&index, "after-remade", 1, 5);
        index.stop();
    }

    #[test]
    fn a_root_waiting_its_turn_is_filling_and_left_out_of_search() {
        let index = Index::default();
        // added, never started: it waits forever behind nothing that ends
        index.add(PathBuf::from("D:\\"), Keep::RECURSIVE);
        assert_eq!(index.search("report", 20), None);
        assert!(index.roots().is_empty());
        assert_eq!(
            index.filling(),
            vec![Filling {
                label: "D:".into(),
                seen: 0
            }]
        );
    }

    /// Wait up to 10 s for `file` to be written.
    fn written(file: &Path) {
        let until = Instant::now() + Duration::from_secs(10);
        while !file.exists() {
            assert!(Instant::now() < until, "never saved: {}", file.display());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// A table under `root` holding `names` as files at its top.
    fn table_of(root: &Path, names: &[&str]) -> Table {
        let mut t = Table::new(root);
        for n in names {
            t.insert(TOP, n, false);
        }
        t
    }

    #[cfg(windows)]
    #[test]
    fn catch_up_rewalks_when_saved_usn_below_first_usn() {
        let dir = Scratch::new("catch-up");
        let index = Index::default();
        let part = index.add(dir.path().to_path_buf(), Keep::RECURSIVE);
        *part.table.write().unwrap() = Some(Table::new(dir.path()));
        // a position older than the oldest record kept: the journal wrapped past it
        let saved = match usn::query(dir.path()) {
            Ok(j) => (j.id, j.first_usn - 1),
            Err(_) => (0, 0),
        };
        let mut journal = Journal::default();
        assert!(!journal.catch_up(&part, Some(saved), &Skip::defaults()));
        assert!(!journal.catch_up(&part, None, &Skip::defaults()));
    }

    /// Read `tail` into `t` until `done` holds (antivirus can hold a close record a moment), up
    /// to 10 s. Only this test's own records are applied — those under `t`'s root or with an id
    /// in `ours` — since the journal is the whole drive's and other tests churn files on it; the
    /// rows they leave behind are added to `ghosts`.
    #[cfg(windows)]
    fn fed_until(
        tail: &mut usn::UsnTail,
        t: &mut Table,
        ours: &std::collections::HashSet<u128>,
        ghosts: &mut usize,
        done: impl Fn(&Table) -> bool,
    ) {
        let until = Instant::now() + Duration::from_secs(10);
        let skip = Skip::new(&[], Vec::new());
        loop {
            let root = t.root().to_path_buf();
            let events: Vec<usn::Event> = tail
                .read()
                .expect("read journal")
                .into_iter()
                .filter(|e| {
                    ours.contains(&e.id) || e.path.as_ref().is_some_and(|p| p.starts_with(&root))
                })
                .collect();
            *ghosts += apply_journal(t, &events, &skip, false).ghosts;
            if done(t) {
                return;
            }
            assert!(
                Instant::now() < until,
                "the journal never brought the change"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Create, rename (a file and a folder with a file in it) and delete, read from the change
    /// journal alone (no watcher): the rows follow by file id and none is left behind.
    #[cfg(windows)]
    #[test]
    fn journal_rows_follow_create_rename_delete_by_id_with_no_ghosts() {
        let dir = Scratch::new("journal-ids");
        let root = dir.path();
        let inside = root.join("box").join("inside.txt");
        std::fs::create_dir_all(root.join("box")).unwrap();
        std::fs::write(&inside, "").unwrap();
        let skip = Skip::new(&[], Vec::new());
        let mut t = walk::walk(root, &skip, 2, &AtomicBool::new(false));
        let mut tail = match usn::UsnTail::open(root) {
            Ok(tail) => tail,
            Err(e @ (usn::UsnError::NoAccess | usn::UsnError::NoJournal)) => {
                println!("SKIP journal_rows: {e} - the caller falls back to watcher + re-walk");
                return;
            }
            Err(e) => panic!("open journal: {e}"),
        };
        // every walked row carries its id: the journal finds them by it
        let mut ours: std::collections::HashSet<u128> = t
            .rows()
            .map(|(row, ..)| t.id_of(row).expect("walked row has an id"))
            .collect();
        assert_eq!(ours.len(), 2);
        let mut ghosts = 0;
        let has = |t: &Table, p: &Path| t.row_of(p).is_some();

        let made = root.join("made-by-test.txt");
        std::fs::write(&made, "x").unwrap();
        fed_until(&mut tail, &mut t, &ours, &mut ghosts, |t| has(t, &made));
        let id = usn::file_id(&made).unwrap();
        ours.insert(id);
        assert_eq!(
            t.row_by_id(id),
            t.row_of(&made),
            "the create recorded its id"
        );

        let renamed = root.join("renamed-by-test.txt");
        std::fs::rename(&made, &renamed).unwrap();
        fed_until(&mut tail, &mut t, &ours, &mut ghosts, |t| {
            has(t, &renamed) && !has(t, &made)
        });

        let moved = root.join("box-moved");
        std::fs::rename(root.join("box"), &moved).unwrap();
        fed_until(&mut tail, &mut t, &ours, &mut ghosts, |t| {
            has(t, &moved.join("inside.txt")) && !has(t, &inside)
        });

        std::fs::remove_file(&renamed).unwrap();
        std::fs::remove_file(moved.join("inside.txt")).unwrap();
        fed_until(&mut tail, &mut t, &ours, &mut ghosts, |t| {
            !has(t, &renamed) && !has(t, &moved.join("inside.txt"))
        });
        assert_eq!(ghosts, 0, "rows left behind");
        assert_eq!(t.len(), 1, "only box-moved is left");
        println!("journal_rows: create, rename, folder move, delete followed by id, 0 ghosts");
    }

    /// A journal event made by hand: what `UsnTail::read` hands `apply_journal`.
    #[cfg(windows)]
    fn event(change: usn::Change, id: u128, parent: u128, name: Option<&str>) -> usn::Event {
        usn::Event {
            change,
            id,
            parent,
            name: name.map(Into::into),
            path: None,
            usn: 0,
            folder: false,
        }
    }

    /// The journal is the whole drive's: deletes and renames under a skipped folder (`target/`
    /// beside `Cargo.toml`) or outside the part's root are ignored, never counted as rows left
    /// behind; an unknown id in a folder the part does hold is a real ghost.
    #[cfg(windows)]
    #[test]
    fn journal_events_outside_the_part_are_ignored_not_ghosts() {
        use usn::Change::{Deleted, Renamed};
        let dir = Scratch::new("journal-ghosts");
        let root = dir.path().join("part");
        let proj = root.join("proj");
        let debug = proj.join("target").join("debug");
        std::fs::create_dir_all(&debug).unwrap();
        std::fs::write(proj.join("Cargo.toml"), "").unwrap();
        std::fs::write(proj.join("main.rs"), "").unwrap();
        let outside = dir.path().join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        let skip = Skip::defaults();
        let mut t = walk::walk(&root, &skip, 2, &AtomicBool::new(false));
        assert!(
            t.row_of(&proj.join("target")).is_none(),
            "target/ is skipped"
        );
        let id = |p: &Path| usn::file_id(p).expect("file id");
        let (proj_id, debug_id, outside_id) = (id(&proj), id(&debug), id(&outside));

        let skipped_or_outside = vec![
            // a build output deleted inside target/: its folder has no row
            event(Deleted, 9_001, debug_id, None),
            event(Deleted, 9_002, debug_id, Some("app.exe")),
            // target/ itself, named by an elevated read: a skipped folder
            event(Deleted, 9_003, proj_id, Some("target")),
            // another part's folder, or anywhere else on the drive
            event(Deleted, 9_004, outside_id, Some("x.txt")),
            event(Renamed, 9_005, outside_id, None),
            // a rename whose new home is under target/, or outside the root
            usn::Event {
                path: Some(debug.join("app.pdb")),
                ..event(Renamed, 9_006, debug_id, None)
            },
            usn::Event {
                path: Some(outside.join("moved.txt")),
                ..event(Renamed, 9_007, outside_id, None)
            },
        ];
        let done = apply_journal(&mut t, &skipped_or_outside, &skip, false);
        assert_eq!(
            done,
            Applied {
                applied: 0,
                ignored: 7,
                ghosts: 0
            }
        );

        let main = t.row_of(&proj.join("main.rs")).unwrap();
        let main_id = t.id_of(main).unwrap();
        let inside = vec![
            // a known row deleted: followed
            event(Deleted, main_id, proj_id, None),
            // an id with no row, in a folder this part holds: a real ghost
            event(Deleted, 9_010, proj_id, Some("lost.txt")),
        ];
        let done = apply_journal(&mut t, &inside, &skip, false);
        assert_eq!(
            done,
            Applied {
                applied: 1,
                ignored: 0,
                ghosts: 1
            }
        );
        assert!(t.row_of(&proj.join("main.rs")).is_none());
        // directly in the root: the root's own id is the parent
        let done = apply_journal(
            &mut t,
            &[event(Deleted, 9_011, id(&root), None)],
            &skip,
            false,
        );
        assert_eq!(done.ghosts, 1, "a delete in the root itself counts");
        println!("journal_ghosts: 7 ignored (target/, outside), 1 applied, 1 + 1 real ghosts");
    }

    #[test]
    fn a_saved_part_is_served_before_its_walk_and_marked_stale() {
        let root = Scratch::new("saved-root");
        let store = Scratch::new("saved-store");
        std::fs::write(root.path().join("hello-saved.txt"), "").unwrap();
        let first = Index::default();
        first.set_store(store.path().to_path_buf());
        first.start(root.path().to_path_buf(), Skip::defaults(), 2);
        settled(&first);
        let file = store.path().join(file_name(root.path()));
        written(&file);
        first.stop();

        // the next start: loaded, never walked (no thread runs for this part)
        let next = Index::default();
        next.set_store(store.path().to_path_buf());
        let part = next.add(root.path().to_path_buf(), Keep::RECURSIVE);
        assert_eq!(next.search("hello", 5), None);
        assert!(load_saved(&next.0.file_of(root.path()).unwrap(), &part).is_some());
        assert!(next.filling().is_empty());
        assert_eq!(next.roots(), vec![root.path().to_path_buf()]);
        assert_eq!(next.stale(), vec![part.label.clone()]);
        let (hits, total) = next.search("hello", 5).unwrap();
        assert_eq!(total, 1);
        assert_eq!(hits[0].path, root.path().join("hello-saved.txt"));
        assert!(!hits[0].snapshot);
    }

    #[test]
    fn a_damaged_saved_file_is_deleted_and_the_part_walks_again() {
        let root = Scratch::new("damaged-root");
        let store = Scratch::new("damaged-store");
        std::fs::write(root.path().join("after-damage.txt"), "").unwrap();
        let file = store.path().join(file_name(root.path()));
        let damage = || {
            std::fs::write(&file, b"not a table").unwrap();
            write_pos(&file, Some((7, 42)));
        };
        damage();
        assert!(pos_file(&file).exists());

        let index = Index::default();
        index.set_store(store.path().to_path_buf());
        let part = index.add(root.path().to_path_buf(), Keep::RECURSIVE);
        assert!(load_saved(&file, &part).is_none());
        assert!(!file.exists());
        assert!(!pos_file(&file).exists());
        assert!(!part.ready());

        // started over a damaged file: it walks, serves the walk, saves a good file
        damage();
        let index = Index::default();
        index.set_store(store.path().to_path_buf());
        index.start(root.path().to_path_buf(), Skip::defaults(), 2);
        settled(&index);
        let (hits, _) = index.search("after-damage", 5).unwrap();
        assert_eq!(hits[0].path, root.path().join("after-damage.txt"));
        assert!(index.stale().is_empty());
        let until = Instant::now() + Duration::from_secs(10);
        while store::load(&file).is_err() {
            assert!(Instant::now() < until, "the walk was never saved");
            std::thread::sleep(Duration::from_millis(20));
        }
        index.stop();
    }

    #[test]
    fn forget_empties_the_index_and_save_all_writes_nothing() {
        let root = Scratch::new("forget-root");
        let store = Scratch::new("forget-store");
        std::fs::write(root.path().join("alpha.txt"), "").unwrap();
        let index = Index::default();
        index.set_store(store.path().to_path_buf());
        index.start(root.path().to_path_buf(), Skip::defaults(), 2);
        settled(&index);
        assert!(index.search("alpha", 5).is_some());
        let part = index.parts().remove(0);
        part.dirty.store(true, Ordering::Relaxed);
        index.forget();
        // the files the user just deleted
        // A part's save may still rename its temp file between the listing and the remove, so a
        // name already gone is fine; the count below is what proves nothing was written back.
        for f in std::fs::read_dir(store.path()).unwrap() {
            match std::fs::remove_file(f.unwrap().path()) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                r => r.unwrap(),
            }
        }
        // neither the exit save nor a part's own thread writes them back
        index.save_all();
        save_part(&index.0, &part);
        assert!(index.search("alpha", 5).is_none());
        assert_eq!(std::fs::read_dir(store.path()).unwrap().count(), 0);
        index.stop();
    }

    #[test]
    fn wsl_to_list_never_lists_a_stopped_distro() {
        let now = Instant::now();
        let asked = vec!["Ubuntu".to_string(), "Debian".to_string()];
        // the palette asked for both, but wsl.exe says only Ubuntu runs
        let running = vec!["ubuntu".to_string()];
        assert_eq!(wsl_to_list(&asked, &running, &[], now), vec!["Ubuntu"]);
        assert!(wsl_to_list(&asked, &[], &[], now).is_empty());

        let snap = |distro: &str| {
            Arc::new(WslPart {
                snap: wsl::Snapshot {
                    distro: distro.into(),
                    taken_at: now,
                    entries: Vec::new(),
                },
                table: Table::new(PathBuf::from(crate::core::wsl::root_of(distro))),
                covers: Vec::new(),
            })
        };
        let have = vec![snap("Ubuntu"), snap("Debian")];
        // a fresh snapshot is not listed again
        assert!(wsl_to_list(&asked, &running, &have, now).is_empty());
        // a stale one is, and still only the running distro
        let later = now + wsl::STALE_AFTER + Duration::from_secs(1);
        assert_eq!(wsl_to_list(&asked, &running, &have, later), vec!["Ubuntu"]);
    }

    #[test]
    fn wsl_table_builds_rows_and_covers() {
        let e = |path: &str, kind| wsl::WslEntry {
            path: path.into(),
            kind,
            size: 0,
            mtime: 0,
        };
        let entries = [
            e("/home", wsl::Kind::Dir),
            e("/home/alex", wsl::Kind::Dir),
            e("/home/alex/a b.txt", wsl::Kind::File),
            e("/home/alex/notes/", wsl::Kind::Dir),
            e("/root", wsl::Kind::Dir),
            // its folder was never listed (unreadable): left out
            e("/srv/x/hidden.txt", wsl::Kind::File),
        ];
        let (t, covers) = wsl_table("Ubuntu", &entries);
        let root = PathBuf::from(crate::core::wsl::root_of("Ubuntu"));
        assert_eq!(t.root(), root.as_path());
        assert_eq!(t.len(), 5);
        assert_eq!(covers, vec![root.join("home"), root.join("root")]);
        let (rows, _) = t.search("a b.txt", 5);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            t.path_of(rows[0]),
            root.join("home").join("alex").join("a b.txt")
        );
        assert!(!t.is_dir(rows[0]));
        let (rows, _) = t.search("notes", 5);
        assert!(t.is_dir(rows[0]));
        assert_eq!(t.search("hidden", 5).1, 0);
    }

    #[test]
    fn fuzzy_hits_merge_after_substring_hits() {
        let index = Index::default();
        let home = index.add(PathBuf::from(r"C:\home-fuzzy"), Keep::RECURSIVE);
        let drive = index.add(PathBuf::from(r"D:\"), Keep::RECURSIVE);
        // the first part has "rprt" only spread out (fuzzy); the second has it side by side
        *home.table.write().unwrap() = Some(table_of(&home.root, &["report.txt"]));
        *drive.table.write().unwrap() = Some(table_of(&drive.root, &["my rprt notes"]));
        let (hits, total) = index.search("rprt", 10).unwrap();
        assert_eq!(total, 2);
        assert_eq!(
            hits.iter().map(|h| h.path.clone()).collect::<Vec<_>>(),
            vec![
                drive.root.join("my rprt notes"),
                home.root.join("report.txt")
            ]
        );
    }

    #[test]
    fn tier_orders_exact_prefix_word_anywhere() {
        assert_eq!(tier("Report", "report"), 0);
        assert_eq!(tier("report.txt", "report"), 1);
        assert_eq!(tier("my-report.txt", "report"), 2);
        assert_eq!(tier("myreport.txt", "report"), 3);
    }
}

//! The open explorer windows and their folder tabs, kept so the next start can bring every
//! window back ("Restore tabs", plan 15 G.45). One JSON file beside `settings.json`:
//! `{ "windows": [ { "label": "main", "tabs": ["C:\\a"], "active": 0 }, … ] }`.
//!
//! ⚠️ **One owner in the process, not one writer per window.** Every window reports its own tabs
//! (`save`), and the [`Store`] holds the whole session in memory behind one lock and writes it
//! out whole. A window never reads-modifies-writes the file itself, so two windows saving at
//! once cannot drop each other — the last-writer-wins trap a shared settings field would be.
//!
//! What the last run left is read once, on the store's first use, BEFORE this run writes
//! anything — so the order of "main asks for the old session" and "a window saves its tabs"
//! does not matter. It is handed out once (`take_previous`): a `main` rebuilt mid-session must
//! not reopen the last run's windows a second time.
//!
//! ⛔ A Mac app outlives its last window (it stays in the Dock). That window, closed on its own,
//! is kept (`closed_last`) and handed to the `main` a Dock click rebuilds, so it comes back with
//! its tabs AND its active tab. Without it the rebuilt `main` got `None` and fell back to the
//! `openTabs` setting, which has no active tab: the first tab won every time (Mac, 2026-10-12).
//!
//! A window closed while other explorer windows stay open is forgotten (`window_closed`); the
//! last one, and every window torn down by a quit, is kept — that is what "open at quit" means.
//! A kept window that is no longer alive is pruned by the next save made while not quitting
//! (`save`'s `alive`), so a Mac app that outlives its last window does not bring it back forever.
//!
//! Windows a hidden start has not opened yet (`hold`) are written after the live ones, so a
//! quit from the tray before the window is ever shown does not lose them.
//!
//! Each window's size and place on screen (`bounds`) rides in the same entry but is kept apart
//! from its tabs in the store (`save_bounds`): the tabs come from the page, the bounds from
//! Rust's window events, and neither save may wipe the other. They come back even with "Restore
//! tabs" off, as Explorer does: `main` always, a restored window by its tabs (`restore_bounds`).

use std::collections::{HashMap, HashSet};
use std::io::Result;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "session.json";

/// One explorer window's folder tabs and which of them was active.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct WindowTabs {
    pub label: String,
    #[serde(default)]
    pub tabs: Vec<String>,
    #[serde(default)]
    pub active: usize,
    /// Where the window was and how big; `None` in a file from before it was saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
}

/// A window's outer position and inner size in PHYSICAL px (what the OS reports and what the
/// monitors are measured in), and whether it was maximized. When maximized, the rect is the one
/// it goes back to on un-maximize, not the full screen.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub maximized: bool,
}

/// A monitor's work area (no taskbar) in physical px, and its scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub scale: f64,
    pub primary: bool,
}

/// The smallest an explorer window may be, in logical px: `minWidth`/`minHeight` in
/// tauri.conf.json and `min_inner_size` in `commands::windows`.
pub const MIN_SIZE: (f64, f64) = (800.0, 500.0);

/// How many px of `b` lie on `s`.
fn overlap(b: &Bounds, s: &Screen) -> i64 {
    let w = (b.x as i64 + b.w as i64).min(s.x as i64 + s.w as i64) - (b.x as i64).max(s.x as i64);
    let h = (b.y as i64 + b.h as i64).min(s.y as i64 + s.h as i64) - (b.y as i64).max(s.y as i64);
    w.max(0) * h.max(0)
}

/// `start` moved so `len` px fit in `[from, from + room)`; the start edge wins when they cannot.
pub fn pull_in(start: i32, len: u32, from: i32, room: u32) -> i32 {
    let last = from as i64 + room as i64 - len as i64;
    (start as i64).min(last).max(from as i64) as i32
}

/// The monitor `b` overlaps most; `None` when it is on none of them.
pub fn screen_under<'a>(b: &Bounds, monitors: &'a [Screen]) -> Option<&'a Screen> {
    monitors
        .iter()
        .map(|s| (overlap(b, s), s))
        .filter(|(area, _)| *area > 0)
        .max_by_key(|(area, _)| *area)
        .map(|(_, s)| s)
}

/// Where a `w`×`h` window starts to sit in the middle of `s`.
fn centred_on(s: &Screen, w: u32, h: u32) -> (i32, i32) {
    (
        s.x + (s.w as i32 - w as i32) / 2,
        s.y + (s.h as i32 - h as i32) / 2,
    )
}

/// Where a saved window goes on the monitors there are now. On the monitor it overlaps most; on
/// none (that monitor is gone), centred on the primary one. Never smaller than [`MIN_SIZE`] at
/// that monitor's scale, never bigger than its work area, and pulled in until it is all on it.
/// The maximized flag is kept. No monitors at all: `saved` as it is.
pub fn fit_to_monitors(saved: Bounds, monitors: &[Screen]) -> Bounds {
    let on = screen_under(&saved, monitors).map(|s| (s, false));
    let primary = || {
        monitors
            .iter()
            .find(|s| s.primary)
            .or(monitors.first())
            .map(|s| (s, true))
    };
    let Some((screen, moved)) = on.or_else(primary) else {
        return saved;
    };
    let w = saved
        .w
        .min(screen.w)
        .max((MIN_SIZE.0 * screen.scale).ceil() as u32);
    let h = saved
        .h
        .min(screen.h)
        .max((MIN_SIZE.1 * screen.scale).ceil() as u32);
    let (x, y) = if moved {
        centred_on(screen, w, h)
    } else {
        (saved.x, saved.y)
    };
    Bounds {
        x: pull_in(x, w, screen.x, screen.w),
        y: pull_in(y, h, screen.y, screen.h),
        w,
        h,
        maximized: saved.maximized,
    }
}

/// The size a new window opens at, in logical px: `width`/`height` in tauri.conf.json and
/// `inner_size` in `commands::windows`.
pub const DEFAULT_SIZE: (f64, f64) = (1200.0, 760.0);

/// What a maximized window saves: the flag, over the rect it goes back to on un-maximize.
/// `now` is its maximized rect, `before` the bounds saved for it last. Still on the monitor of
/// `before`: `before`. Maximized onto another monitor since (Win+Shift+Right): `before` carried
/// over at the same offset from that monitor's corner, its size kept, pulled in until it is all
/// on it, so the window comes back on the monitor it was left on. Nothing saved before (its
/// first save is while maximized): [`DEFAULT_SIZE`] at that monitor's scale, centred on it, not
/// the full screen. `now` on no monitor: `before` (else `now`) as it is.
pub fn maximized_bounds(now: Bounds, before: Option<Bounds>, monitors: &[Screen]) -> Bounds {
    let Some(on) = screen_under(&now, monitors) else {
        return Bounds {
            maximized: true,
            ..before.unwrap_or(now)
        };
    };
    let normal = match before {
        Some(b) => match screen_under(&b, monitors) {
            Some(from) if from == on => b,
            from => {
                let (w, h) = (b.w.min(on.w), b.h.min(on.h));
                let (x, y) = match from {
                    Some(from) => (on.x + (b.x - from.x), on.y + (b.y - from.y)),
                    None => centred_on(on, w, h),
                };
                Bounds {
                    x: pull_in(x, w, on.x, on.w),
                    y: pull_in(y, h, on.y, on.h),
                    w,
                    h,
                    maximized: false,
                }
            }
        },
        None => {
            let w = ((DEFAULT_SIZE.0 * on.scale).round() as u32).min(on.w);
            let h = ((DEFAULT_SIZE.1 * on.scale).round() as u32).min(on.h);
            let (x, y) = centred_on(on, w, h);
            Bounds {
                x,
                y,
                w,
                h,
                maximized: false,
            }
        }
    };
    Bounds {
        maximized: true,
        ..normal
    }
}

/// Whether the windowing system keeps a window's place to itself: a Wayland session that GTK
/// talks to as Wayland, where `outer_position` is a cached 0,0 and `set_position` does nothing.
/// Then only the size is saved and restored. Read from the environment, as GTK picks its
/// backend: the first entry of `GDK_BACKEND` when it names one (`x11` runs under XWayland,
/// where positions work), else a non-empty `WAYLAND_DISPLAY`.
pub fn positions_hidden(wayland_display: Option<&str>, gdk_backend: Option<&str>) -> bool {
    let first = gdk_backend
        .and_then(|b| b.split(',').next())
        .map(str::trim)
        .unwrap_or("");
    match first {
        "x11" => false,
        "wayland" => true,
        _ => wayland_display.is_some_and(|d| !d.is_empty()),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Session {
    #[serde(default)]
    pub windows: Vec<WindowTabs>,
}

/// `main` first, then `main-2`, `main-3`… by number (the order they were opened in); anything
/// else after them.
fn order_key(label: &str) -> (u8, u64) {
    if label == "main" {
        return (0, 0);
    }
    match label
        .strip_prefix("main-")
        .and_then(|n| n.parse::<u64>().ok())
    {
        Some(n) => (1, n),
        None => (2, 0),
    }
}

impl Session {
    /// Record `window`'s tabs, replacing what it reported before.
    pub fn put(&mut self, window: WindowTabs) {
        match self.windows.iter_mut().find(|w| w.label == window.label) {
            Some(slot) => *slot = window,
            None => self.windows.push(window),
        }
        self.windows.sort_by_key(|w| order_key(&w.label));
    }

    /// Drop `label`'s entry. True when there was one.
    pub fn forget(&mut self, label: &str) -> bool {
        let before = self.windows.len();
        self.windows.retain(|w| w.label != label);
        self.windows.len() != before
    }
}

/// The saved session, or `None` when there is no file (a first run, or a build from before this
/// file existed) or it cannot be read as one.
pub fn read(dir: &Path) -> Option<Session> {
    let bytes = std::fs::read(dir.join(FILE_NAME)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Written to a temp file and renamed, so a crash mid-write never leaves half a session.
pub fn write(dir: &Path, session: &Session) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let target = dir.join(FILE_NAME);
    let tmp = target.with_extension(format!("json.{}.tmp", std::process::id()));
    let written = std::fs::write(&tmp, serde_json::to_vec_pretty(session)?)
        .and_then(|()| std::fs::rename(&tmp, &target));
    if written.is_err() {
        // a failed write or rename must not leave a stray temp file per process behind
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Label prefix of a window held for later (`Store::hold`); never an explorer window's label.
const HELD: &str = "held-";

#[derive(Default)]
struct Inner {
    started: bool,
    /// what the last run left; `None` once handed out, or when there was nothing
    previous: Option<Session>,
    current: Session,
    /// the window closed last while the app kept running (a Mac in the Dock), handed out once to
    /// the `main` rebuilt for it
    closed_last: Option<Session>,
    /// windows the last run had open that this run has not opened yet (a hidden start)
    held: Vec<WindowTabs>,
    /// this run's windows' latest bounds, by label; written beside their tabs by `flush`
    bounds: HashMap<String, Bounds>,
    /// the last run's windows whose bounds no window of this run has taken yet
    last_run: Vec<WindowTabs>,
    /// the bounds of the window closed last while the app kept running, for the rebuilt `main`
    closed_last_bounds: Option<Bounds>,
    /// `main` has had its turn at `last_run`: a later rebuilt `main` takes no other window's
    main_restored: bool,
    /// the process is quitting: the windows it tears down are kept, not forgotten
    quitting: bool,
}

/// The session of this run. See the module note.
pub struct Store {
    dir: PathBuf,
    inner: Mutex<Inner>,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            inner: Mutex::new(Inner::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !inner.started {
            inner.started = true;
            inner.previous = read(&self.dir);
            inner.last_run = inner
                .previous
                .as_ref()
                .map(|p| p.windows.clone())
                .unwrap_or_default();
        }
        inner
    }

    /// The last run's windows, `main`'s first — once per process. After that, the window this
    /// run closed last while it kept running, once (the Dock rebuild). `None` otherwise.
    pub fn take_previous(&self) -> Option<Session> {
        let mut inner = self.lock();
        inner.previous.take().or_else(|| inner.closed_last.take())
    }

    /// What goes on disk: the live windows with their bounds, then the held ones.
    fn flush(&self, inner: &Inner) -> Result<()> {
        let mut all = inner.current.clone();
        for w in &mut all.windows {
            w.bounds = inner.bounds.get(&w.label).copied();
        }
        all.windows.extend(inner.held.iter().cloned());
        write(&self.dir, &all)
    }

    /// A window's tabs now. Written straight through, so a crash keeps the last state.
    ///
    /// `alive` is the labels of the explorer windows that exist right now (`None`: do not prune).
    /// Outside a quit, a window kept as "closed last" that is no longer alive is dropped here —
    /// the app outlived it (a Mac in the Dock) and opened a new window, so it is not what is open
    /// at quit any more. During a quit nothing is pruned: windows are being torn down one by one.
    pub fn save(&self, window: WindowTabs, alive: Option<&HashSet<String>>) -> Result<()> {
        let mut inner = self.lock();
        if let (false, Some(alive)) = (inner.quitting, alive) {
            let me = window.label.clone();
            inner
                .current
                .windows
                .retain(|w| w.label == me || alive.contains(&w.label));
        }
        inner.current.put(window);
        self.flush(&inner)
    }

    /// Keep `windows` (tabs and active tab each) in the file until this run opens them, or drop
    /// them with an empty list once it has. Replaces what was held before. A held window keeps
    /// the bounds the last run gave it: found by its tabs, else the next one no other held
    /// window took, as `restore_bounds` does (a tab that no longer opens was dropped).
    pub fn hold(&self, windows: Vec<(Vec<String>, usize)>) -> Result<()> {
        let mut inner = self.lock();
        let mut taken = Vec::new();
        let held = windows
            .into_iter()
            .enumerate()
            .map(|(i, (tabs, active))| {
                let at = pick(&inner.last_run, &tabs, &taken);
                taken.extend(at);
                WindowTabs {
                    label: format!("{HELD}{}", i + 1),
                    bounds: at.and_then(|at| inner.last_run[at].bounds),
                    tabs,
                    active,
                }
            })
            .collect();
        inner.held = held;
        self.flush(&inner)
    }

    /// An explorer window is gone. Forgotten only when it was closed on its own — other explorer
    /// windows still open and the process not quitting; otherwise it is one of the windows the
    /// next start brings back.
    pub fn window_closed(&self, label: &str, others_open: bool) -> Result<()> {
        let mut inner = self.lock();
        if inner.quitting {
            return Ok(());
        }
        if !others_open {
            // the app may outlive it (a Mac in the Dock): the window rebuilt next starts from it
            let kept: Vec<WindowTabs> = inner
                .current
                .windows
                .iter()
                .filter(|w| w.label == label)
                .cloned()
                .collect();
            if !kept.is_empty() {
                inner.closed_last = Some(Session { windows: kept });
            }
            inner.closed_last_bounds = inner.bounds.get(label).copied();
            return Ok(());
        }
        inner.bounds.remove(label);
        if inner.current.forget(label) {
            self.flush(&inner)?;
        }
        Ok(())
    }

    /// The process is about to end: from here every window it destroys is kept.
    pub fn quit(&self) {
        self.lock().quitting = true;
    }

    /// A window's size and place now. Written to disk only once the window has reported its
    /// tabs: an entry with bounds and no tabs would come back as an empty window.
    pub fn save_bounds(&self, label: &str, bounds: Bounds) -> Result<()> {
        let mut inner = self.lock();
        if inner.bounds.get(label) == Some(&bounds) {
            return Ok(());
        }
        inner.bounds.insert(label.to_string(), bounds);
        if inner.current.windows.iter().any(|w| w.label == label) {
            self.flush(&inner)?;
        }
        Ok(())
    }

    /// The bounds this run last saved for `label`.
    pub fn bounds_of(&self, label: &str) -> Option<Bounds> {
        self.lock().bounds.get(label).copied()
    }

    /// The bounds a window being built takes, kept as its own until it moves. `main`: the window
    /// closed last when a Mac Dock click rebuilds it, else the last run's `main` (none saved: its
    /// first window, whose tabs `main` gets), and that only the first time. A window restored
    /// with `tabs`: the last run's window with those tabs, else the next one not taken yet (a
    /// tab that no longer opens was dropped from the plan); each taken once. A new window
    /// (`tabs` `None`: Ctrl+N, a dragged-out tab) gets none and cascades.
    pub fn restore_bounds(&self, label: &str, tabs: Option<&[String]>) -> Option<Bounds> {
        let mut inner = self.lock();
        let taken = if label == "main" {
            match inner.closed_last_bounds.take() {
                Some(b) => Some(b),
                None if inner.main_restored => None,
                None => {
                    inner.main_restored = true;
                    // the page gives `main` the first saved window's tabs (`planRestore`), so
                    // with no `main` saved it is that window coming back
                    let at = inner.last_run.iter().position(|w| w.label == "main");
                    let at = at.or((!inner.last_run.is_empty()).then_some(0))?;
                    inner.last_run.remove(at).bounds
                }
            }
        } else {
            let at = pick(&inner.last_run, tabs?, &[])?;
            inner.last_run.remove(at).bounds
        }?;
        inner.bounds.insert(label.to_string(), taken);
        Some(taken)
    }
}

/// The last run's window a restored one with `tabs` comes back as: the first with exactly those
/// tabs, else the first in order — never `main` (it takes its own) nor one already `taken`.
fn pick(windows: &[WindowTabs], tabs: &[String], taken: &[usize]) -> Option<usize> {
    let others: Vec<usize> = (0..windows.len())
        .filter(|i| windows[*i].label != "main" && !taken.contains(i))
        .collect();
    others
        .iter()
        .copied()
        .find(|&i| windows[i].tabs == tabs)
        .or(others.first().copied())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trove-session-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn win(label: &str, tabs: &[&str], active: usize) -> WindowTabs {
        WindowTabs {
            label: label.into(),
            tabs: tabs.iter().map(|s| s.to_string()).collect(),
            active,
            bounds: None,
        }
    }

    #[test]
    fn two_windows_tabs_round_trip_to_the_next_run() {
        let dir = scratch("two");
        let run = Store::new(dir.clone());
        assert_eq!(
            run.take_previous(),
            None,
            "a first run has nothing to restore"
        );
        // saved out of order, the second window first: still main first on disk
        run.save(win("main-2", &["D:\\x", "D:\\y"], 1), None)
            .unwrap();
        run.save(win("main", &["C:\\a"], 0), None).unwrap();
        run.save(win("main", &["C:\\a", "C:\\b"], 1), None).unwrap();
        // a quit tears both down: both kept
        run.quit();
        run.window_closed("main", true).unwrap();
        run.window_closed("main-2", false).unwrap();

        let next = Store::new(dir.clone());
        assert_eq!(
            next.take_previous(),
            Some(Session {
                windows: vec![
                    win("main", &["C:\\a", "C:\\b"], 1),
                    win("main-2", &["D:\\x", "D:\\y"], 1)
                ]
            })
        );
        assert_eq!(next.take_previous(), None, "handed out once per run");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_window_closed_before_quit_is_dropped_and_the_last_one_kept() {
        let dir = scratch("closed");
        let run = Store::new(dir.clone());
        run.save(win("main", &["C:\\a"], 0), None).unwrap();
        run.save(win("main-2", &["D:\\x"], 0), None).unwrap();
        run.save(win("main-3", &["E:\\z"], 0), None).unwrap();
        // main-2 closed on its own while the others stay
        run.window_closed("main-2", true).unwrap();
        // then the last two closed one after the other, no quit: main-3 had company, main did not
        run.window_closed("main-3", true).unwrap();
        run.window_closed("main", false).unwrap();
        assert_eq!(
            read(&dir),
            Some(Session {
                windows: vec![win("main", &["C:\\a"], 0)]
            })
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_last_run_is_read_before_this_run_overwrites_it() {
        let dir = scratch("order");
        write(
            &dir,
            &Session {
                windows: vec![win("main", &["C:\\old"], 0), win("main-5", &["D:\\old"], 0)],
            },
        )
        .unwrap();
        let run = Store::new(dir.clone());
        // this run's main saves before it asks for the old session
        run.save(win("main", &["C:\\new"], 0), None).unwrap();
        assert_eq!(run.take_previous().unwrap().windows.len(), 2);
        // the old main-5 is not carried into this run's file
        assert_eq!(
            read(&dir),
            Some(Session {
                windows: vec![win("main", &["C:\\new"], 0)]
            })
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_or_unreadable_file_is_no_session() {
        let dir = scratch("bad");
        assert_eq!(read(&dir), None);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), b"not json").unwrap();
        assert_eq!(read(&dir), None);
        assert_eq!(Store::new(dir.clone()).take_previous(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn alive(labels: &[&str]) -> HashSet<String> {
        labels.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_window_kept_as_closed_last_is_pruned_once_a_new_window_saves() {
        // a Mac: main and main-2 open; main closed (dropped), main-2 closed last (kept), the app
        // stays in the Dock; a Dock click rebuilds main, which saves while main-2 is not alive
        let dir = scratch("stale");
        let run = Store::new(dir.clone());
        run.save(
            win("main", &["C:\\a"], 0),
            Some(&alive(&["main", "main-2"])),
        )
        .unwrap();
        run.save(
            win("main-2", &["D:\\x"], 0),
            Some(&alive(&["main", "main-2"])),
        )
        .unwrap();
        run.window_closed("main", true).unwrap();
        run.window_closed("main-2", false).unwrap();
        assert_eq!(
            read(&dir),
            Some(Session {
                windows: vec![win("main-2", &["D:\\x"], 0)]
            }),
            "the last window closed is kept"
        );
        run.save(win("main", &["C:\\new"], 0), Some(&alive(&["main"])))
            .unwrap();
        assert_eq!(
            read(&dir),
            Some(Session {
                windows: vec![win("main", &["C:\\new"], 0)]
            }),
            "only the window alive now is left"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_dock_rebuild_gets_the_last_window_with_its_active_tab() {
        // a Mac: the last run's session handed out at start; then main, on its third tab, is
        // closed last and the app stays in the Dock; a Dock click rebuilds main, which asks again
        let dir = scratch("dock");
        let run = Store::new(dir.clone());
        let _ = run.take_previous();
        run.save(win("main", &["C:\\a", "C:\\b", "C:\\c"], 2), None)
            .unwrap();
        run.window_closed("main", false).unwrap();
        assert_eq!(
            run.take_previous(),
            Some(Session {
                windows: vec![win("main", &["C:\\a", "C:\\b", "C:\\c"], 2)]
            }),
            "the rebuilt main gets the closed window's tabs and active tab"
        );
        assert_eq!(run.take_previous(), None, "handed out once");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_window_closed_with_company_or_by_a_quit_is_not_handed_to_a_rebuild() {
        let dir = scratch("dock-none");
        let run = Store::new(dir.clone());
        let _ = run.take_previous();
        run.save(win("main", &["C:\\a"], 0), None).unwrap();
        run.save(win("main-2", &["D:\\x"], 0), None).unwrap();
        run.window_closed("main-2", true).unwrap();
        assert_eq!(run.take_previous(), None, "other windows still open");
        run.quit();
        run.window_closed("main", false).unwrap();
        assert_eq!(
            run.take_previous(),
            None,
            "a quit hands nothing to this run"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn nothing_is_pruned_while_quitting() {
        let dir = scratch("quitprune");
        let run = Store::new(dir.clone());
        run.save(win("main", &["C:\\a"], 0), None).unwrap();
        run.save(win("main-2", &["D:\\x"], 0), None).unwrap();
        run.quit();
        run.window_closed("main-2", true).unwrap();
        // a last save from main as the quit tears windows down: main-2 is gone but stays
        run.save(win("main", &["C:\\b"], 0), Some(&alive(&["main"])))
            .unwrap();
        assert_eq!(
            Store::new(dir.clone()).take_previous(),
            Some(Session {
                windows: vec![win("main", &["C:\\b"], 0), win("main-2", &["D:\\x"], 0)]
            })
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn held_windows_survive_a_quit_until_they_are_opened() {
        let dir = scratch("held");
        let run = Store::new(dir.clone());
        run.save(win("main", &["C:\\a"], 0), Some(&alive(&["main"])))
            .unwrap();
        run.hold(vec![(vec!["D:\\x".into(), "D:\\y".into()], 1)])
            .unwrap();
        // a later save prunes dead live windows, never the held ones
        run.save(win("main", &["C:\\b"], 0), Some(&alive(&["main"])))
            .unwrap();
        assert_eq!(
            read(&dir),
            Some(Session {
                windows: vec![
                    win("main", &["C:\\b"], 0),
                    win("held-1", &["D:\\x", "D:\\y"], 1)
                ]
            }),
            "a quit from the tray now still brings the held window back"
        );
        // shown: the held window is released and opened as a live one
        run.hold(vec![]).unwrap();
        run.save(
            win("main-2", &["D:\\x", "D:\\y"], 1),
            Some(&alive(&["main", "main-2"])),
        )
        .unwrap();
        assert_eq!(read(&dir).unwrap().windows.len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_write_leaves_no_temp_file() {
        let dir = scratch("tmp");
        std::fs::create_dir_all(dir.join(FILE_NAME)).unwrap(); // a folder where the file goes
        let session = Session {
            windows: vec![win("main", &["C:\\a"], 0)],
        };
        assert!(write(&dir, &session).is_err());
        let left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left.len(), 1, "only the blocking folder: {left:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn rect(x: i32, y: i32, w: u32, h: u32) -> Bounds {
        Bounds {
            x,
            y,
            w,
            h,
            maximized: false,
        }
    }

    fn screen(x: i32, y: i32, w: u32, h: u32, scale: f64, primary: bool) -> Screen {
        Screen {
            x,
            y,
            w,
            h,
            scale,
            primary,
        }
    }

    /// A 1920×1040 primary (taskbar taken off) and a 2560×1400 at 150 % to its right.
    fn two_screens() -> Vec<Screen> {
        vec![
            screen(0, 0, 1920, 1040, 1.0, true),
            screen(1920, 0, 2560, 1400, 1.5, false),
        ]
    }

    #[test]
    fn a_window_on_screen_stays_where_it_was() {
        let on_first = rect(100, 80, 1200, 760);
        assert_eq!(fit_to_monitors(on_first, &two_screens()), on_first);
        let on_second = rect(2200, 100, 1800, 1140);
        assert_eq!(fit_to_monitors(on_second, &two_screens()), on_second);
    }

    #[test]
    fn a_window_on_a_monitor_that_is_gone_moves_to_the_primary_one() {
        // it was on the second screen, which is unplugged now; the primary is listed second
        let screens = vec![
            screen(-1920, 0, 1920, 1040, 1.0, false),
            screen(0, 0, 1920, 1040, 1.0, true),
        ];
        assert_eq!(
            fit_to_monitors(rect(2200, 100, 1200, 760), &screens),
            rect(360, 140, 1200, 760),
            "centred on the primary, size kept"
        );
    }

    #[test]
    fn a_window_partly_off_screen_is_pulled_in() {
        let screens = two_screens();
        // hanging off the bottom-left corner of the primary
        assert_eq!(
            fit_to_monitors(rect(-300, 600, 1200, 760), &screens),
            rect(0, 280, 1200, 760)
        );
        // bigger than the screen it is on: shrunk to its work area
        assert_eq!(
            fit_to_monitors(rect(10, 10, 3000, 2000), &screens[..1]),
            rect(0, 0, 1920, 1040)
        );
    }

    #[test]
    fn a_window_too_small_grows_to_the_minimum_at_its_monitors_scale() {
        let screens = two_screens();
        assert_eq!(
            fit_to_monitors(rect(100, 100, 300, 200), &screens),
            rect(100, 100, 800, 500)
        );
        // on the 150 % screen, 800×500 logical is 1200×750 physical
        assert_eq!(
            fit_to_monitors(rect(2000, 100, 300, 200), &screens),
            rect(2000, 100, 1200, 750)
        );
    }

    #[test]
    fn the_maximized_flag_is_kept() {
        let saved = Bounds {
            maximized: true,
            ..rect(5000, 5000, 1200, 760)
        };
        let fitted = fit_to_monitors(saved, &two_screens());
        assert!(fitted.maximized);
        assert_eq!(
            fitted,
            Bounds {
                maximized: true,
                ..rect(360, 140, 1200, 760)
            }
        );
        // no monitors reported at all: left as saved
        assert_eq!(fit_to_monitors(saved, &[]), saved);
    }

    #[test]
    fn a_session_file_with_no_bounds_still_loads() {
        let dir = scratch("nobounds");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(FILE_NAME),
            br#"{ "windows": [ { "label": "main", "tabs": ["C:\\a"], "active": 0 } ] }"#,
        )
        .unwrap();
        assert_eq!(
            read(&dir),
            Some(Session {
                windows: vec![win("main", &["C:\\a"], 0)]
            })
        );
        let run = Store::new(dir.clone());
        assert_eq!(run.restore_bounds("main", None), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bounds_round_trip_to_the_next_run_beside_the_tabs() {
        let dir = scratch("bounds");
        let run = Store::new(dir.clone());
        let main_at = rect(100, 80, 1200, 760);
        let second_at = Bounds {
            maximized: true,
            ..rect(2000, 50, 1400, 900)
        };
        // a move before the page reported its tabs is not written yet: no empty window on disk
        run.save_bounds("main", main_at).unwrap();
        assert_eq!(read(&dir), None);
        run.save(win("main", &["C:\\a"], 0), None).unwrap();
        run.save(win("main-2", &["D:\\x"], 0), None).unwrap();
        run.save_bounds("main-2", second_at).unwrap();
        // a later tab save does not wipe the bounds
        run.save(win("main", &["C:\\a", "C:\\b"], 1), None).unwrap();
        let on_disk = read(&dir).unwrap();
        assert_eq!(on_disk.windows[0].bounds, Some(main_at));
        assert_eq!(on_disk.windows[1].bounds, Some(second_at));

        let next = Store::new(dir.clone());
        assert_eq!(next.restore_bounds("main", None), Some(main_at));
        assert_eq!(next.restore_bounds("main", None), None, "taken once");
        // a new window (Ctrl+N) cascades; the restored one gets its bounds under its new label
        assert_eq!(next.restore_bounds("main-2", None), None);
        assert_eq!(
            next.restore_bounds("main-3", Some(&["D:\\x".to_string()])),
            Some(second_at)
        );
        assert_eq!(next.bounds_of("main-3"), Some(second_at));
        // the old session still hands out its tabs, bounds and all
        let previous = next.take_previous().unwrap();
        assert_eq!(previous.windows[0].tabs, vec!["C:\\a", "C:\\b"]);
        assert_eq!(previous.windows[1].bounds, Some(second_at));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_restored_window_whose_tabs_changed_takes_the_next_bounds_in_order() {
        let dir = scratch("bounds-order");
        let a = rect(10, 10, 900, 600);
        let b = rect(400, 300, 1000, 700);
        let run = Store::new(dir.clone());
        for (label, tab, at) in [("main-2", "D:\\x", a), ("main-3", "E:\\y", b)] {
            run.save(win(label, &[tab], 0), None).unwrap();
            run.save_bounds(label, at).unwrap();
        }
        let next = Store::new(dir.clone());
        // E:\y matched by its tabs; D:\x's tab no longer opens, so its window comes back empty
        assert_eq!(
            next.restore_bounds("main-2", Some(&["E:\\y".to_string()])),
            Some(b)
        );
        assert_eq!(next.restore_bounds("main-3", Some(&[])), Some(a));
        assert_eq!(next.restore_bounds("main-4", Some(&[])), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_held_window_keeps_its_bounds_and_a_dock_rebuild_gets_the_closed_ones() {
        let dir = scratch("bounds-held");
        let at = rect(300, 200, 1000, 700);
        let run = Store::new(dir.clone());
        run.save(win("main-2", &["D:\\x"], 0), None).unwrap();
        run.save_bounds("main-2", at).unwrap();
        let next = Store::new(dir.clone());
        next.hold(vec![(vec!["D:\\x".into()], 0)]).unwrap();
        assert_eq!(read(&dir).unwrap().windows[0].bounds, Some(at));
        // a Mac: the window closed last, alone; the Dock rebuilds `main` where it was
        next.save(win("main-5", &["F:\\z"], 0), None).unwrap();
        next.save_bounds("main-5", rect(50, 60, 900, 600)).unwrap();
        next.window_closed("main-5", false).unwrap();
        assert_eq!(
            next.restore_bounds("main", None),
            Some(rect(50, 60, 900, 600))
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_held_window_whose_tabs_changed_takes_the_next_bounds_in_order() {
        let dir = scratch("bounds-held-order");
        let a = rect(10, 10, 900, 600);
        let b = rect(400, 300, 1000, 700);
        let run = Store::new(dir.clone());
        for (label, tab, at) in [("main-2", "D:\\x", a), ("main-3", "E:\\y", b)] {
            run.save(win(label, &[tab], 0), None).unwrap();
            run.save_bounds(label, at).unwrap();
        }
        let next = Store::new(dir.clone());
        // E:\y matched by its tabs; D:\x's tab no longer opens, so its window is held empty
        next.hold(vec![(vec!["E:\\y".into()], 0), (vec![], 0)])
            .unwrap();
        let held = read(&dir).unwrap().windows;
        assert_eq!(held[0].bounds, Some(b));
        assert_eq!(held[1].bounds, Some(a), "the next one not taken, not none");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_window_closed_on_its_own_takes_its_bounds_with_it() {
        let dir = scratch("bounds-forget");
        let run = Store::new(dir.clone());
        run.save(win("main", &["C:\\a"], 0), None).unwrap();
        run.save(win("main-2", &["D:\\x"], 0), None).unwrap();
        run.save_bounds("main", rect(10, 10, 900, 600)).unwrap();
        // `main` closed while main-2 stays: forgotten, its place with it
        run.window_closed("main", true).unwrap();
        assert_eq!(run.bounds_of("main"), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn main_takes_the_first_windows_bounds_when_no_main_was_saved() {
        let dir = scratch("bounds-no-main");
        let a = rect(10, 10, 900, 600);
        let b = rect(400, 300, 1000, 700);
        let run = Store::new(dir.clone());
        for (label, tab, at) in [("main-2", "A:\\", a), ("main-3", "B:\\", b)] {
            run.save(win(label, &[tab], 0), None).unwrap();
            run.save_bounds(label, at).unwrap();
        }
        let next = Store::new(dir.clone());
        // the page gives `main` the first window's tabs (A), so `main` gets A's place
        assert_eq!(next.restore_bounds("main", None), Some(a));
        assert_eq!(next.bounds_of("main"), Some(a));
        // a `main` rebuilt later takes no other window's place
        assert_eq!(next.restore_bounds("main", None), None);
        // A is taken: the window restored with B's tabs gets B's, and nothing is left after
        assert_eq!(
            next.restore_bounds("main-2", Some(&["B:\\".to_string()])),
            Some(b)
        );
        assert_eq!(next.restore_bounds("main-3", Some(&[])), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn maxed(b: Bounds) -> Bounds {
        Bounds {
            maximized: true,
            ..b
        }
    }

    #[test]
    fn a_maximized_window_keeps_its_rect_on_the_monitor_it_was_on() {
        let screens = two_screens();
        let before = rect(100, 80, 1200, 760);
        let now = rect(0, 0, 1920, 1040);
        assert_eq!(maximized_bounds(now, Some(before), &screens), maxed(before));
    }

    #[test]
    fn a_window_maximized_onto_another_monitor_comes_back_there() {
        let screens = two_screens();
        // normal on the primary, then Win+Shift+Right: maximized on the second screen
        let before = rect(100, 80, 1200, 760);
        let now = rect(1920, 0, 2560, 1400);
        assert_eq!(
            maximized_bounds(now, Some(before), &screens),
            maxed(rect(2020, 80, 1200, 760)),
            "same offset from the corner, same size"
        );
        // and back: a rect that would hang off the smaller screen is pulled in and shrunk
        let before = rect(3000, 600, 2400, 1300);
        let now = rect(0, 0, 1920, 1040);
        assert_eq!(
            maximized_bounds(now, Some(before), &screens),
            maxed(rect(0, 0, 1920, 1040))
        );
    }

    #[test]
    fn a_first_save_while_maximized_is_the_default_size_centred_not_the_full_screen() {
        let screens = two_screens();
        assert_eq!(
            maximized_bounds(rect(0, 0, 1920, 1040), None, &screens),
            maxed(rect(360, 140, 1200, 760))
        );
        // on the 150 % screen: 1200×760 logical is 1800×1140 physical
        assert_eq!(
            maximized_bounds(rect(1920, 0, 2560, 1400), None, &screens),
            maxed(rect(2300, 130, 1800, 1140))
        );
        // no monitors reported: the rect as it is
        let before = rect(5, 5, 900, 600);
        assert_eq!(
            maximized_bounds(rect(0, 0, 1920, 1040), Some(before), &[]),
            maxed(before)
        );
    }

    #[test]
    fn positions_are_hidden_only_under_wayland_proper() {
        assert!(!positions_hidden(None, None), "X11 or not Linux");
        assert!(!positions_hidden(Some(""), None));
        assert!(positions_hidden(Some("wayland-0"), None));
        assert!(positions_hidden(Some("wayland-0"), Some("wayland,x11")));
        // forced onto XWayland, where positions work
        assert!(!positions_hidden(Some("wayland-0"), Some("x11")));
        assert!(!positions_hidden(Some("wayland-0"), Some(" x11 ,wayland")));
        // a backend GDK has no name for here: as if unset
        assert!(positions_hidden(Some("wayland-0"), Some("*")));
    }
}

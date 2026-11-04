//! Fixed pools of long-lived threads for the `icon://` and `preview://` protocols.
//!
//! The protocol handlers used to `std::thread::spawn` per request. Scrolling a large folder
//! asks for thousands of icons in a burst, so that was thousands of OS threads — each paying
//! a stack allocation and a `CoInitializeEx` (see `icons::ensure_com`) it never undid, since
//! the thread simply exited. A cold icon cache on a tester's first run is exactly the burst
//! that makes that visible.
//!
//! These threads are created once and never exit, so COM is initialised once per worker and
//! the queue absorbs the burst instead of the scheduler.
//!
//! ⛔ One queue was not enough. Every `thumb/` request is a full shell `GetImage` behind one
//! global lock, and the pool served them oldest first with no limit: a fast scroll through a
//! photo folder queued thousands, the tiles on screen waited behind every tile already
//! scrolled past, and the cheap `ext/` icons a list row needs waited behind all of it. So the
//! icon pool has two lanes:
//! - **quick** (`ext/`, `app/`): any worker, oldest first, never capped — a memory hit after
//!   the first lookup, and the first is a single `SHGetFileInfoW` on a fake name.
//! - **slow** (`file/`, `thumb/`, `big/`): at most `SLOW_SLOTS` workers at once, so some
//!   worker is always free for the quick lane; **newest first**, because the newest request is
//!   the tile on screen now; and the queued image jobs are capped — past `IMAGE_QUEUE_CAP` the
//!   *oldest* is answered "busy" at once instead of drawn (`Fate::Shed`).
//!
//! Previews get a pool of their own: a few workers, so one long video read never holds a
//! worker an icon is waiting on, and a burst of `Range` requests cannot become a thread each.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

type Job = Box<dyn FnOnce() + Send + 'static>;
type SlowJob = Box<dyn FnOnce(Fate) + Send + 'static>;

/// What a slow-lane job is told to do when it leaves the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fate {
    /// Do the work.
    Run,
    /// Too many newer requests arrived; answer cheaply and do nothing else.
    Shed,
}

/// Enough to keep the disk busy on cache hits; the shell lookups behind a miss are serialised
/// by `icons::SHELL` anyway, so more threads would only queue deeper.
const WORKERS: usize = 4;

/// Workers the slow lane may hold at once. Two: one drawing behind the shell lock, one with
/// its next job ready (a disk-cache hit needs no lock at all) — and two left for `ext/`.
const SLOW_SLOTS: usize = 2;

/// Queued `thumb/` / `big/` jobs past which the oldest is shed. More than a screenful of
/// tiles at the smallest grid size on a large monitor (roughly 300), so a first view of a
/// folder is never shed; far fewer than the thousands a fast scroll used to pile up.
const IMAGE_QUEUE_CAP: usize = 512;

/// Preview workers. A preview is one file the person clicked, plus the `Range` requests a
/// `<video>` makes while it plays and seeks — three keep up with that and bound the memory.
const PREVIEW_WORKERS: usize = 3;

struct Slow {
    job: SlowJob,
    /// Image jobs may be shed; `file/` icons may not — a list row has nothing to fall back to.
    sheddable: bool,
}

#[derive(Default)]
struct State {
    quick: VecDeque<Job>,
    slow: VecDeque<Slow>,
    /// How many of `slow` are sheddable, so the cap check is not a scan per request.
    sheddable: usize,
    slow_running: usize,
}

struct Shared {
    state: Mutex<State>,
    ready: Condvar,
    slow_slots: usize,
    shed_cap: usize,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A pool: `workers` threads sharing one quick and one slow queue.
pub struct Pool {
    shared: Arc<Shared>,
}

/// Gives a slow slot back when the job ends — on a panic too, or the lane would shrink by one
/// for every job that ever failed.
struct SlotBack<'a>(&'a Shared);

impl Drop for SlotBack<'_> {
    fn drop(&mut self) {
        self.0.lock().slow_running -= 1;
        // a worker parked because the slots were full may take the next slow job now
        self.0.ready.notify_all();
    }
}

impl Pool {
    fn start(workers: usize, slow_slots: usize, shed_cap: usize) -> Pool {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            ready: Condvar::new(),
            slow_slots,
            shed_cap,
        });
        for _ in 0..workers {
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || work(&shared));
        }
        Pool { shared }
    }

    fn quick(&self, job: Job) {
        self.shared.lock().quick.push_back(job);
        self.shared.ready.notify_one();
    }

    fn slow(&self, sheddable: bool, job: SlowJob) {
        let shed = {
            let mut st = self.shared.lock();
            st.slow.push_back(Slow { job, sheddable });
            if sheddable {
                st.sheddable += 1;
            }
            let mut shed = Vec::new();
            while st.sheddable > self.shared.shed_cap {
                // the oldest sheddable: near the front, since everything is pushed at the back
                let Some(i) = st.slow.iter().position(|s| s.sheddable) else {
                    break;
                };
                if let Some(s) = st.slow.remove(i) {
                    st.sheddable -= 1;
                    shed.push(s.job);
                }
            }
            shed
        };
        self.shared.ready.notify_one();
        // answered outside the lock: a responder is the webview's code, not ours
        for job in shed {
            job(Fate::Shed);
        }
    }
}

fn work(shared: &Shared) {
    let mut st = shared.lock();
    loop {
        if let Some(job) = st.quick.pop_front() {
            drop(st);
            job();
            st = shared.lock();
            continue;
        }
        if st.slow_running < shared.slow_slots {
            // newest first: the request made last is the tile on screen now
            if let Some(s) = st.slow.pop_back() {
                if s.sheddable {
                    st.sheddable -= 1;
                }
                st.slow_running += 1;
                drop(st);
                {
                    let _back = SlotBack(shared);
                    (s.job)(Fate::Run);
                }
                st = shared.lock();
                continue;
            }
        }
        st = shared.ready.wait(st).unwrap_or_else(|e| e.into_inner());
    }
}

fn icon_pool() -> &'static Pool {
    static POOL: OnceLock<Pool> = OnceLock::new();
    POOL.get_or_init(|| Pool::start(WORKERS, SLOW_SLOTS, IMAGE_QUEUE_CAP))
}

fn preview_pool() -> &'static Pool {
    static POOL: OnceLock<Pool> = OnceLock::new();
    POOL.get_or_init(|| Pool::start(PREVIEW_WORKERS, 0, 0))
}

/// Run `job` on the icon pool's quick lane.
pub fn spawn(job: impl FnOnce() + Send + 'static) {
    icon_pool().quick(Box::new(job));
}

/// Run `job` on the icon pool's slow lane, newest first. A `sheddable` job may instead be
/// called with `Fate::Shed` — at once, on the caller's thread — when newer ones push it past
/// the cap; it must then answer cheaply.
pub fn spawn_slow(sheddable: bool, job: impl FnOnce(Fate) + Send + 'static) {
    icon_pool().slow(sheddable, Box::new(job));
}

/// Run `job` on the preview pool.
pub fn spawn_preview(job: impl FnOnce() + Send + 'static) {
    preview_pool().quick(Box::new(job));
}

// ---- Deadlines (plan 08 Phase D: nothing blocks the UI, ever) ----------------------------
//
// ⛔ A universal policy, not a per-call-site fix: every probe, listing, stat or icon request on
// a `Reach::Remote` path (UNC share, mapped network letter, removable or optical drive) runs
// through `guarded`. The work moves to a thread of its own and the caller waits at most the
// deadline. Windows cannot cancel a call stuck in the SMB redirector, so a late thread is left
// to finish on its own; what the deadline buys is that nobody waits for it. WSL paths
// (`Reach::Wsl`) and local disks run inline, as before: no thread, no deadline.

/// A stat, a path-kind probe or one icon on a remote place.
pub const PROBE_WAIT: Duration = Duration::from_secs(3);

/// One folder listing on a remote place (plan 05 5.3c: 10 s).
pub const LIST_WAIT: Duration = Duration::from_secs(10);

/// After a place missed a deadline, icon requests on it are refused at once for this long
/// instead of each starting a thread that would hang too. A listing always tries again.
const DEAD_FOR: Duration = Duration::from_secs(30);

/// A remote place that did not answer in time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Late {
    /// `\\server\share`, or the drive root, that did not answer.
    pub place: String,
    /// How long the caller waited.
    pub waited: Duration,
}

/// The words the frontend matches (`isUnreachableError` in `src/lib/utils/network.ts`); keep
/// the two in step.
pub const LATE_MARK: &str = "did not answer in";

impl std::fmt::Display for Late {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let secs = self.waited.as_secs().max(1);
        write!(f, "{} {LATE_MARK} {secs} s", self.place)
    }
}

/// The place a deadline is kept per: `\\server\share` for UNC, `X:\` for a letter.
pub fn place_of(path: &str) -> String {
    if let Some(root) = crate::core::mounts::share_root(path) {
        return root;
    }
    let mut chars = path.chars();
    match (chars.next(), chars.next()) {
        (Some(l), Some(':')) => format!("{}:\\", l.to_ascii_uppercase()),
        _ => path.to_string(),
    }
}

/// Places that missed a deadline, and when.
fn lock_dead() -> std::sync::MutexGuard<'static, HashMap<String, Instant>> {
    static DEAD: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    DEAD.get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Whether `place` missed a deadline within `DEAD_FOR`.
pub fn recently_dead(place: &str) -> bool {
    lock_dead()
        .get(place)
        .is_some_and(|at| at.elapsed() < DEAD_FOR)
}

/// Runs `job` on its own thread and waits at most `wait` for it. `what` and `path` name the
/// work for the log. ⚠️ Every miss is a `warn!` with the place (share or drive) and the milliseconds (plan 08 D5):
/// a deadline that fires silently is how "the UI froze on a share" regresses unnoticed.
pub fn within<T: Send + 'static>(
    what: &'static str,
    path: &str,
    wait: Duration,
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Late> {
    let place = place_of(path);
    let started = Instant::now();
    let (tx, rx) = std::sync::mpsc::channel();
    let late_place = place.clone();
    let spawned = std::thread::Builder::new()
        .name(format!("deadline-{what}"))
        .spawn(move || {
            let out = job();
            // it answered, so it is not dead (a late error answer counts: the server is up)
            lock_dead().remove(&late_place);
            if tx.send(out).is_err() {
                // the caller gave up on us; say when the place did answer
                let ms = started.elapsed().as_millis();
                log::warn!("deadline: {what} on {late_place} answered late, after {ms} ms");
            }
        });
    if let Err(e) = spawned {
        log::warn!("deadline: could not start a thread for {what} ({e}); refused");
        return Err(Late {
            place,
            waited: Duration::ZERO,
        });
    }
    match rx.recv_timeout(wait) {
        Ok(out) => Ok(out),
        Err(_) => {
            let ms = started.elapsed().as_millis();
            // the share or drive only at warn: a full path is personal (plan 15 D.8.2)
            log::warn!("deadline: {what} on {place} gave up after {ms} ms");
            log::debug!("deadline: {what} {path} gave up after {ms} ms");
            lock_dead().insert(place.clone(), Instant::now());
            Err(Late {
                place,
                waited: wait,
            })
        }
    }
}

/// `job` inline for a local or WSL path; on a remote one, `within` the deadline.
pub fn guarded<T: Send + 'static>(
    what: &'static str,
    path: &str,
    wait: Duration,
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Late> {
    match crate::core::mounts::reach_of(path) {
        crate::core::mounts::Reach::Remote => within(what, path, wait, job),
        _ => Ok(job()),
    }
}

/// `guarded`, but refused at once while the place is `recently_dead`: for the many small
/// requests (icons) a listing fires, so a dead share costs one thread, not one per row.
pub fn guarded_unless_dead<T: Send + 'static>(
    what: &'static str,
    path: &str,
    wait: Duration,
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Late> {
    if crate::core::mounts::reach_of(path) == crate::core::mounts::Reach::Remote {
        let place = place_of(path);
        if recently_dead(&place) {
            log::debug!("deadline: {what} on {place} skipped, missed a deadline recently");
            return Err(Late {
                place,
                waited: Duration::ZERO,
            });
        }
    }
    guarded(what, path, wait, job)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::channel;

    #[test]
    fn every_job_runs_and_more_jobs_than_workers_is_fine() {
        static DONE: AtomicUsize = AtomicUsize::new(0);
        let jobs = WORKERS * 25;
        let (tx, rx) = channel::<()>();
        for _ in 0..jobs {
            let tx = tx.clone();
            spawn(move || {
                DONE.fetch_add(1, Ordering::SeqCst);
                let _ = tx.send(());
            });
        }
        drop(tx);
        for _ in 0..jobs {
            rx.recv().expect("every job reports back");
        }
        assert_eq!(DONE.load(Ordering::SeqCst), jobs);
    }

    #[test]
    fn a_slow_job_does_not_stop_the_others() {
        let pool = Pool::start(WORKERS, SLOW_SLOTS, IMAGE_QUEUE_CAP);
        let (tx, rx) = channel::<u8>();
        let slow = tx.clone();
        pool.quick(Box::new(move || {
            std::thread::sleep(Duration::from_millis(150));
            let _ = slow.send(1);
        }));
        for _ in 0..(WORKERS - 1) {
            let quick = tx.clone();
            pool.quick(Box::new(move || {
                let _ = quick.send(0);
            }));
        }
        drop(tx);
        // the quick ones come back before the sleeper: the pool is not serial
        assert_eq!(rx.recv().expect("a quick job answers first"), 0);
    }

    /// A gate the test opens: the slow jobs that are running block on it, so everything else
    /// stays queued and the order it leaves in is observable.
    fn gate() -> (Arc<(Mutex<bool>, Condvar)>, impl Fn() + Send + Clone) {
        let g = Arc::new((Mutex::new(false), Condvar::new()));
        let wait = {
            let g = Arc::clone(&g);
            move || {
                let (m, cv) = &*g;
                let mut open = m.lock().unwrap();
                while !*open {
                    open = cv.wait(open).unwrap();
                }
            }
        };
        (g, wait)
    }

    fn open(g: &(Mutex<bool>, Condvar)) {
        *g.0.lock().unwrap() = true;
        g.1.notify_all();
    }

    #[test]
    fn the_newest_slow_job_runs_first_and_the_oldest_past_the_cap_is_shed() {
        // one slow slot, a cap of 2 sheddable
        let pool = Pool::start(2, 1, 2);
        let (g, wait) = gate();
        let (tx, rx) = channel::<(u32, Fate)>();
        // job 0 takes the only slot and holds it until the gate opens
        let (started_tx, started_rx) = channel();
        {
            let tx = tx.clone();
            let wait = wait.clone();
            pool.slow(
                true,
                Box::new(move |f| {
                    let _ = started_tx.send(());
                    wait();
                    let _ = tx.send((0, f));
                }),
            );
        }
        started_rx.recv().unwrap();
        for n in 1..=4 {
            let tx = tx.clone();
            pool.slow(
                true,
                Box::new(move |f| {
                    let _ = tx.send((n, f));
                }),
            );
        }
        // 4 queued against a cap of 2: the two oldest (1, 2) are answered at once
        assert_eq!(rx.recv().unwrap(), (1, Fate::Shed));
        assert_eq!(rx.recv().unwrap(), (2, Fate::Shed));
        open(&g);
        assert_eq!(rx.recv().unwrap(), (0, Fate::Run));
        // newest first
        assert_eq!(rx.recv().unwrap(), (4, Fate::Run));
        assert_eq!(rx.recv().unwrap(), (3, Fate::Run));
    }

    #[test]
    fn a_job_that_may_not_be_shed_survives_the_cap() {
        let pool = Pool::start(1, 1, 1);
        let (g, wait) = gate();
        let (tx, rx) = channel::<(&'static str, Fate)>();
        let (started_tx, started_rx) = channel();
        pool.slow(
            true,
            Box::new(move |_| {
                let _ = started_tx.send(());
                wait();
            }),
        );
        started_rx.recv().unwrap();
        let send = |name: &'static str, sheddable: bool| {
            let tx = tx.clone();
            pool.slow(
                sheddable,
                Box::new(move |f| {
                    let _ = tx.send((name, f));
                }),
            );
        };
        send("file", false);
        send("thumb-old", true);
        send("thumb-new", true);
        assert_eq!(rx.recv().unwrap(), ("thumb-old", Fate::Shed));
        open(&g);
        let mut ran: Vec<_> = (0..2).map(|_| rx.recv().unwrap()).collect();
        ran.sort_by_key(|r| r.0);
        assert_eq!(
            ran,
            vec![("file", Fate::Run), ("thumb-new", Fate::Run)],
            "the file icon is drawn, never shed"
        );
    }

    #[test]
    fn quick_jobs_are_not_starved_while_every_slow_slot_is_busy() {
        // 3 workers, 2 slow slots: both slots stuck, the third worker still serves `ext/`
        let pool = Pool::start(3, 2, 100);
        let (g, wait) = gate();
        for _ in 0..10 {
            let wait = wait.clone();
            pool.slow(true, Box::new(move |_| wait()));
        }
        let (tx, rx) = channel();
        pool.quick(Box::new(move || {
            let _ = tx.send(());
        }));
        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "a quick job ran while the slow lane was full"
        );
        open(&g);
    }

    #[test]
    fn a_panicking_slow_job_gives_its_slot_back() {
        let pool = Pool::start(2, 1, 10);
        pool.slow(true, Box::new(|_| panic!("a handler blew up")));
        let (tx, rx) = channel();
        pool.slow(
            true,
            Box::new(move |f| {
                let _ = tx.send(f);
            }),
        );
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Ok(Fate::Run));
    }

    #[test]
    fn within_answers_in_time_and_gives_up_on_a_slow_job() {
        assert_eq!(
            within("test", r"\\h\s", Duration::from_secs(5), || 7),
            Ok(7)
        );
        let started = Instant::now();
        let slow = within(
            "test",
            r"\\slow-host\share\x",
            Duration::from_millis(50),
            || {
                std::thread::sleep(Duration::from_millis(400));
            },
        );
        let late = slow.unwrap_err();
        assert!(started.elapsed() < Duration::from_millis(300));
        assert_eq!(late.place, r"\\slow-host\share");
        assert_eq!(late.to_string(), r"\\slow-host\share did not answer in 1 s");
        assert!(recently_dead(r"\\slow-host\share"));
        // the late job finishing clears the mark: the place answered after all
        std::thread::sleep(Duration::from_millis(800));
        assert!(!recently_dead(r"\\slow-host\share"));
    }

    #[test]
    fn local_and_wsl_paths_run_inline_with_no_deadline() {
        let me = std::thread::current().id();
        for p in [r"\\wsl.localhost\Ubuntu\home", r"\\wsl$\Ubuntu", "/home/x"] {
            let ran_on = guarded("test", p, Duration::ZERO, move || {
                std::thread::current().id()
            });
            assert_eq!(ran_on, Ok(me), "{p}");
        }
    }

    #[test]
    fn a_dead_place_refuses_icons_but_not_listings() {
        lock_dead().insert(r"\\gone\share".into(), Instant::now());
        let icon = guarded_unless_dead("icon", r"\\gone\share\a.png", PROBE_WAIT, || 1);
        assert_eq!(icon.unwrap_err().waited, Duration::ZERO);
        assert_eq!(guarded("list", r"\\gone\share", PROBE_WAIT, || 2), Ok(2));
        assert!(!recently_dead(r"\\gone\share"));
    }

    #[test]
    fn places() {
        assert_eq!(place_of(r"\\nas\media\film"), r"\\nas\media");
        assert_eq!(place_of(r"z:\work\a"), r"Z:\");
    }

    /// The real thing: an address nobody answers on (10.255.255.1 is never routed to a host).
    /// Either Windows says "network path not found" quickly, or the deadline cuts the wait;
    /// either way the caller is back within the deadline plus scheduling slack.
    #[cfg(windows)]
    #[test]
    fn an_unreachable_share_never_holds_the_caller() {
        let started = Instant::now();
        let out = guarded("list", r"\\10.255.255.1\x", Duration::from_secs(2), || {
            std::fs::read_dir(r"\\10.255.255.1\x").map(|_| ())
        });
        let took = started.elapsed();
        assert!(took < Duration::from_millis(2_800), "{took:?}");
        match out {
            Err(late) => assert_eq!(late.place, r"\\10.255.255.1\x"),
            Ok(listing) => assert!(listing.is_err()),
        }
    }
}

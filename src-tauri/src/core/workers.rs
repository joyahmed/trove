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

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, OnceLock};

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::channel;
    use std::time::Duration;

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
}

//! The terminal pane's sessions. Output travels back on the `Channel` the frontend hands to
//! `pty_spawn` (one per session, no event name to collide on); the exit is one event, and the
//! shell's own folder report (`pty:cwd`, plan 08 E1) another.
//!
//! ⛔ **One window, one shell — and the backend is what holds it that way.** The pane is per
//! window (`src/lib/state/terminal.svelte.ts`), and the frontend used to be the only thing
//! keeping that true: two overlapping spawns left the first session alive with its id dropped on
//! the floor, a shell writing into the visible pane for the rest of the process (fixed frontend
//! side in `e7afe34`). A dropped id was unrecoverable, because every command here takes an id.
//! So ownership now lives in the map: each session records the window label its `pty_spawn` came
//! from, `pty_spawn` kills whatever that window already owns before it opens anything, and a
//! window's `Destroyed` kills the rest. Losing an id can no longer leak a shell.
//!
//! ⛔ **And the record is a permission, not just a bookkeeping note.** Every command here names
//! its session by a bare id, so an id that reached the wrong window would otherwise let that
//! window write to, resize, follow or kill a shell that is not its own — `pty_write` being the
//! sharp end, since it types into it. So all four go through one ownership test
//! (`Sessions::is_owned`) against the `Window` Tauri injects. The exposure is theoretical — ids
//! come from an `AtomicU64` the frontend never enumerates and never guesses — which is why this
//! is one lookup and no more machinery than that.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Window, WindowEvent};

use crate::core::pty::{self, PtySession};

/// Emitted once when a session's shell ends; payload `PtyExit`.
pub const EXIT_EVENT: &str = "pty:exit";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub session_id: u64,
    pub code: Option<u32>,
}

/// Emitted when a session's shell reports a new folder (OSC 7 / OSC 9;9) that exists; payload
/// `PtyCwd`. The frontend moves the listing there when the pane follows the folder.
pub const CWD_EVENT: &str = "pty:cwd";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyCwd {
    pub session_id: u64,
    pub path: String,
}

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
static SESSIONS: Sessions<Session> = Sessions::new();

/// Which window a session belongs to. A trait rather than a field so the map's own behaviour —
/// the taking, and the dropping outside the lock — is testable without a real ConPTY.
trait Owned {
    fn owner(&self) -> &str;
}

/// One live session: the shell, and the window whose pane asked for it.
struct Session {
    owner: String,
    pty: PtySession,
}

impl Owned for Session {
    fn owner(&self) -> &str {
        &self.owner
    }
}

/// The live sessions by id. `None` until the first one, so the whole thing is a `const` static.
struct Sessions<T>(Mutex<Option<HashMap<u64, T>>>);

impl<T: Owned> Sessions<T> {
    const fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// Run `f` over the map with the lock held. A poisoned lock is taken anyway: the map is
    /// plain ownership records, and refusing to hand them out would leak every shell in it.
    ///
    /// ⛔ `std::sync::Mutex` is not reentrant, so nothing called from inside `f` may call this
    /// again on the same thread. That is why `kill_owned_by` takes the lock itself instead of
    /// being called from within a `with`.
    fn with<R>(&self, f: impl FnOnce(&mut HashMap<u64, T>) -> R) -> R {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        f(guard.get_or_insert_with(HashMap::new))
    }

    /// Kill and forget every session `label` owns; returns how many there were.
    ///
    /// ⛔ **The lock covers the map surgery only — never the drop.** Dropping a `PtySession`
    /// kills the child and closes the pseudo-console, and that can block; meanwhile the child's
    /// own waiter thread is calling `with` to remove its entry. Holding the lock across the drop
    /// would be the deadlock, so the sessions are moved out into `taken` and die after `with`
    /// has returned and the guard is gone. The waiter thread then finds its id already absent,
    /// which is a no-op — removing a key twice is as harmless as draining an empty map.
    ///
    /// Idempotent by construction: it names what to remove by owner, so a second call for the
    /// same label finds nothing and does nothing. No latch is needed, which is what the
    /// `Destroyed`-fires-again problem in `lib.rs` demands.
    fn kill_owned_by(&self, label: &str) -> usize {
        let taken: Vec<T> = self.with(|s| {
            s.extract_if(|_, session| session.owner() == label)
                .map(|(_, session)| session)
                .collect()
        });
        taken.len() // `taken` is dropped as this returns — outside the lock, by design
    }

    /// Whether `id` is in `map` and belongs to `label` — **the one ownership test**, shared by
    /// the by-id lookup below and by `kill_one`, so every command that names a session by id
    /// asks the same question. It takes the map rather than `&self` so it runs under the
    /// caller's lock and cannot re-enter `with`.
    fn is_owned(map: &HashMap<u64, T>, id: u64, label: &str) -> bool {
        map.get(&id).is_some_and(|session| session.owner() == label)
    }

    /// Run `f` over the session `id`, but only if `label` owns it; `None` when there is no such
    /// session **or it is another window's**. Every id-addressed command that reaches into a
    /// live session goes through here, so an id that leaked to the wrong window names nothing.
    ///
    /// The two cases are deliberately the same `None`: the caller turns it into the existing
    /// `No terminal session N`, which tells a window nothing about another window's sessions.
    fn owned<R>(&self, id: u64, label: &str, f: impl FnOnce(&mut T) -> R) -> Option<R> {
        self.with(|s| {
            if Self::is_owned(s, id, label) {
                s.get_mut(&id).map(f)
            } else {
                None
            }
        })
    }

    /// Kill and forget one session by id, **if `label` owns it**; whether there was one. The
    /// single-id twin of `kill_owned_by`, and it obeys the same rule for the same reason: **the
    /// lock covers the removal only, and the session dies after the guard is gone.** The child's
    /// waiter thread takes this very lock to remove its own entry, so a drop inside the critical
    /// section is the deadlock.
    ///
    /// Idempotent: a second call for the same id finds nothing, as does one for an id the
    /// child's own exit handler already removed, as does one for an id this window never owned.
    fn kill_one(&self, id: u64, label: &str) -> bool {
        // The foreign owner, if there is one, is carried out of the closure so the log below
        // happens with the lock released — the same rule the drop obeys.
        let (taken, foreign) = self.with(|s| {
            if Self::is_owned(s, id, label) {
                (s.remove(&id), None)
            } else {
                (None, s.get(&id).map(|other| other.owner().to_string()))
            }
        });
        if let Some(owner) = foreign {
            // `pty_kill` returns `()` and cannot report this to the caller, so the log is the
            // only diagnostic a refused kill leaves.
            log::warn!(
                "window {label} asked to kill terminal session {id}, which belongs to {owner} — ignored"
            );
        }
        taken.is_some() // `taken` is dropped as this returns — outside the lock, by design
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.with(|s| s.len())
    }

    /// Whether the lock is free this instant. Tests only: it is how a session being dropped
    /// proves it was dropped with no lock held.
    #[cfg(test)]
    fn unlocked(&self) -> bool {
        self.0.try_lock().is_ok()
    }
}

fn msg<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn no_session(id: u64) -> String {
    format!("No terminal session {id}")
}

/// Start the shell for `path` and return the session id; output streams on `on_output`.
///
/// `window` is injected by Tauri from the invoke itself — the frontend passes nothing — so the
/// owner of a session is the window that asked for it and cannot be got wrong.
#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    window: Window,
    path: String,
    cols: u16,
    rows: u16,
    on_output: Channel<String>,
    plain: Option<bool>,
) -> Result<u64, String> {
    // `plain`: the uninstall flow's own `/bin/sh` with a known prompt (`pty::plain_shell`)
    let cmd = if plain == Some(true) {
        if cfg!(windows) {
            return Err("There is no plain shell on this system.".into());
        }
        pty::plain_shell(std::env::var("HOME").ok())
    } else {
        pty::shell_for(&path)
    };
    let owner = window.label().to_string();
    // ⛔ Before the lock, never inside `with` below: `kill_owned_by` takes the lock itself.
    // This is the enforcement — whatever this window still owns dies here, whether the frontend
    // remembered its id or not.
    SESSIONS.kill_owned_by(&owner);
    let session_id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    // Spawn and insert under one lock: a shell that dies at once would otherwise have its exit
    // handler remove the entry before it was inserted, leaving the console open for ever.
    let cwd_app = app.clone();
    SESSIONS.with(|s| {
        let session = PtySession::spawn_with_cwd(
            cmd,
            cols,
            rows,
            move |chunk| {
                let _ = on_output.send(chunk);
            },
            move |path| {
                let _ = cwd_app.emit(CWD_EVENT, PtyCwd { session_id, path });
            },
            move |code| {
                // dropping the session closes the console and ends the output stream
                SESSIONS.with(|s| s.remove(&session_id));
                let _ = app.emit(EXIT_EVENT, PtyExit { session_id, code });
            },
        )
        .map_err(msg)?;
        s.insert(
            session_id,
            Session {
                owner,
                pty: session,
            },
        );
        Ok(session_id)
    })
}

/// `window` is injected by Tauri, as in `pty_spawn` — the frontend sends only the id — so this
/// writes into the asking window's own shell or into nothing at all. Keystrokes are the sharpest
/// of the id-addressed edges: without the check, an id that reached the wrong window would type
/// into another window's shell.
#[tauri::command(async)]
pub fn pty_write(window: Window, session_id: u64, data: String) -> Result<(), String> {
    SESSIONS
        .owned(session_id, window.label(), |session| {
            session.pty.write(data.as_bytes())
        })
        .ok_or_else(|| no_session(session_id))?
        .map_err(msg)
}

#[tauri::command(async)]
pub fn pty_resize(window: Window, session_id: u64, cols: u16, rows: u16) -> Result<(), String> {
    SESSIONS
        .owned(session_id, window.label(), |session| {
            session.pty.resize(cols, rows)
        })
        .ok_or_else(|| no_session(session_id))?
        .map_err(msg)
}

/// Kill the shell and forget it; the exit event still follows from the child's waiter thread.
///
/// It used to kill in place and leave the record in the map until the child's exit handler got
/// there, which left a window in which `pty_write`/`pty_resize`/`pty_follow` addressed a dead
/// shell instead of saying `No terminal session N`, and left the pseudo-console open for a child
/// that was never reaped. Now it is the same remove-and-drop as `pty_spawn`'s reap and a window's
/// `Destroyed`, so there is one way a session leaves the map, not two.
///
/// ⭐ **`pty:exit` is not lost and is not re-ordered.** The emit lives in the `on_exit` closure,
/// which the `pty-waiter` thread runs when `child.wait()` returns; `PtySession::drop`
/// (`core/pty.rs:210-214`) only calls `kill()` — it does not join that thread — so the exit fires
/// when the child dies, exactly as it did when the kill was a bare signal. Its `SESSIONS.remove`
/// then finds the id already gone, which is the documented no-op. And the pane does not depend on
/// the order in either direction: it clears its own `sessionId` *before* awaiting this
/// (`src/lib/state/terminal.svelte.ts:108-111`, and `spawn` at `:75-82`), and `applyExit` discards
/// any exit whose id is not the current one (`:132-136`) — so the exit for a killed session is
/// already deliberately ignored.
///
/// ⛔ **A window may only kill its own session, and a foreign id is a silent no-op.** The
/// contract is `()`, so there is nothing to return: making it `Result` to say `No terminal
/// session N` would be a frontend-visible change (`src/lib/state/terminal.svelte.ts:108-111`),
/// and that is not worth buying for an exposure the frontend cannot reach. The cost is that a
/// refused kill is indistinguishable, from the caller's side, from killing a session that had
/// already exited — `kill_one` logs a warning for exactly that reason.
#[tauri::command(async)]
pub fn pty_kill(window: Window, session_id: u64) {
    SESSIONS.kill_one(session_id, window.label());
}

/// What `pty_follow` did; the frontend sees `"typed"`, `"busy"` or `"otherShell"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Followed {
    Typed,
    /// A program is running in the shell; nothing was typed, the frontend retries later.
    Busy,
    /// A WSL folder in PowerShell, or another distro: left alone.
    OtherShell,
}

/// Make the session's shell `cd` to `path` when it is the same kind of shell **and is at its
/// prompt**. A `cd` typed while a program runs would be that program's input, so a busy shell
/// gets nothing and the answer says so.
#[tauri::command(async)]
pub fn pty_follow(window: Window, session_id: u64, path: String) -> Result<Followed, String> {
    SESSIONS
        .owned(session_id, window.label(), |session| {
            let pty = &mut session.pty;
            match pty::follow_line(&path, &pty.kind, || pty.busy()) {
                Ok(line) => pty
                    .write(line.as_bytes())
                    .map(|_| Followed::Typed)
                    .map_err(msg),
                Err(pty::Follow::Busy) => Ok(Followed::Busy),
                Err(pty::Follow::OtherShell) => Ok(Followed::OtherShell),
            }
        })
        .ok_or_else(|| no_session(session_id))?
}

/// A window went away: kill the shells it owned.
///
/// Registered as a third `.on_window_event` in `lib.rs` — `tauri-2.11.x` appends listeners
/// rather than replacing them, so the main handler and `spotlight::on_window_event` are
/// untouched by this one, and this one must not assume it is alone either.
///
/// ⛔ **Safe to re-enter, and it never touches the window.** `app.exit` destroys every
/// remaining window and each fires `Destroyed` again — the re-entry behind the
/// `cannot move state from Destroyed` panic (`commands::windows::exit_if_last_explorer_window`,
/// 2026-09-24). So this reads the label, which is a `String` the window kept, and asks the map
/// to forget that label's sessions; a second pass finds none and does nothing. It calls nothing
/// on the window, whose native side may already be gone, and it decides nothing about exiting.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Destroyed) {
        return;
    }
    let killed = SESSIONS.kill_owned_by(window.label());
    if killed > 0 {
        log::info!(
            "window {} was destroyed — killed {killed} terminal session(s) it owned",
            window.label()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    /// What the map holds in these tests: an owner, and a record of its own death — whether it
    /// was dropped, and whether the map's lock was free while it was.
    struct Fake {
        owner: String,
        dropped: Arc<AtomicBool>,
        lock_was_free: Arc<AtomicBool>,
        sessions: &'static Sessions<Fake>,
    }

    impl Owned for Fake {
        fn owner(&self) -> &str {
            &self.owner
        }
    }

    /// Stands in for `PtySession::drop`, which kills the child and closes the console — the part
    /// that must never run with the map locked.
    impl Drop for Fake {
        fn drop(&mut self) {
            self.lock_was_free
                .store(self.sessions.unlocked(), Ordering::SeqCst);
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    struct Watch {
        dropped: Arc<AtomicBool>,
        lock_was_free: Arc<AtomicBool>,
    }

    impl Watch {
        fn dropped(&self) -> bool {
            self.dropped.load(Ordering::SeqCst)
        }
        fn dropped_with_the_lock_free(&self) -> bool {
            self.lock_was_free.load(Ordering::SeqCst)
        }
    }

    /// Put a session owned by `owner` in `map` under `id`, and hand back a watch on its death.
    fn insert(map: &'static Sessions<Fake>, id: u64, owner: &str) -> Watch {
        let watch = Watch {
            dropped: Arc::new(AtomicBool::new(false)),
            lock_was_free: Arc::new(AtomicBool::new(false)),
        };
        map.with(|s| {
            s.insert(
                id,
                Fake {
                    owner: owner.to_string(),
                    dropped: Arc::clone(&watch.dropped),
                    lock_was_free: Arc::clone(&watch.lock_was_free),
                    sessions: map,
                },
            )
        });
        watch
    }

    // One map per test: `Sessions` is a static in the app, and `cargo test` runs these on
    // threads of one process, so sharing one would make them each other's fixture.
    static ONE_WINDOW: Sessions<Fake> = Sessions::new();
    static TWO_WINDOWS: Sessions<Fake> = Sessions::new();
    static TEARDOWN: Sessions<Fake> = Sessions::new();
    static NOBODY: Sessions<Fake> = Sessions::new();
    static ONE_ID: Sessions<Fake> = Sessions::new();
    static ONE_OF_TWO: Sessions<Fake> = Sessions::new();
    static FOREIGN_REACH: Sessions<Fake> = Sessions::new();
    static FOREIGN_KILL: Sessions<Fake> = Sessions::new();

    #[test]
    fn a_windows_sessions_are_killed_and_forgotten() {
        let a = insert(&ONE_WINDOW, 1, "main");
        let b = insert(&ONE_WINDOW, 2, "main");
        assert_eq!(ONE_WINDOW.len(), 2);

        assert_eq!(ONE_WINDOW.kill_owned_by("main"), 2);
        assert_eq!(ONE_WINDOW.len(), 0, "nothing may be left in the map");
        assert!(a.dropped() && b.dropped(), "both shells must be killed");
        // ⛔ the deadlock guard: the drop that closes a console ran with the map unlocked
        assert!(a.dropped_with_the_lock_free() && b.dropped_with_the_lock_free());
    }

    #[test]
    fn killing_a_windows_sessions_twice_is_a_no_op_the_second_time() {
        let only = insert(&TEARDOWN, 1, "main-2");
        assert_eq!(TEARDOWN.kill_owned_by("main-2"), 1);
        assert!(only.dropped());
        // `Destroyed` fires again for every window `app.exit` tears down, so this is the shape
        // the second pass must have: nothing found, nothing done, no panic, no latch.
        assert_eq!(TEARDOWN.kill_owned_by("main-2"), 0);
        assert_eq!(TEARDOWN.kill_owned_by("main-2"), 0);
        assert_eq!(TEARDOWN.len(), 0);
    }

    #[test]
    fn one_windows_teardown_leaves_another_windows_shell_running() {
        let mine = insert(&TWO_WINDOWS, 1, "main");
        let theirs = insert(&TWO_WINDOWS, 2, "main-3");

        assert_eq!(TWO_WINDOWS.kill_owned_by("main"), 1);
        assert!(mine.dropped());
        assert!(
            !theirs.dropped(),
            "another window's shell is not ours to kill"
        );
        assert_eq!(TWO_WINDOWS.len(), 1);

        // and when that window goes too, the map is empty
        assert_eq!(TWO_WINDOWS.kill_owned_by("main-3"), 1);
        assert!(theirs.dropped());
        assert_eq!(TWO_WINDOWS.len(), 0);
    }

    #[test]
    fn a_label_that_owns_nothing_kills_nothing() {
        // `palette` and any window that never opened a pane come through here on `Destroyed`
        let untouched = insert(&NOBODY, 1, "main");
        assert_eq!(NOBODY.kill_owned_by("palette"), 0);
        assert_eq!(NOBODY.kill_owned_by(""), 0);
        assert_eq!(NOBODY.kill_owned_by("main-2"), 0);
        assert!(!untouched.dropped());
        assert_eq!(NOBODY.len(), 1);
    }

    /// ⛔ `pty_kill` used to kill in place and leave the record behind, so the map still held a
    /// session whose shell was dead. It must remove and drop — and, like `kill_owned_by`, drop
    /// **outside** the lock: the child's waiter thread takes the same lock to remove its own
    /// entry, so a drop inside the critical section is the deadlock.
    #[test]
    fn killing_one_session_removes_it_and_drops_it_with_the_lock_free() {
        let only = insert(&ONE_ID, 1, "main");
        assert_eq!(ONE_ID.len(), 1);

        assert!(ONE_ID.kill_one(1, "main"));
        assert_eq!(ONE_ID.len(), 0, "the record must not linger after the kill");
        assert!(only.dropped(), "the shell must actually be killed");
        assert!(
            only.dropped_with_the_lock_free(),
            "closing the console must not happen under the map's lock"
        );

        // idempotent: the child's own exit handler comes through here too, and finds nothing
        assert!(!ONE_ID.kill_one(1, "main"));
        assert!(!ONE_ID.kill_one(1, "main"));
        assert_eq!(ONE_ID.len(), 0);
    }

    /// The single-id kill is not the owner kill: it takes the one id it was given and nothing
    /// else, including another session the same window owns.
    #[test]
    fn killing_one_session_leaves_every_other_session_alone() {
        let mine = insert(&ONE_OF_TWO, 1, "main");
        let siblings = insert(&ONE_OF_TWO, 2, "main");
        let others = insert(&ONE_OF_TWO, 3, "main-2");

        assert!(ONE_OF_TWO.kill_one(1, "main"));
        assert!(mine.dropped());
        assert!(
            !siblings.dropped(),
            "the same window's other pane is not ours"
        );
        assert!(!others.dropped(), "another window's shell is not ours");
        assert_eq!(ONE_OF_TWO.len(), 2);

        // an id that was never in the map is a no-op, not a panic
        assert!(!ONE_OF_TWO.kill_one(99, "main"));
        assert_eq!(ONE_OF_TWO.len(), 2);
    }

    /// ⛔ The sharpest of the id-addressed edges. `pty_write` reaches a live session through
    /// `owned` — as `pty_resize` and `pty_follow` do — so if that lookup ignored the owner, an id
    /// that reached the wrong window would let it type into another window's shell.
    #[test]
    fn a_window_cannot_reach_another_windows_session_by_id() {
        let theirs = insert(&FOREIGN_REACH, 1, "main-2");

        assert!(
            FOREIGN_REACH.owned(1, "main", |_| ()).is_none(),
            "another window's session must not be addressable by id"
        );
        assert!(
            FOREIGN_REACH.owned(1, "", |_| ()).is_none(),
            "nor by a window with no label at all"
        );
        assert!(
            FOREIGN_REACH.owned(1, "main-2", |_| ()).is_some(),
            "and the owner must still reach its own"
        );
        // an id in no map at all is the same refusal, so the caller's `No terminal session N`
        // says the same thing either way and leaks nothing about another window
        assert!(FOREIGN_REACH.owned(99, "main-2", |_| ()).is_none());

        assert!(!theirs.dropped(), "a refused lookup kills nothing");
        assert_eq!(FOREIGN_REACH.len(), 1);
    }

    /// The same for `pty_kill`, which has no `Result` to refuse with: a foreign id must leave the
    /// session running and in the map.
    #[test]
    fn a_window_cannot_kill_another_windows_session() {
        let theirs = insert(&FOREIGN_KILL, 1, "main-2");

        assert!(
            !FOREIGN_KILL.kill_one(1, "main"),
            "another window's shell is not ours to kill by id"
        );
        assert!(!theirs.dropped(), "it must still be running");
        assert_eq!(FOREIGN_KILL.len(), 1, "and still be in the map");
        assert!(
            !FOREIGN_KILL.kill_one(1, ""),
            "nor may a window with no label"
        );
        assert!(!theirs.dropped());

        // its owner still can, and the drop is still outside the lock
        assert!(FOREIGN_KILL.kill_one(1, "main-2"));
        assert!(theirs.dropped());
        assert!(theirs.dropped_with_the_lock_free());
        assert_eq!(FOREIGN_KILL.len(), 0);
    }
}

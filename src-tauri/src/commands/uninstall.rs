//! Uninstall from the Applications place (plan 18, 1.5). The frontend sends an id plus the
//! name, version and program its confirm showed - never a command to run; `uninstall_app`
//! re-lists and acts only on the fresh row that id names, and only if that row still shows
//! exactly what the person confirmed.
//!
//! ⛔ Tests call `run(..)` with a Recorder and fixture lists — never the `#[tauri::command]`
//! fns, which are the only place the live launcher is named (both `#[cfg(not(test))]`).

// On macOS the wait-for-the-uninstaller path (`run`, `WAIT_CAP`, `Unknown`, `TypedInTerminal`)
// is unused: Windows and Ubuntu take it, a Mac app goes to the Trash through `run_mac`.
#![cfg_attr(target_os = "macos", allow(dead_code))]

use crate::core::uninstall::{self, Confirmed, Launcher, Uninstallable, Waited};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// What happened, said only as far as Trove can know it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// the row left the list after the uninstaller ended
    Gone,
    /// the row is still there: Cancel, or an uninstaller that re-launched from `%TEMP%` and is
    /// still open. Never "still installed".
    StillListed,
    /// the wait hit the cap, or the re-list failed: no claim
    Unknown,
    /// macOS refused both ways to the Trash; nothing moved (plan 18 forbids deleting an app
    /// for good, so there is no fallback: the person drags it to the Trash in Finder)
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    NoTrash,
    /// Ubuntu without GNOME Software: Trove started nothing. The checks passed, and the
    /// frontend types the confirmed line (no newline) into a fresh shell; Enter is the person's.
    TypedInTerminal,
}

/// How long one uninstall may hold the lock before Trove stops waiting (plan 18, 1.5).
#[cfg(not(test))]
pub const WAIT_CAP: Duration = Duration::from_secs(10 * 60);

/// One uninstall at a time, across every window.
#[cfg(not(test))]
static BUSY: AtomicBool = AtomicBool::new(false);

/// Clears the busy flag however `run` leaves.
struct Hold<'a>(&'a AtomicBool);
impl Drop for Hold<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub const BUSY_SENTENCE: &str = "Another uninstall is still open.";

/// Re-list → start the row's uninstaller → wait (capped) → re-list → say what is known.
pub fn run(
    id: &str,
    seen: &Confirmed,
    list: &dyn Fn() -> Result<Vec<Uninstallable>, String>,
    l: &dyn Launcher,
    busy: &AtomicBool,
    cap: Duration,
) -> Result<Outcome, String> {
    if busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(BUSY_SENTENCE.into());
    }
    let _hold = Hold(busy);
    let fresh = list()?;
    let (row, _) = uninstall::resolve(id, seen, &fresh).map_err(|r| r.sentence())?;
    // ⛔ Ubuntu: before anything is typed or started, simulate the apt removal and refuse one
    // that would take an essential package or the desktop with it (the sentence says which)
    if let Some(pkg) = &row.deb {
        l.apt_check(pkg)?;
    }
    if row.typed {
        // ⛔ never started from here: the person runs it, after reading it
        return Ok(Outcome::TypedInTerminal);
    }
    let mut started = uninstall::uninstall(id, seen, &fresh, l).map_err(|r| r.sentence())?;
    // ⛔ The process ending does not mean the uninstall ended (Inno/NSIS hand off to %TEMP%)
    if started.wait(cap) == Waited::TimedOut {
        return Ok(Outcome::Unknown);
    }
    Ok(match list() {
        Ok(after) if after.iter().any(|r| r.id == id) => Outcome::StillListed,
        Ok(_) => Outcome::Gone,
        Err(_) => Outcome::Unknown,
    })
}

/// Mac: re-list → pre-check the row (unchanged, not running) → move its bundle to the Trash
/// once → say whether the bundle is gone. Nothing to wait for: the move is synchronous.
#[cfg(any(target_os = "macos", test))]
pub fn run_mac(
    id: &str,
    seen: &Confirmed,
    list: &dyn Fn() -> Result<Vec<Uninstallable>, String>,
    probe: &dyn crate::core::uninstall_mac::Probe,
    l: &dyn Launcher,
    busy: &AtomicBool,
) -> Result<Outcome, String> {
    if busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(BUSY_SENTENCE.into());
    }
    let _hold = Hold(busy);
    let fresh = list()?;
    match crate::core::uninstall_mac::trash_app(id, seen, &fresh, probe, l) {
        Ok(bundle) if bundle.symlink_metadata().is_err() => Ok(Outcome::Gone),
        Ok(_) => Ok(Outcome::StillListed),
        Err(uninstall::Refusal::NoTrash) => Ok(Outcome::NoTrash),
        Err(r) => Err(r.sentence()),
    }
}

#[cfg(windows)]
fn live_list() -> Result<Vec<Uninstallable>, String> {
    crate::core::uninstall_windows::list()
}

#[cfg(target_os = "macos")]
fn live_list() -> Result<Vec<Uninstallable>, String> {
    crate::core::uninstall_mac::live_list()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn live_list() -> Result<Vec<Uninstallable>, String> {
    crate::core::uninstall_linux::list()
}

/// Elsewhere nothing is listed; the frontend greys the item "Not on this system yet".
#[cfg(not(any(windows, unix)))]
fn live_list() -> Result<Vec<Uninstallable>, String> {
    Ok(Vec::new())
}

#[tauri::command(async)]
pub fn uninstall_list() -> Result<Vec<Uninstallable>, String> {
    live_list()
}

/// `async` so the wait runs on a blocking worker, never the command thread.
#[cfg(not(test))]
#[tauri::command]
pub async fn uninstall_app(
    id: String,
    name: String,
    version: String,
    program: String,
    stamp: String,
) -> Result<Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let seen = Confirmed {
            name: &name,
            version: &version,
            program: &program,
            stamp: &stamp,
        };
        #[cfg(target_os = "macos")]
        return run_mac(
            &id,
            &seen,
            &live_list,
            &crate::core::uninstall_mac::LiveProbe,
            &uninstall::LiveLauncher,
            &BUSY,
        );
        #[cfg(not(target_os = "macos"))]
        run(
            &id,
            &seen,
            &live_list,
            &uninstall::LiveLauncher,
            &BUSY,
            WAIT_CAP,
        )
    })
    .await
    .map_err(|e| format!("The uninstall did not finish: {e}"))?
}

/// A Store app has no Uninstall key: open Settings → Installed apps (it cannot jump to one app).
#[cfg(not(test))]
#[tauri::command(async)]
pub fn open_apps_settings() -> Result<(), String> {
    uninstall::LiveLauncher.open_apps_settings()
}

// Under the lib's unit tests `generate_handler!` still names both commands; these stand in and
// start nothing.
#[cfg(test)]
#[tauri::command]
pub async fn uninstall_app(
    id: String,
    name: String,
    version: String,
    program: String,
    stamp: String,
) -> Result<Outcome, String> {
    Err(format!(
        "tests never uninstall ({id} {name} {version} {program} {stamp})"
    ))
}
#[cfg(test)]
#[tauri::command(async)]
pub fn open_apps_settings() -> Result<(), String> {
    Err("tests never open Settings".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::uninstall::tests::{row, seen};
    use crate::core::uninstall::{Recorder, Removable};
    use std::cell::Cell;

    /// The first call returns `before`, every later one `after`.
    fn lists(
        before: Vec<Uninstallable>,
        after: Vec<Uninstallable>,
    ) -> impl Fn() -> Result<Vec<Uninstallable>, String> {
        let calls = Cell::new(0);
        move || {
            calls.set(calls.get() + 1);
            Ok(if calls.get() == 1 {
                before.clone()
            } else {
                after.clone()
            })
        }
    }

    const CAP: Duration = Duration::from_secs(1);

    #[test]
    fn gone_only_when_the_row_left() {
        let a = row("a", "A", Removable::Yes);
        let b = row("b", "B", Removable::Yes);
        let busy = AtomicBool::new(false);
        let rec = Recorder::new(Waited::Exited);
        let list = lists(vec![a.clone(), b.clone()], vec![b.clone()]);
        assert_eq!(
            run("a", &seen(&a), &list, &rec, &busy, CAP),
            Ok(Outcome::Gone)
        );
        assert_eq!(rec.calls.borrow().len(), 1);
        assert!(!busy.load(Ordering::SeqCst));

        // past the cap: no claim, even if the row is gone
        let rec = Recorder::new(Waited::TimedOut);
        let list = lists(vec![a.clone()], vec![]);
        assert_eq!(
            run("a", &seen(&a), &list, &rec, &busy, CAP),
            Ok(Outcome::Unknown)
        );

        // a re-list that fails: no claim
        let rec = Recorder::new(Waited::Exited);
        let calls = Cell::new(0);
        let flaky = || {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                Ok(vec![a.clone()])
            } else {
                Err("registry".to_string())
            }
        };
        assert_eq!(
            run("a", &seen(&a), &flaky, &rec, &busy, CAP),
            Ok(Outcome::Unknown)
        );

        // an id the fresh list does not hold starts nothing
        let rec = Recorder::new(Waited::Exited);
        let list = lists(vec![b.clone()], vec![b]);
        assert!(run("a", &seen(&a), &list, &rec, &busy, CAP).is_err());
        assert!(rec.calls.borrow().is_empty());
        assert!(!busy.load(Ordering::SeqCst), "a refusal releases the lock");
    }

    #[test]
    fn a_changed_entry_is_refused_with_a_plain_sentence() {
        // the person confirmed A 1.0; the same key now holds another version
        let a = row("a", "A", Removable::Yes);
        let mut now = a.clone();
        now.version = "6.6".into();
        let rec = Recorder::new(Waited::Exited);
        let busy = AtomicBool::new(false);
        let list = lists(vec![now], vec![]);
        assert_eq!(
            run("a", &seen(&a), &list, &rec, &busy, CAP),
            Err("This app changed since you confirmed - try again".into())
        );
        assert!(rec.calls.borrow().is_empty());
        assert!(!busy.load(Ordering::SeqCst));
    }

    #[test]
    fn still_listed_after_early_exit() {
        // an Inno uninstaller re-launched from %TEMP% and its first process exited at once
        let a = row("a", "A", Removable::Yes);
        let rec = Recorder::new(Waited::Exited);
        let busy = AtomicBool::new(false);
        let list = lists(vec![a.clone()], vec![a.clone()]);
        assert_eq!(
            run("a", &seen(&a), &list, &rec, &busy, CAP),
            Ok(Outcome::StillListed)
        );
    }

    #[test]
    fn typed_row_starts_nothing() {
        let mut a = row("a", "A", Removable::Yes);
        a.typed = true;
        let rec = Recorder::new(Waited::Exited);
        let busy = AtomicBool::new(false);
        let list = lists(vec![a.clone()], vec![]);
        assert_eq!(
            run("a", &seen(&a), &list, &rec, &busy, CAP),
            Ok(Outcome::TypedInTerminal)
        );
        assert!(rec.calls.borrow().is_empty(), "nothing was started");
        assert!(!busy.load(Ordering::SeqCst));
        // and the core seam refuses to start it even if asked directly
        assert_eq!(
            uninstall::uninstall("a", &seen(&a), std::slice::from_ref(&a), &rec).err(),
            Some(uninstall::Refusal::Typed)
        );
        assert!(rec.calls.borrow().is_empty());
        // a typed row whose line changed is still refused before anything is typed
        let mut now = a.clone();
        now.program = "sudo apt remove evil".into();
        if let Some(c) = now.command.as_mut() {
            c.program = now.program.clone();
        }
        let list = lists(vec![now], vec![]);
        assert!(run("a", &seen(&a), &list, &rec, &busy, CAP).is_err());
    }

    #[test]
    fn apt_guard_runs_before_anything_is_typed_or_started() {
        let refusal =
            "Trove will not remove x: apt would also remove ubuntu-desktop (your desktop). \
                       Nothing was typed or started.";
        for typed in [true, false] {
            let mut a = row("a", "A", Removable::Yes);
            a.typed = typed;
            a.deb = Some("x".into());
            let busy = AtomicBool::new(false);
            // refused: the sentence reaches the person, nothing is typed or started
            let mut rec = Recorder::new(Waited::Exited);
            rec.apt = Some(refusal.into());
            let list = lists(vec![a.clone()], vec![]);
            assert_eq!(
                run("a", &seen(&a), &list, &rec, &busy, CAP),
                Err(refusal.into())
            );
            assert_eq!(*rec.calls.borrow(), vec!["apt-get -s remove x".to_string()]);
            assert!(!busy.load(Ordering::SeqCst));
            // allowed: the simulation came first, then the hand-off
            let rec = Recorder::new(Waited::Exited);
            let list = lists(vec![a.clone()], vec![]);
            let want = if typed {
                Outcome::TypedInTerminal
            } else {
                Outcome::Gone
            };
            assert_eq!(run("a", &seen(&a), &list, &rec, &busy, CAP), Ok(want));
            let calls = rec.calls.borrow();
            assert_eq!(calls[0], "apt-get -s remove x");
            assert_eq!(calls.len(), if typed { 1 } else { 2 });
        }
        // a row with no apt package is never simulated
        let a = row("a", "A", Removable::Yes);
        let rec = Recorder::new(Waited::Exited);
        let busy = AtomicBool::new(false);
        let list = lists(vec![a.clone()], vec![]);
        assert_eq!(
            run("a", &seen(&a), &list, &rec, &busy, CAP),
            Ok(Outcome::Gone)
        );
        assert!(!rec.calls.borrow()[0].starts_with("apt-get"));
    }

    #[test]
    fn second_request_refused_while_one_runs() {
        let a = row("a", "A", Removable::Yes);
        let rec = Recorder::new(Waited::Exited);
        let busy = AtomicBool::new(true);
        let list = lists(vec![a.clone()], vec![]);
        assert_eq!(
            run("a", &seen(&a), &list, &rec, &busy, CAP),
            Err(BUSY_SENTENCE.into())
        );
        assert!(rec.calls.borrow().is_empty());
        assert!(
            busy.load(Ordering::SeqCst),
            "the running one keeps its lock"
        );
    }

    /// A probe that answers only "is it running"; the pre-checks ran when the row was listed.
    struct Probe(bool);
    impl crate::core::uninstall_mac::Probe for Probe {
        fn read_only(&self, _: &std::path::Path) -> bool {
            false
        }
        fn network(&self, _: &std::path::Path) -> bool {
            false
        }
        fn running(&self, _: &std::path::Path) -> bool {
            self.0
        }
    }

    /// A Trash that removes the fake bundle from the temp dir (`gone`) or leaves it, or says
    /// macOS refused. Never touches anything outside the scratch dir.
    struct FakeTrash {
        remove: bool,
        refuse: bool,
        calls: Cell<usize>,
    }
    impl Launcher for FakeTrash {
        fn launch(&self, _: &uninstall::Command) -> Result<Box<dyn uninstall::Running>, String> {
            panic!("a Mac app is never launched to uninstall it")
        }
        fn open_apps_settings(&self) -> Result<(), String> {
            panic!("no Settings on a Mac")
        }
        fn apt_check(&self, _: &str) -> Result<(), String> {
            panic!("no apt on a Mac")
        }
        fn trash(&self, bundle: &std::path::Path) -> std::io::Result<()> {
            self.calls.set(self.calls.get() + 1);
            assert!(bundle.starts_with(std::env::temp_dir().canonicalize().unwrap()));
            if self.refuse {
                return Err(std::io::Error::other(crate::core::ops::NoRecycleBin {
                    place: "Mac".into(),
                    path: bundle.to_path_buf(),
                    why: crate::core::ops::Why::NoBin,
                    paths: vec![bundle.to_path_buf()],
                }));
            }
            if self.remove {
                std::fs::remove_dir_all(bundle)?;
            }
            Ok(())
        }
    }

    /// One fake `X.app` under a scratch `Applications`, listed as the Mac list would.
    fn mac_fixture(tag: &str) -> (std::path::PathBuf, Uninstallable) {
        let dir = std::env::temp_dir().join(format!("trove-18b-cmd-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let app = dir.join("Applications/X.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/Info.plist"), "<plist/>").unwrap();
        std::fs::write(app.join("Contents/MacOS/X"), "").unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let roots = [dir.join("Applications")];
        let probe = Probe(false);
        let rows = crate::core::uninstall_mac::list(
            &[dir.join("Applications/X.app")],
            &crate::core::uninstall_mac::Ctx {
                roots: &roots,
                trove_exe: None,
                system: &crate::core::uninstall_mac::system_roots(),
                probe: &probe,
            },
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].removable, Removable::Yes);
        (dir, rows[0].clone())
    }

    #[test]
    fn mac_gone_when_the_bundle_left() {
        let (dir, x) = mac_fixture("gone");
        let busy = AtomicBool::new(false);
        let fresh = vec![x.clone()];
        let list = || Ok(fresh.clone());
        let l = FakeTrash {
            remove: true,
            refuse: false,
            calls: Cell::new(0),
        };
        assert_eq!(
            run_mac(&x.id, &seen(&x), &list, &Probe(false), &l, &busy),
            Ok(Outcome::Gone)
        );
        assert_eq!(l.calls.get(), 1);
        assert!(!busy.load(Ordering::SeqCst));

        // the bundle is gone, so a second ask finds a changed/unknown row, never a second move
        let after = crate::core::uninstall_mac::list(
            &[dir.join("Applications/X.app")],
            &crate::core::uninstall_mac::Ctx {
                roots: &[dir.join("Applications")],
                trove_exe: None,
                system: &crate::core::uninstall_mac::system_roots(),
                probe: &Probe(false),
            },
        );
        let relist = || Ok(after.clone());
        assert!(run_mac(&x.id, &seen(&x), &relist, &Probe(false), &l, &busy).is_err());
        assert_eq!(l.calls.get(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mac_still_there_running_and_no_trash() {
        let (dir, x) = mac_fixture("left");
        let busy = AtomicBool::new(false);
        let fresh = vec![x.clone()];
        let list = || Ok(fresh.clone());

        // the move "succeeded" but the bundle is still on disk: no claim it is gone
        let keep = FakeTrash {
            remove: false,
            refuse: false,
            calls: Cell::new(0),
        };
        assert_eq!(
            run_mac(&x.id, &seen(&x), &list, &Probe(false), &keep, &busy),
            Ok(Outcome::StillListed)
        );

        // running: refused in plain words, nothing moved
        let l = FakeTrash {
            remove: true,
            refuse: false,
            calls: Cell::new(0),
        };
        assert_eq!(
            run_mac(&x.id, &seen(&x), &list, &Probe(true), &l, &busy),
            Err("Quit X first.".into())
        );
        assert_eq!(l.calls.get(), 0);

        // macOS refused the Trash: NoTrash, and nothing is deleted for good
        let no = FakeTrash {
            remove: false,
            refuse: true,
            calls: Cell::new(0),
        };
        assert_eq!(
            run_mac(&x.id, &seen(&x), &list, &Probe(false), &no, &busy),
            Ok(Outcome::NoTrash)
        );
        assert!(dir.join("Applications/X.app").exists());
        assert!(!busy.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mac_second_request_refused_while_one_runs() {
        let (dir, x) = mac_fixture("busy");
        let busy = AtomicBool::new(true);
        let fresh = vec![x.clone()];
        let list = || Ok(fresh.clone());
        let l = FakeTrash {
            remove: true,
            refuse: false,
            calls: Cell::new(0),
        };
        assert_eq!(
            run_mac(&x.id, &seen(&x), &list, &Probe(false), &l, &busy),
            Err(BUSY_SENTENCE.into())
        );
        assert_eq!(l.calls.get(), 0);
        assert!(dir.join("Applications/X.app").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}

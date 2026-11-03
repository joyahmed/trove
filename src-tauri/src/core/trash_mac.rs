//! Moving items to the macOS Trash, and putting them back with ⌘Z. Two ways to trash:
//!
//! - **Finder**: `osascript` asks Finder to delete. Finder keeps "Put Back" and its trash sound,
//!   and can ask for an admin password to trash an app in /Applications that root owns (uninstall).
//!   It needs Apple Events permission for Finder. When the person said Don't Allow (or the
//!   permission was reset and the prompt cannot show), osascript fails with
//!   `Not authorized to send Apple events to Finder. (-1743)` — and that raw text was the toast
//!   every Delete, bin move and zip-undo showed, while nothing moved.
//! - **File manager** (`NSFileManager trashItemAtURL:resultingItemURL:error:`): no Apple Events
//!   and no permission, but no Put Back.
//!
//! So: Finder first; on an Apple Events authorization refusal only, the file manager; if that
//! fails too, a [`NoRecycleBin`] with [`Why::Denied`] so every caller takes its existing
//! "ask, then delete for good" path. Nothing here deletes anything for good. That order is the
//! same for a Delete (`ops::trash`), the old file a Replace writes over (`ops::trash_replaced`)
//! and an uninstall (`LiveLauncher::trash` → `ops::trash`).
//!
//! ⛔ Any other Finder failure is NOT retried with the file manager. Finder may already have
//! moved part of the batch before it failed, and a missing file, a locked file or a busy Finder
//! is not fixed by changing the method — retrying would only hide the real sentence. Those keep
//! surfacing as the plain error they always were.
//!
//! ⌘Z: both ways say where each item landed — Finder's `delete` answers a reference to the item
//! in the Trash (turned into a POSIX path, [`FINDER_SCRIPT`]); the file manager answers its
//! `resultingItemURL`. Each answer is trusted only when the file there is the very file that was
//! sent — same device and inode as before the move — and then goes into the [`Ledger`], so ⌘Z
//! ([`put_back`]) can move that exact item back. Only what Trove itself sent in this run is in the
//! ledger; the Trash is never listed.
//!
//! The method runner is a parameter, so the tests drive the order with a fake and never touch
//! a real file or the real Trash; under `cfg(test)` the live runner [`run`] refuses unless a test
//! put a fake in its place. Compiled on macOS, and in tests on every OS.

use std::io::{self, Error, ErrorKind, Result};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::ops::{NoRecycleBin, Why};

/// Which of the two ways to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Finder,
    FileManager,
}

/// What a method answers: where in the Trash the items landed, as it said (in any order; an item
/// it said nothing about has no ⌘Z).
pub type Landed = std::result::Result<Vec<PathBuf>, trash::Error>;

/// The place a [`Why::Denied`] refusal names: the whole Mac's Trash, not one volume.
pub const PLACE: &str = "This Mac";

/// What an Apple Events refusal looks like in osascript's stderr: `errAEEventNotPermitted`
/// (-1743, "Not authorized to send Apple events to …") and
/// `errAEEventWouldRequireUserConsent` (-1744, the prompt could not be shown).
const DENIED_MARKS: [&str; 5] = [
    "-1743",
    "-1744",
    "errAEEventNotPermitted",
    "errAEEventWouldRequireUserConsent",
    "Not authorized to send Apple events",
];

/// Whether a `trash` error is macOS refusing Trove Apple Events (for Finder).
pub fn is_apple_events_denied(e: &trash::Error) -> bool {
    let text = match e {
        trash::Error::Unknown { description } | trash::Error::Os { description, .. } => description,
        _ => return false,
    };
    DENIED_MARKS.iter().any(|m| text.contains(m))
}

/// Which file a path is: (device, inode), read without following a link.
#[cfg(unix)]
fn file_id(p: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = p.symlink_metadata().ok()?;
    Some((m.dev(), m.ino()))
}

/// The tests' stand-in off unix (no app code runs it there; off macOS this module is built only
/// for tests). The device is always 0: std cannot read a volume id there, and the scratch files
/// and their Trash are on one disk, so a missing item reads as gone, never as a disk that is not
/// connected ([`disk_gone`] compares this device with the parent folder's). The "inode" mixes size
/// and change time, enough to tell the file that was sent from another one.
#[cfg(not(unix))]
fn file_id(p: &Path) -> Option<(u64, u64)> {
    let m = p.symlink_metadata().ok()?;
    let t = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some((0, (t.as_nanos() as u64) ^ m.len().rotate_left(40)))
}

/// To the Trash with `run`: Finder, then — on an Apple Events refusal only — the file manager,
/// then a [`NoRecycleBin`] (`Why::Denied`) listing the items still in place. Where the items
/// landed goes into `ledger`, for ⌘Z.
pub fn trash_with<F>(paths: &[PathBuf], ledger: &Mutex<Ledger>, mut run: F) -> Result<()>
where
    F: FnMut(Method, &[PathBuf]) -> Landed,
{
    // which file each path is, before it moves: a rename into the Trash keeps the inode
    let ids: Vec<Option<(u64, u64)>> = paths.iter().map(|p| file_id(p)).collect();
    let first = match run(Method::Finder, paths) {
        Ok(at) => {
            keep(ledger, paths, &ids, &at);
            return Ok(());
        }
        Err(e) => e,
    };
    let said = crate::core::os_limited::describe(&first);
    if !is_apple_events_denied(&first) {
        return Err(Error::other(said));
    }
    log::warn!("trash: Finder refused Apple Events ({said}); using the file manager");
    let second = match run(Method::FileManager, paths) {
        Ok(at) => {
            keep(ledger, paths, &ids, &at);
            return Ok(());
        }
        Err(e) => e,
    };
    let said = crate::core::os_limited::describe(&second);
    log::warn!("trash: the file manager failed too ({said}); asking instead");
    // The file manager stops at its first failure: what already moved is in the Trash, so only
    // what is still in place is the caller's to ask about.
    let left: Vec<PathBuf> = paths
        .iter()
        .filter(|p| p.symlink_metadata().is_ok())
        .cloned()
        .collect();
    let Some(path) = left.first().cloned() else {
        return Err(Error::other(said));
    };
    Err(Error::new(
        ErrorKind::PermissionDenied,
        NoRecycleBin {
            place: PLACE.to_string(),
            path,
            why: Why::Denied,
            paths: left,
        },
    ))
}

/// Record each path whose file is at one of the places the method answered. A path whose file
/// is at none of them (the answer was missing or wrong) is in the Trash with no ⌘Z.
fn keep(ledger: &Mutex<Ledger>, paths: &[PathBuf], ids: &[Option<(u64, u64)>], at: &[PathBuf]) {
    let landed: Vec<(PathBuf, (u64, u64))> = at
        .iter()
        .filter_map(|a| Some((a.clone(), file_id(a)?)))
        .collect();
    let mut l = lock(ledger);
    for (from, id) in paths.iter().zip(ids) {
        match id.and_then(|id| landed.iter().find(|(_, i)| *i == id)) {
            Some((at, (dev, ino))) => l.items.push(Trashed {
                from: from.clone(),
                at: at.clone(),
                dev: *dev,
                ino: *ino,
            }),
            None => log::warn!("trash: could not tell where an item went; no undo for it"),
        }
    }
}

/// The live runner. Under `cfg(test)` it runs the fake a test put in [`FAKE_RUN`], and panics
/// when there is none — no test can reach the real Trash through `ops::trash`.
#[cfg(all(target_os = "macos", not(test)))]
pub fn run(method: Method, paths: &[PathBuf]) -> Landed {
    run_live(method, paths)
}

#[cfg(all(test, target_os = "macos"))]
pub type FakeRun = Box<dyn FnMut(Method, &[PathBuf]) -> Landed>;

#[cfg(all(test, target_os = "macos"))]
thread_local! {
    /// The fake the live runner hands to in tests.
    pub static FAKE_RUN: std::cell::RefCell<Option<FakeRun>> = const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, target_os = "macos"))]
pub fn run(method: Method, paths: &[PathBuf]) -> Landed {
    FAKE_RUN.with(|f| {
        let mut f = f.borrow_mut();
        let fake = f
            .as_mut()
            .expect("a test reached the live Trash runner without a fake");
        fake(method, paths)
    })
}

#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))]
fn run_live(method: Method, paths: &[PathBuf]) -> Landed {
    let full = full_paths(paths)?;
    match method {
        Method::Finder => finder_delete(&full),
        Method::FileManager => file_manager_delete(&full),
    }
}

/// As `trash 5.2.9` does before it trashes: an absolute path, its folder resolved, the item
/// itself not (a link is trashed, not what it points to).
#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))]
fn full_paths(paths: &[PathBuf]) -> std::result::Result<Vec<PathBuf>, trash::Error> {
    paths
        .iter()
        .map(|p| {
            if p.as_os_str().is_empty() {
                return Err(trash::Error::CanonicalizePath {
                    original: p.clone(),
                });
            }
            let p = if p.is_relative() {
                std::env::current_dir()
                    .map_err(|_| trash::Error::CouldNotAccess {
                        target: "[Current working directory]".into(),
                    })?
                    .join(p)
            } else {
                p.clone()
            };
            let parent = p.parent().ok_or(trash::Error::TargetedRoot)?;
            let parent = parent
                .canonicalize()
                .map_err(|_| trash::Error::CanonicalizePath {
                    original: parent.to_owned(),
                })?;
            Ok(match p.file_name() {
                Some(name) => parent.join(name),
                None => parent,
            })
        })
        .collect()
}

/// Finder's delete, answering where each item landed. The paths go in as arguments (no quoting
/// to get wrong); `delete` answers a reference to each item in the Trash (one reference for one
/// item, a list for more), which becomes a POSIX path, one per line. An answer that cannot be
/// turned into a path is skipped inside `try`, so an item already moved never turns the whole
/// call into a failure. Each line is checked against the file's inode before it is recorded.
pub const FINDER_SCRIPT: [&str; 18] = [
    "on run argv",
    "set fs to {}",
    "repeat with p in argv",
    "set end of fs to (POSIX file (contents of p))",
    "end repeat",
    "set out to {}",
    "tell application \"Finder\"",
    "set r to delete fs",
    "if class of r is not list then set r to {r}",
    "repeat with t in r",
    "try",
    "set end of out to POSIX path of ((contents of t) as alias)",
    "end try",
    "end repeat",
    "end tell",
    "set AppleScript's text item delimiters to linefeed",
    "return out as text",
    "end run",
];

/// The paths in osascript's answer: one per line, a folder's trailing `/` dropped. A name with a
/// line break in it splits wrongly — its pieces match no inode, so it simply gets no ⌘Z.
pub fn finder_answer(stdout: &str) -> Vec<PathBuf> {
    stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let l = if l.len() > 1 {
                l.trim_end_matches('/')
            } else {
                l
            };
            PathBuf::from(l)
        })
        .collect()
}

#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))]
fn finder_delete(full: &[PathBuf]) -> Landed {
    let mut cmd = std::process::Command::new("osascript");
    for line in FINDER_SCRIPT {
        cmd.arg("-e").arg(line);
    }
    // every path is absolute (`full_paths`), so none can be read as an osascript option
    cmd.args(full);
    let out = cmd.output().map_err(|e| trash::Error::Unknown {
        description: e.to_string(),
    })?;
    if !out.status.success() {
        // the same shape `trash 5.2.9` gave, so the sentences and the -1743 check are unchanged
        let description = format!(
            "The AppleScript exited with error. stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        return Err(match out.status.code() {
            Some(code) => trash::Error::Os { code, description },
            None => trash::Error::Unknown { description },
        });
    }
    Ok(finder_answer(&String::from_utf8_lossy(&out.stdout)))
}

/// The file manager's move, one item at a time, stopping at the first failure (as `trash 5.2.9`
/// did). Each call sits in its own autorelease pool: this runs on worker threads that have none.
#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))]
fn file_manager_delete(full: &[PathBuf]) -> Landed {
    use objc2::rc::autoreleasepool;
    use objc2_foundation::{NSFileManager, NSURL};
    let mut landed = Vec::new();
    for path in full {
        let at = autoreleasepool(|_| {
            let url = NSURL::from_file_path(path).ok_or_else(|| trash::Error::Unknown {
                description: format!("Could not hand {} to the Trash.", path.display()),
            })?;
            let mut out = None;
            NSFileManager::defaultManager()
                .trashItemAtURL_resultingItemURL_error(&url, Some(&mut out))
                .map_err(|e| trash::Error::Unknown {
                    description: format!(
                        "While deleting '{}', `trashItemAtURL` failed: {}",
                        path.display(),
                        e.localizedDescription()
                    ),
                })?;
            Ok::<_, trash::Error>(out.and_then(|u| u.to_file_path()))
        })?;
        landed.extend(at);
    }
    Ok(landed)
}

// ── ⌘Z of a Delete ─────────────────────────────────────────────────────────────────────────

/// One item Trove sent to the Trash in this run: where it was, where the Trash put it, and which
/// file it is there (device, inode).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trashed {
    pub from: PathBuf,
    pub at: PathBuf,
    pub dev: u64,
    pub ino: u64,
}

/// What Trove sent to the Trash in this run, oldest first. Lives as long as the app.
#[derive(Debug, Default)]
pub struct Ledger {
    items: Vec<Trashed>,
}

impl Ledger {
    pub const fn new() -> Self {
        Ledger { items: Vec::new() }
    }

    /// The newest entry for `from`: a path deleted twice (delete, undo, redo) came back once.
    fn latest(&self, from: &Path) -> Option<usize> {
        self.items.iter().rposition(|t| t.from == from)
    }

    #[cfg(test)]
    pub fn items(&self) -> &[Trashed] {
        &self.items
    }
}

/// The app's ledger.
#[cfg(target_os = "macos")]
pub static LEDGER: Mutex<Ledger> = Mutex::new(Ledger::new());

fn lock(ledger: &Mutex<Ledger>) -> std::sync::MutexGuard<'_, Ledger> {
    ledger.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether the disk `at` is on is not connected: the nearest folder above it that exists is on
/// another device (`/Volumes` itself, once the disk is gone).
fn disk_gone(at: &Path, dev: u64) -> bool {
    at.ancestors()
        .skip(1)
        .find_map(file_id)
        .is_some_and(|(d, _)| d != dev)
}

/// ⌘Z of a Delete: put `paths` back from the app's ledger with the real exclusive rename.
#[cfg(target_os = "macos")]
pub fn put_back(paths: &[String]) -> std::result::Result<(), String> {
    put_back_in(&LEDGER, paths, rename_new)
}

/// Put back each of `paths` that Trove sent to the Trash in this run, with `move_new` (a rename
/// that refuses to replace anything; the real one is [`rename_new`]). Only the very file that was
/// sent moves back: something else now at its place in the Trash is left alone. Every path is
/// tried; the ones that could not come back are named after, by why.
pub fn put_back_in<M>(
    ledger: &Mutex<Ledger>,
    paths: &[String],
    mut move_new: M,
) -> std::result::Result<(), String>
where
    M: FnMut(&Path, &Path) -> io::Result<()>,
{
    let (mut gone, mut unplugged, mut other, mut taken, mut never, mut no_folder) =
        (vec![], vec![], vec![], vec![], vec![], vec![]);
    let (mut refused, mut failed) = (vec![], vec![]);
    for p in paths {
        let from = PathBuf::from(p);
        let mut l = lock(ledger);
        let Some(i) = l.latest(&from) else {
            never.push(p.clone());
            continue;
        };
        let t = l.items[i].clone();
        match file_id(&t.at) {
            None if disk_gone(&t.at, t.dev) => {
                // kept: it can come back once the disk is connected again
                unplugged.push(p.clone());
                continue;
            }
            None => {
                l.items.remove(i);
                gone.push(p.clone());
                continue;
            }
            Some(id) if id != (t.dev, t.ino) => {
                l.items.remove(i);
                other.push(p.clone());
                continue;
            }
            Some(_) => {}
        }
        if from.symlink_metadata().is_ok() {
            taken.push(p.clone());
            continue;
        }
        match move_new(&t.at, &from) {
            Ok(()) => {
                l.items.remove(i);
            }
            Err(e) => {
                log::warn!("trash undo: could not move an item back ({e})");
                match e.kind() {
                    io::ErrorKind::AlreadyExists => taken.push(p.clone()),
                    // the item was there a moment ago, so it is the folder that is missing
                    io::ErrorKind::NotFound => no_folder.push(p.clone()),
                    io::ErrorKind::PermissionDenied => refused.push(p.clone()),
                    _ => failed.push(p.clone()),
                }
            }
        }
    }
    let said: Vec<String> = [
        ("Not in the Trash any more", &gone),
        ("The disk it is on is not connected", &unplugged),
        ("Something else is in its place in the Trash now", &other),
        ("Something new is already there", &taken),
        ("Trove did not send these to the Trash in this run", &never),
        ("The folder it came from is gone", &no_folder),
        (
            "macOS did not let Trove move these out of the Trash",
            &refused,
        ),
        ("Could not put back", &failed),
    ]
    .iter()
    .filter(|(_, v)| !v.is_empty())
    .map(|(why, v)| format!("{why}: {}", v.join(", ")))
    .collect();
    if said.is_empty() {
        Ok(())
    } else {
        Err(said.join(". "))
    }
}

/// Rename `from` to `to`, refusing (`AlreadyExists`) when `to` exists — in one step, so nothing
/// that appears between a check and the move can be replaced (`renamex_np`, `RENAME_EXCL`).
#[cfg(target_os = "macos")]
pub fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    // SAFETY: two valid NUL-terminated paths that live across the call
    let r = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if r == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// The tests' stand-in off macOS: a check, then a rename (no app code runs it there).
#[cfg(all(test, not(target_os = "macos")))]
pub fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    if to.symlink_metadata().is_ok() {
        return Err(io::Error::from(io::ErrorKind::AlreadyExists));
    }
    std::fs::rename(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ops::{no_recycle_bin, Why};

    /// osascript's real words when Finder's Apple Events are denied (seen on screen).
    fn denied() -> trash::Error {
        trash::Error::Os {
            code: 1,
            description: "The AppleScript exited with error. stderr: 46:120: execution error: \
                Not authorized to send Apple events to Finder. (-1743)\n"
                .into(),
        }
    }

    fn failed(why: &str) -> trash::Error {
        trash::Error::Unknown {
            description: why.into(),
        }
    }

    /// A fake runner: answers each method in turn from `answers` (moving nothing), and records
    /// what it was asked.
    fn fake(
        answers: Vec<std::result::Result<(), trash::Error>>,
        calls: &mut Vec<Method>,
    ) -> impl FnMut(Method, &[PathBuf]) -> Landed + '_ {
        let mut answers = answers.into_iter();
        move |m, _| {
            calls.push(m);
            answers
                .next()
                .expect("asked more often than answered")
                .map(|()| vec![])
        }
    }

    /// Paths that exist (the test's own source files): nothing is moved, the fake says so.
    fn here() -> Vec<PathBuf> {
        vec![
            PathBuf::from(file!()).canonicalize().unwrap_or_else(|_| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/core/trash_mac.rs")
            }),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
        ]
    }

    fn ledger() -> Mutex<Ledger> {
        Mutex::new(Ledger::new())
    }

    #[test]
    fn finder_that_works_is_the_only_call() {
        let mut calls = vec![];
        trash_with(&here(), &ledger(), fake(vec![Ok(())], &mut calls)).unwrap();
        assert_eq!(calls, [Method::Finder]);
    }

    #[test]
    fn finder_denied_falls_back_to_the_file_manager() {
        let mut calls = vec![];
        trash_with(
            &here(),
            &ledger(),
            fake(vec![Err(denied()), Ok(())], &mut calls),
        )
        .unwrap();
        assert_eq!(calls, [Method::Finder, Method::FileManager]);
    }

    #[test]
    fn both_failing_is_a_typed_denied_refusal_naming_what_is_left() {
        let mut calls = vec![];
        let paths = here();
        let e = trash_with(
            &paths,
            &ledger(),
            fake(
                vec![Err(denied()), Err(failed("trashItemAtURL failed"))],
                &mut calls,
            ),
        )
        .unwrap_err();
        assert_eq!(calls, [Method::Finder, Method::FileManager]);
        let why = no_recycle_bin(&e).expect("a NoRecycleBin, not a raw sentence");
        assert_eq!(why.why, Why::Denied);
        assert_eq!(why.place, PLACE);
        assert_eq!(why.paths, paths);
        assert!(!e.to_string().contains("AppleScript"), "{e}");
    }

    #[test]
    fn only_what_is_still_in_place_is_left_to_ask_about() {
        let mut calls = vec![];
        let gone = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("no-such-file-trove-test");
        let mut paths = here();
        paths.insert(0, gone);
        let e = trash_with(
            &paths,
            &ledger(),
            fake(vec![Err(denied()), Err(failed("x"))], &mut calls),
        )
        .unwrap_err();
        assert_eq!(no_recycle_bin(&e).unwrap().paths, here());
    }

    #[test]
    fn any_other_finder_failure_is_its_plain_sentence_and_not_retried() {
        let mut calls = vec![];
        let e = trash_with(
            &here(),
            &ledger(),
            fake(
                vec![Err(failed(
                    "Finder got an error: Handler can't handle objects of this class.",
                ))],
                &mut calls,
            ),
        )
        .unwrap_err();
        assert_eq!(calls, [Method::Finder]);
        assert!(no_recycle_bin(&e).is_none());
        assert!(e.to_string().starts_with("Finder got an error"));
    }

    /// Review item 4: only an Apple Events refusal followed by a failed file-manager move is
    /// `Denied` ("macOS did not let Trove use the Trash"); every other failure keeps main's plain
    /// sentence, and the file manager is never tried for it.
    #[test]
    fn only_an_apple_events_refusal_can_become_denied() {
        for (words, code) in [
            ("The AppleScript exited with error. stderr: execution error: Finder got an error: The operation can’t be completed because the item is locked. (-50)", 1),
            ("The AppleScript exited with error. stderr: execution error: Finder got an error: Can’t get file \"x\". (-1728)", 1),
            ("The AppleScript exited with error. stderr: execution error: Finder got an error: AppleEvent timed out. (-1712)", 1),
        ] {
            let mut calls = vec![];
            let e = trash_with(
                &here(),
                &ledger(),
                fake(
                    vec![Err(trash::Error::Os {
                        code,
                        description: words.into(),
                    })],
                    &mut calls,
                ),
            )
            .unwrap_err();
            assert_eq!(calls, [Method::Finder], "{words}");
            assert!(no_recycle_bin(&e).is_none(), "{words}");
            assert_eq!(e.to_string(), words);
        }
    }

    #[test]
    fn each_apple_events_refusal_is_recognised_and_nothing_else_is() {
        for words in [
            "execution error: Not authorized to send Apple events to Finder. (-1743)",
            "execution error: (-1744)",
            "errAEEventNotPermitted",
            "errAEEventWouldRequireUserConsent",
        ] {
            assert!(is_apple_events_denied(&failed(words)), "{words}");
        }
        for words in ["Finder got an error: -1728", "No such file", ""] {
            assert!(!is_apple_events_denied(&failed(words)), "{words}");
        }
        assert!(!is_apple_events_denied(&trash::Error::TargetedRoot));
    }

    #[test]
    fn finders_answer_is_one_path_per_line_and_a_folder_loses_its_slash() {
        assert_eq!(
            finder_answer(
                "/Users/a/.Trash/x.txt\n/Users/a/.Trash/Dir/\n/Volumes/D/.Trashes/501/A.app/\n"
            ),
            [
                PathBuf::from("/Users/a/.Trash/x.txt"),
                PathBuf::from("/Users/a/.Trash/Dir"),
                PathBuf::from("/Volumes/D/.Trashes/501/A.app"),
            ]
        );
        assert!(finder_answer("").is_empty());
        assert!(finder_answer("\n").is_empty());
    }

    /// The script takes the paths as arguments (nothing quoted into it), asks Finder once for
    /// the whole batch, and cannot fail after the move over an answer it cannot read.
    #[test]
    fn the_finder_script_asks_once_and_reads_its_answer_safely() {
        let s = FINDER_SCRIPT.join("\n");
        assert_eq!(s.matches("delete").count(), 1);
        assert!(s.starts_with("on run argv"));
        assert!(
            !s.contains("POSIX file \""),
            "no path is ever quoted into the script"
        );
        let after = &s[s.find("set r to delete").unwrap()..];
        let coerce = after.find("as alias").unwrap();
        let tried = after.find("try").unwrap();
        assert!(tried < coerce, "the reading of the answer is inside try");
    }

    // ── the ledger and its undo, in a scratch folder: a fake Trash, never the real one

    /// A fresh folder under the system temp dir, removed when dropped.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "trove-undo-trash-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(p.join("Trash")).unwrap();
            std::fs::create_dir_all(p.join("work")).unwrap();
            Scratch(p)
        }
        fn trash(&self) -> PathBuf {
            self.0.join("Trash")
        }
        fn work(&self, name: &str) -> PathBuf {
            self.0.join("work").join(name)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A fake Finder: moves each item into the scratch Trash under a new name (as the real Trash
    /// renames on a clash) and answers where, newest first (the answer's order is not trusted).
    fn fake_finder(trash: PathBuf) -> impl FnMut(Method, &[PathBuf]) -> Landed {
        let mut n = 0;
        move |m, paths| {
            assert_eq!(m, Method::Finder);
            let mut at = vec![];
            for p in paths {
                n += 1;
                let name = p.file_name().unwrap().to_string_lossy();
                let to = trash.join(format!("{name} {n}"));
                std::fs::rename(p, &to).map_err(|e| failed(&e.to_string()))?;
                at.insert(0, to);
            }
            Ok(at)
        }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn a_delete_records_where_each_item_landed_and_undo_puts_it_back() {
        let sc = Scratch::new("roundtrip");
        let a = sc.work("a.txt");
        let d = sc.work("folder");
        std::fs::write(&a, b"A").unwrap();
        std::fs::create_dir(&d).unwrap();
        std::fs::write(d.join("in.txt"), b"in").unwrap();
        let ledger = ledger();

        trash_with(&[a.clone(), d.clone()], &ledger, fake_finder(sc.trash())).unwrap();
        assert!(!a.exists() && !d.exists());
        let items = lock(&ledger).items().to_vec();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].from, a);
        assert_eq!(items[0].at, sc.trash().join("a.txt 1"));
        assert_eq!(items[1].from, d);
        assert_eq!(items[1].at, sc.trash().join("folder 2"));

        put_back_in(&ledger, &[s(&a), s(&d)], rename_new).unwrap();
        assert_eq!(std::fs::read(&a).unwrap(), b"A");
        assert_eq!(std::fs::read(d.join("in.txt")).unwrap(), b"in");
        assert!(
            lock(&ledger).items().is_empty(),
            "a put-back entry is spent"
        );
        assert_eq!(std::fs::read_dir(sc.trash()).unwrap().count(), 0);
    }

    #[test]
    fn the_file_manager_fallback_is_recorded_too() {
        let sc = Scratch::new("fm");
        let a = sc.work("a.txt");
        std::fs::write(&a, b"A").unwrap();
        let ledger = ledger();
        let mut moved = fake_finder(sc.trash());
        let mut calls = vec![];
        trash_with(std::slice::from_ref(&a), &ledger, |m, p: &[PathBuf]| {
            calls.push(m);
            match m {
                Method::Finder => Err(denied()),
                Method::FileManager => moved(Method::Finder, p),
            }
        })
        .unwrap();
        assert_eq!(calls, [Method::Finder, Method::FileManager]);
        put_back_in(&ledger, &[s(&a)], rename_new).unwrap();
        assert_eq!(std::fs::read(&a).unwrap(), b"A");
    }

    /// An answer that names some other file (or nothing) is not trusted: the item stays in the
    /// Trash with no ⌘Z, and nothing else is ever moved by an undo.
    #[test]
    fn an_answer_that_is_not_the_sent_file_records_nothing() {
        let sc = Scratch::new("wrong-answer");
        let a = sc.work("a.txt");
        let decoy = sc.trash().join("decoy");
        std::fs::write(&a, b"A").unwrap();
        std::fs::write(&decoy, b"decoy").unwrap();
        let ledger = ledger();
        let mut moved = fake_finder(sc.trash());
        let d = decoy.clone();
        trash_with(std::slice::from_ref(&a), &ledger, |m, p: &[PathBuf]| {
            moved(m, p)?;
            Ok(vec![d.clone()])
        })
        .unwrap();
        assert!(lock(&ledger).items().is_empty());
        let e = put_back_in(&ledger, &[s(&a)], rename_new).unwrap_err();
        assert!(e.starts_with("Trove did not send these"), "{e}");
        assert_eq!(std::fs::read(&decoy).unwrap(), b"decoy");
    }

    /// Review item 2: a different file now at the recorded Trash path is never put back.
    #[test]
    fn a_different_file_at_the_trash_place_is_refused_and_both_are_untouched() {
        let sc = Scratch::new("inode");
        let a = sc.work("a.txt");
        std::fs::write(&a, b"A").unwrap();
        let ledger = ledger();
        trash_with(std::slice::from_ref(&a), &ledger, fake_finder(sc.trash())).unwrap();
        let at = sc.trash().join("a.txt 1");
        // the Trash was emptied and another file arrived under the same name
        let elsewhere = sc.0.join("kept-original");
        std::fs::rename(&at, &elsewhere).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(&at, b"some other file").unwrap();

        let e = put_back_in(&ledger, &[s(&a)], rename_new).unwrap_err();
        assert_eq!(
            e,
            format!(
                "Something else is in its place in the Trash now: {}",
                a.display()
            )
        );
        assert!(!a.exists(), "nothing was put back");
        assert_eq!(std::fs::read(&at).unwrap(), b"some other file");
        assert_eq!(std::fs::read(&elsewhere).unwrap(), b"A");
    }

    /// Review item 5: a Trash on a disk that is not connected keeps its entry.
    #[cfg(unix)]
    #[test]
    fn a_disk_that_is_not_connected_keeps_the_entry() {
        let ledger = ledger();
        let root_dev = file_id(Path::new("/")).unwrap().0;
        lock(&ledger).items.push(Trashed {
            from: PathBuf::from("/Volumes/TroveNoSuchDisk/a.txt"),
            at: PathBuf::from("/Volumes/TroveNoSuchDisk/.Trashes/501/a.txt"),
            dev: root_dev.wrapping_add(12345),
            ino: 7,
        });
        let e = put_back_in(
            &ledger,
            &["/Volumes/TroveNoSuchDisk/a.txt".into()],
            rename_new,
        )
        .unwrap_err();
        assert!(e.starts_with("The disk it is on is not connected"), "{e}");
        assert_eq!(lock(&ledger).items().len(), 1, "kept for when it is back");
    }

    #[test]
    fn a_taken_place_is_never_overwritten_and_the_item_stays_in_the_trash() {
        let sc = Scratch::new("taken");
        let a = sc.work("a.txt");
        std::fs::write(&a, b"old").unwrap();
        let ledger = ledger();
        trash_with(std::slice::from_ref(&a), &ledger, fake_finder(sc.trash())).unwrap();
        std::fs::write(&a, b"new").unwrap();

        let e = put_back_in(&ledger, &[s(&a)], rename_new).unwrap_err();
        assert_eq!(
            e,
            format!("Something new is already there: {}", a.display())
        );
        assert_eq!(std::fs::read(&a).unwrap(), b"new", "never overwritten");
        assert!(
            sc.trash().join("a.txt 1").exists(),
            "the old one is still in the Trash"
        );
        assert_eq!(
            lock(&ledger).items().len(),
            1,
            "kept: it can come back once the place is free"
        );
    }

    #[test]
    fn the_exclusive_rename_refuses_an_existing_target() {
        let sc = Scratch::new("excl");
        let (x, y) = (sc.work("x"), sc.work("y"));
        std::fs::write(&x, b"x").unwrap();
        std::fs::write(&y, b"y").unwrap();
        let e = rename_new(&x, &y).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&y).unwrap(), b"y");
    }

    #[test]
    fn gone_from_the_trash_or_never_trashed_by_trove_is_named_and_the_rest_comes_back() {
        let sc = Scratch::new("gone");
        let (a, b) = (sc.work("a.txt"), sc.work("b.txt"));
        // different lengths: off unix, `file_id` tells files apart by size and change time, and two
        // same-size files written within one clock tick would read as the same file
        std::fs::write(&a, b"A").unwrap();
        std::fs::write(&b, b"BB").unwrap();
        let ledger = ledger();
        trash_with(&[a.clone(), b.clone()], &ledger, fake_finder(sc.trash())).unwrap();
        // emptied from the Trash meanwhile
        std::fs::remove_file(sc.trash().join("a.txt 1")).unwrap();
        let stranger = sc.work("never.txt");

        let e = put_back_in(&ledger, &[s(&a), s(&b), s(&stranger)], rename_new).unwrap_err();
        assert_eq!(
            e,
            format!(
                "Not in the Trash any more: {}. Trove did not send these to the Trash in this run: {}",
                a.display(),
                stranger.display()
            )
        );
        assert!(!a.exists());
        assert_eq!(
            std::fs::read(&b).unwrap(),
            b"BB",
            "the rest still came back"
        );
        assert!(lock(&ledger).items().is_empty());
    }

    #[test]
    fn the_newest_entry_of_a_path_is_the_one_put_back() {
        let sc = Scratch::new("twice");
        let a = sc.work("a.txt");
        let ledger = ledger();
        let mut run = fake_finder(sc.trash());
        std::fs::write(&a, b"v1").unwrap();
        trash_with(std::slice::from_ref(&a), &ledger, &mut run).unwrap();
        std::fs::write(&a, b"v2").unwrap();
        trash_with(std::slice::from_ref(&a), &ledger, &mut run).unwrap();

        put_back_in(&ledger, &[s(&a)], rename_new).unwrap();
        assert_eq!(std::fs::read(&a).unwrap(), b"v2");
        assert_eq!(lock(&ledger).items()[0].at, sc.trash().join("a.txt 1"));
    }

    #[test]
    fn the_folder_it_came_from_being_gone_is_said() {
        let sc = Scratch::new("parent");
        let dir = sc.work("sub");
        std::fs::create_dir(&dir).unwrap();
        let a = dir.join("a.txt");
        std::fs::write(&a, b"A").unwrap();
        let ledger = ledger();
        trash_with(std::slice::from_ref(&a), &ledger, fake_finder(sc.trash())).unwrap();
        std::fs::remove_dir(&dir).unwrap();
        let e = put_back_in(&ledger, &[s(&a)], rename_new).unwrap_err();
        assert_eq!(
            e,
            format!("The folder it came from is gone: {}", a.display())
        );
        assert!(sc.trash().join("a.txt 1").exists());
    }

    /// Review item 1: a Delete and an uninstall (`LiveLauncher::trash` is exactly
    /// `ops::trash(&[bundle])`, checked in its source below) go Finder first through the live
    /// runner, and what Finder moved is recorded in the app's ledger. The live runner is a fake
    /// here; without one it panics, so no test reaches the real Trash.
    #[cfg(target_os = "macos")]
    #[test]
    fn ops_trash_and_so_uninstall_go_finder_first_and_are_recorded() {
        use std::cell::RefCell;
        use std::rc::Rc;
        let src = include_str!("uninstall.rs");
        let live = &src[src
            .find("#[cfg(all(not(test), target_os = \"macos\"))]\nimpl Launcher for LiveLauncher")
            .expect("the Mac live launcher")..];
        let body = &live[live.find("fn trash(").unwrap()..];
        let body = &body[..body.find("\n    }").unwrap()];
        assert!(
            body.contains("crate::core::ops::trash(&[bundle.to_path_buf()])"),
            "{body}"
        );

        let sc = Scratch::new("route");
        let app = sc.work("Some.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        type Calls = Rc<RefCell<Vec<(Method, Vec<PathBuf>)>>>;
        let calls: Calls = Rc::default();
        let seen = calls.clone();
        let mut moved = fake_finder(sc.trash());
        FAKE_RUN.with(|f| {
            *f.borrow_mut() = Some(Box::new(move |m, p: &[PathBuf]| {
                seen.borrow_mut().push((m, p.to_vec()));
                moved(m, p)
            }))
        });
        let r = crate::core::ops::trash(std::slice::from_ref(&app));
        FAKE_RUN.with(|f| *f.borrow_mut() = None);
        r.unwrap();
        assert_eq!(*calls.borrow(), [(Method::Finder, vec![app.clone()])]);
        put_back(&[s(&app)]).unwrap();
        assert!(app.join("Contents").is_dir(), "⌘Z put it back");
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[should_panic(expected = "without a fake")]
    fn the_live_runner_refuses_in_tests() {
        let _ = run(Method::Finder, &[]);
    }
}

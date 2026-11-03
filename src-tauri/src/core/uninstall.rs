//! What can be uninstalled, and the one seam every uninstall goes through (plan 18).
//!
//! Trove never removes an app itself: it starts the OS's own way (Windows: the app's
//! `UninstallString`; Ubuntu: GNOME Software, else the removal command typed — not run — in a
//! fresh terminal shell, `uninstall_linux.rs`; macOS: the bundle moved to the Trash, never
//! deleted for good, `uninstall_mac.rs`) after the person said yes, then re-lists to say what
//! happened.
//!
//! ⛔ Test safety (plan 18, "Test safety"): every start goes through `Launcher`. The real one,
//! `LiveLauncher`, exists only `#[cfg(not(test))]`, so no unit test can reach `ShellExecuteExW`.
//! Doc-tests and `tests/*.rs` link the lib without `cfg(test)`, so this module, `uninstall_*.rs`
//! and `commands/uninstall.rs` carry no doc-test blocks at all — `live_launcher_is_never_reachable_from_tests`
//! scans their source for one.

// Windows, macOS and Ubuntu all list rows. On macOS the launch path (`uninstall`, `Running`,
// `Waited`, `Typed`) is unused: a Mac app is moved to the Trash instead. Items only one OS uses
// carry their own per-OS allow below, so clippy stays clean on all three.
#![cfg_attr(target_os = "macos", allow(dead_code))]

use serde::Serialize;

/// Whether the menu item may act on a row, and if not, why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Removable {
    Yes,
    /// part of the OS (`NoRemove=1` on Windows; `Essential`/`required`/`important` on Ubuntu)
    System,
    /// Trove itself
    Trove,
    /// no uninstaller Trove can start safely (missing, ambiguous, not absolute)
    NoUninstaller,
    /// macOS: the bundle, or a folder on its way, is a symlink (plan 18, 3.1)
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Link,
    /// macOS: not a real `.app` bundle folder
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    NotApp,
    /// macOS: not in `/Applications` or `~/Applications`, or on a network volume
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Elsewhere,
}
// "Not on this system yet" (any OS other than Windows, macOS and Ubuntu) is the frontend's: there
// `uninstall_list` returns no rows at all.

/// What an uninstall starts: an absolute program, its arguments exactly as the app wrote them,
/// and the program's folder as the working directory. Never sent to the frontend.
/// On Ubuntu `program` is the whole allow-listed line the confirm shows (`params`, `dir` empty).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub program: String,
    pub params: String,
    pub dir: String,
}

/// One row of "what can be uninstalled". The frontend gets everything but `command`, and sends
/// back `id` plus the name, version and program it showed in the confirm - never anything run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Uninstallable {
    /// opaque, stable: a hash of where the row came from — never a path or a command
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    /// lower-cased folder the app lives in (Windows: `InstallLocation`, else `DisplayIcon`'s
    /// folder); `''` when unknown. The frontend joins Start-menu tiles to rows by it (2.1).
    pub folder: String,
    /// the tile's own file (Ubuntu: the `.desktop` path); the frontend joins by it exactly.
    /// `''` on Windows.
    pub path: String,
    pub removable: Removable,
    /// the resolved uninstaller program (`command.program`), for the confirm to SHOW only;
    /// `''` when there is none. Windows: never its arguments. Ubuntu: the whole line
    /// (`sudo apt remove gnome-mines`), since every word of it is allow-listed. Never used by
    /// Rust to start anything — Rust starts `command`, after checking it equals this.
    pub program: String,
    /// opaque fingerprint of the entry as listed (macOS: a hash of the bundle's device, inode
    /// and mtime); `''` on Windows, whose rows are compared by name, version and program.
    /// Sent back with the id so Rust can refuse an entry that changed since the confirm.
    pub stamp: String,
    /// Ubuntu, no GNOME Software: Trove starts nothing; after the checks the frontend types
    /// `program` (no newline) into a fresh terminal shell, and Enter is the person's.
    pub typed: bool,
    #[serde(skip)]
    pub command: Option<Command>,
    /// Ubuntu: the apt package removing this row would remove (a `Deb` owner), whichever way it
    /// is handed off. Before anything is typed or started, `Launcher::apt_check` simulates that
    /// removal and refuses one that would take an essential or desktop package with it.
    #[serde(skip)]
    pub deb: Option<String>,
}

/// What the person saw in the confirm. `uninstall` refuses when the fresh row says otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Confirmed<'a> {
    pub name: &'a str,
    pub version: &'a str,
    pub program: &'a str,
    pub stamp: &'a str,
}

/// FNV-1a 64 over the parts, NUL-separated: stable across runs and Rust versions, unlike
/// `DefaultHasher`, and it says nothing about what it hashed.
pub fn stable_id(parts: &[&str]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for b in part.bytes().chain(std::iter::once(0)) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

/// How a started uninstaller's wait ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waited {
    /// the process Trove started has exited — not proof the uninstall finished (plan 18, 1.5)
    Exited,
    /// the cap passed first
    TimedOut,
}

/// A started uninstaller.
pub trait Running: Send {
    fn wait(&mut self, cap: std::time::Duration) -> Waited;
}

/// The seam: logic takes `&dyn Launcher`, tests pass a `Recorder`.
pub trait Launcher {
    fn launch(&self, command: &Command) -> Result<Box<dyn Running>, String>;
    /// macOS: move one bundle to the Trash through `ops::trash` (Finder first, the file manager
    /// on an Apple Events refusal, else a typed `NoRecycleBin`). Never a permanent delete.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn trash(&self, bundle: &std::path::Path) -> std::io::Result<()>;
    /// Settings → Installed apps (`ms-settings:appsfeatures`), for a Store app with no
    /// Uninstall key. It cannot jump to one app; the person picks it there.
    fn open_apps_settings(&self) -> Result<(), String>;
    /// Ubuntu: simulate `apt-get -s remove <pkg>` and refuse, with a sentence saying why, when
    /// it would remove an essential package or a desktop metapackage. Read-only: removes nothing.
    fn apt_check(&self, pkg: &str) -> Result<(), String>;
}

/// Why `uninstall` would not start anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    UnknownId,
    /// the row under that id no longer shows what the person confirmed
    Changed,
    Not(Removable),
    /// a typed row asked to be started: Trove never runs a removal command itself
    Typed,
    Launch(String),
    /// macOS: a process runs from inside the bundle
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Running(String),
    /// macOS: neither Finder nor the file manager could move it (a `NoRecycleBin`)
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    NoTrash,
    /// macOS: the move to the Trash failed for another reason, said plainly
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Trash(String),
}

impl Refusal {
    /// A sentence for the toast, never `{:?}`.
    pub fn sentence(&self) -> String {
        match self {
            Refusal::UnknownId => {
                "That app is no longer in the list. Refresh and try again.".into()
            }
            Refusal::Changed => "This app changed since you confirmed - try again".into(),
            Refusal::Not(Removable::System) if cfg!(target_os = "macos") => {
                "Part of macOS: it cannot be moved to the Trash here.".into()
            }
            Refusal::Not(Removable::System) if cfg!(windows) => {
                "Part of Windows: it cannot be uninstalled here.".into()
            }
            Refusal::Not(Removable::System) => {
                "Ubuntu needs this package: it cannot be uninstalled here.".into()
            }
            Refusal::Not(Removable::Link) => "This is a link, not the app.".into(),
            Refusal::Not(Removable::NotApp) => "This is not an app bundle.".into(),
            Refusal::Not(Removable::Elsewhere) => {
                "Only apps in an Applications folder on this Mac can be moved to the Trash here."
                    .into()
            }
            Refusal::Running(name) => format!("Quit {name} first."),
            Refusal::Trash(why) => format!("It was not moved to the Trash: {why}"),
            Refusal::NoTrash => {
                "macOS did not let Trove use the Trash. Drag the app to the Trash in Finder.".into()
            }
            Refusal::Not(Removable::Trove) => "This is Trove: it cannot uninstall itself.".into(),
            Refusal::Not(Removable::NoUninstaller) => "No uninstaller Trove can run safely.".into(),
            Refusal::Not(Removable::Yes) => "Nothing to refuse.".into(),
            Refusal::Typed => "Trove never runs this command itself.".into(),
            Refusal::Launch(why) => format!("The uninstaller did not start: {why}"),
        }
    }
}

/// The fresh row `id` names and the command it holds, only if the row still shows what the
/// person confirmed (`seen`) and may be acted on. Shared by every OS: an id not in `fresh`, a
/// row that is not `Yes`, or a row whose name, version, program or stamp differs from the
/// confirm is refused — the id only says where the row came from, and that place may hold a
/// different app by now.
pub fn resolve<'a>(
    id: &str,
    seen: &Confirmed,
    fresh: &'a [Uninstallable],
) -> Result<(&'a Uninstallable, &'a Command), Refusal> {
    let row = fresh
        .iter()
        .find(|r| r.id == id)
        .ok_or(Refusal::UnknownId)?;
    // ⛔ TOCTOU: the id is a hash of the key (Windows) or the bundle path (macOS), and either
    // can be rewritten between the confirm and now. Act only on what the person saw.
    if row.name != seen.name
        || row.version != seen.version
        || row.program != seen.program
        || row.stamp != seen.stamp
    {
        return Err(Refusal::Changed);
    }
    if row.removable != Removable::Yes {
        return Err(Refusal::Not(row.removable));
    }
    let command = row
        .command
        .as_ref()
        .ok_or(Refusal::Not(Removable::NoUninstaller))?;
    // the program started is the one shown, not merely the one the row says it shows
    if command.program != seen.program {
        return Err(Refusal::Changed);
    }
    Ok((row, command))
}

/// Start the uninstaller of the row `id` names in `fresh` — a list read just now, never one the
/// frontend sent — after [`resolve`] accepted it. A `typed` row (Ubuntu's terminal hand-off) is
/// never started here: the caller hands it back instead.
pub fn uninstall(
    id: &str,
    seen: &Confirmed,
    fresh: &[Uninstallable],
    l: &dyn Launcher,
) -> Result<Box<dyn Running>, Refusal> {
    let (row, command) = resolve(id, seen, fresh)?;
    if row.typed {
        return Err(Refusal::Typed);
    }
    l.launch(command).map_err(Refusal::Launch)
}

/// The real launcher. ⛔ `#[cfg(not(test))]`: under unit tests this type does not exist.
#[cfg(not(test))]
pub struct LiveLauncher;

#[cfg(all(not(test), windows))]
mod live {
    use super::{Command, Launcher, LiveLauncher, Running, Waited};
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::WaitForSingleObject;
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    /// The process handle `ShellExecuteExW` gave back; closed on drop.
    struct Process(HANDLE);
    // SAFETY: a process handle is a kernel object reference, usable from any thread.
    unsafe impl Send for Process {}

    impl Running for Process {
        fn wait(&mut self, cap: std::time::Duration) -> Waited {
            if self.0.is_null() {
                // the shell handed the job to a process it did not report (DDE, a broker):
                // nothing to wait on, so the re-list answers
                return Waited::Exited;
            }
            let ms = u32::try_from(cap.as_millis()).unwrap_or(u32::MAX - 1);
            // SAFETY: the handle is open until `drop`.
            let rc = unsafe { WaitForSingleObject(self.0, ms) };
            if rc == WAIT_OBJECT_0 {
                Waited::Exited
            } else {
                Waited::TimedOut
            }
        }
    }

    impl Drop for Process {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: we own the handle and close it once.
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    /// `ShellExecuteExW`, verb `open`: a `requireAdministrator` uninstaller gets its UAC prompt
    /// (plain `CreateProcess` fails it with error 740). Returns the process handle when asked.
    fn shell_execute(file: &str, params: &str, dir: &str, keep: bool) -> Result<HANDLE, String> {
        let verb = wide("open");
        let file_w = wide(file);
        let params_w = wide(params);
        let dir_w = wide(dir);
        crate::core::icons::ensure_com();
        // SAFETY: zeroed is a valid SHELLEXECUTEINFOW (all pointers null, all flags clear).
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOASYNC | if keep { SEE_MASK_NOCLOSEPROCESS } else { 0 };
        info.lpVerb = verb.as_ptr();
        info.lpFile = file_w.as_ptr();
        info.lpParameters = if params.is_empty() {
            std::ptr::null()
        } else {
            params_w.as_ptr()
        };
        info.lpDirectory = if dir.is_empty() {
            std::ptr::null()
        } else {
            dir_w.as_ptr()
        };
        info.nShow = SW_SHOWNORMAL;
        // SAFETY: every string is NUL-terminated and outlives the call.
        let ok = unsafe { ShellExecuteExW(&mut info) };
        // ⚠️ The call returns a BOOL; `hInstApp` is the fake HINSTANCE where > 32 is success
        // (the trap `launch_app` documents).
        if ok == 0 || (info.hInstApp as isize) <= 32 {
            if !info.hProcess.is_null() {
                // SAFETY: a handle we were given and will not use.
                unsafe { CloseHandle(info.hProcess) };
            }
            let err = std::io::Error::last_os_error();
            return Err(match err.raw_os_error() {
                Some(1223) => "it was cancelled".into(),
                _ => err.to_string(),
            });
        }
        Ok(info.hProcess)
    }

    impl Launcher for LiveLauncher {
        fn launch(&self, c: &Command) -> Result<Box<dyn Running>, String> {
            shell_execute(&c.program, &c.params, &c.dir, true)
                .map(|h| Box::new(Process(h)) as Box<dyn Running>)
        }

        fn open_apps_settings(&self) -> Result<(), String> {
            shell_execute("ms-settings:appsfeatures", "", "", false).map(|h| {
                if !h.is_null() {
                    // SAFETY: not asked for, but closed if given.
                    unsafe { CloseHandle(h) };
                }
            })
        }

        fn trash(&self, _bundle: &std::path::Path) -> std::io::Result<()> {
            Err(std::io::Error::other(
                "Windows uninstalls run the app's own uninstaller",
            ))
        }

        fn apt_check(&self, _pkg: &str) -> Result<(), String> {
            Err("There is no apt on this system.".into())
        }
    }
}

/// macOS: uninstall is the move to the Trash, through the same `ops::trash` Delete uses.
#[cfg(all(not(test), target_os = "macos"))]
impl Launcher for LiveLauncher {
    fn launch(&self, _command: &Command) -> Result<Box<dyn Running>, String> {
        Err("On a Mac an app is moved to the Trash, not uninstalled by a program.".into())
    }
    fn open_apps_settings(&self) -> Result<(), String> {
        Err("There is no Installed apps page on this system.".into())
    }
    fn trash(&self, bundle: &std::path::Path) -> std::io::Result<()> {
        crate::core::ops::trash(&[bundle.to_path_buf()])
    }
    fn apt_check(&self, _pkg: &str) -> Result<(), String> {
        Err("There is no apt on this system.".into())
    }
}

/// Ubuntu: the only program Trove ever starts is GNOME Software on one app's page, where the
/// person presses Uninstall and polkit asks. Every other line is typed, never started
/// (`Refusal::Typed`), so anything but exactly `gnome-software --details=<desktop-id>` is refused.
#[cfg(all(not(test), unix, not(target_os = "macos")))]
mod live_linux {
    use super::{Command, Launcher, LiveLauncher, Running, Waited};
    use crate::core::uninstall_linux::valid_desktop_id;
    use std::process::{Child, Command as Proc, Stdio};
    use std::time::{Duration, Instant};

    /// The started GNOME Software; reaped on drop if it is still open.
    struct Process(Option<Child>);

    impl Running for Process {
        fn wait(&mut self, cap: Duration) -> Waited {
            let Some(child) = self.0.as_mut() else {
                return Waited::Exited;
            };
            let until = Instant::now() + cap;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) | Err(_) => {
                        self.0 = None;
                        return Waited::Exited;
                    }
                    Ok(None) if Instant::now() >= until => return Waited::TimedOut,
                    Ok(None) => std::thread::sleep(Duration::from_millis(250)),
                }
            }
        }
    }

    impl Drop for Process {
        fn drop(&mut self) {
            // past the cap the window is still the person's: never kill it, only reap it later
            if let Some(mut child) = self.0.take() {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            }
        }
    }

    impl Launcher for LiveLauncher {
        fn launch(&self, c: &Command) -> Result<Box<dyn Running>, String> {
            let argv: Vec<&str> = c.program.split(' ').collect();
            let ok = c.params.is_empty()
                && argv.len() == 2
                && argv[0] == "gnome-software"
                && argv[1]
                    .strip_prefix("--details=")
                    .is_some_and(valid_desktop_id);
            if !ok {
                return Err("Trove starts only GNOME Software here.".into());
            }
            // no shell: an argv of exactly two words
            Proc::new(argv[0])
                .arg(argv[1])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map(|child| Box::new(Process(Some(child))) as Box<dyn Running>)
                .map_err(|e| e.to_string())
        }

        fn open_apps_settings(&self) -> Result<(), String> {
            Err("There is no Installed apps page on this system.".into())
        }

        fn trash(&self, _bundle: &std::path::Path) -> std::io::Result<()> {
            Err(std::io::Error::other(
                "Ubuntu removals go through GNOME Software or a typed line",
            ))
        }

        fn apt_check(&self, pkg: &str) -> Result<(), String> {
            crate::core::uninstall_linux::apt_check(pkg)
        }
    }
}

#[cfg(all(not(test), not(windows), not(unix)))]
impl Launcher for LiveLauncher {
    fn launch(&self, _command: &Command) -> Result<Box<dyn Running>, String> {
        Err("Uninstall is not on this system yet.".into())
    }
    fn open_apps_settings(&self) -> Result<(), String> {
        Err("There is no Installed apps page on this system.".into())
    }
    fn trash(&self, _bundle: &std::path::Path) -> std::io::Result<()> {
        Err(std::io::Error::other(
            "Uninstall is not on this system yet.",
        ))
    }
    fn apt_check(&self, _pkg: &str) -> Result<(), String> {
        Err("There is no apt on this system.".into())
    }
}

/// Writes down what would have run. Never starts anything.
#[cfg(test)]
pub struct Recorder {
    pub calls: std::cell::RefCell<Vec<String>>,
    /// what every `wait` of a started fake returns
    pub waited: Waited,
    /// what `apt_check` answers: `None` lets the removal through, `Some(why)` refuses it
    pub apt: Option<String>,
}

#[cfg(test)]
impl Recorder {
    pub fn new(waited: Waited) -> Self {
        Recorder {
            calls: std::cell::RefCell::new(Vec::new()),
            waited,
            apt: None,
        }
    }
}

#[cfg(test)]
struct FakeRunning(Waited);

#[cfg(test)]
impl Running for FakeRunning {
    fn wait(&mut self, _cap: std::time::Duration) -> Waited {
        self.0
    }
}

#[cfg(test)]
impl Launcher for Recorder {
    fn launch(&self, c: &Command) -> Result<Box<dyn Running>, String> {
        self.calls
            .borrow_mut()
            .push(format!("{} | {} | {}", c.program, c.params, c.dir));
        Ok(Box::new(FakeRunning(self.waited)))
    }
    fn open_apps_settings(&self) -> Result<(), String> {
        self.calls.borrow_mut().push("settings".into());
        Ok(())
    }
    /// Writes the bundle down; moves nothing.
    fn trash(&self, bundle: &std::path::Path) -> std::io::Result<()> {
        self.calls
            .borrow_mut()
            .push(format!("trash {}", bundle.display()));
        Ok(())
    }
    /// Writes the simulation down; simulates nothing.
    fn apt_check(&self, pkg: &str) -> Result<(), String> {
        self.calls
            .borrow_mut()
            .push(format!("apt-get -s remove {pkg}"));
        self.apt.clone().map_or(Ok(()), Err)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn row(id: &str, name: &str, removable: Removable) -> Uninstallable {
        Uninstallable {
            id: id.into(),
            name: name.into(),
            version: "1.0".into(),
            publisher: "Pub".into(),
            folder: String::new(),
            path: String::new(),
            removable,
            program: format!(r"C:\Program Files\{name}\uninst.exe"),
            stamp: String::new(),
            typed: false,
            command: Some(Command {
                program: format!(r"C:\Program Files\{name}\uninst.exe"),
                params: "/x".into(),
                dir: format!(r"C:\Program Files\{name}"),
            }),
            deb: None,
        }
    }

    /// What the confirm showed for `row` - the same as the row.
    pub(crate) fn seen(r: &Uninstallable) -> Confirmed<'_> {
        Confirmed {
            name: &r.name,
            version: &r.version,
            program: &r.program,
            stamp: &r.stamp,
        }
    }

    #[test]
    fn a_changed_row_is_refused_and_nothing_runs() {
        let rec = Recorder::new(Waited::Exited);
        let confirmed = row("a", "A", Removable::Yes);
        let shown = seen(&confirmed);
        // the same key now holds another app, another version, or another program
        let mut other_name = confirmed.clone();
        other_name.name = "Evil".into();
        let mut other_version = confirmed.clone();
        other_version.version = "2.0".into();
        let mut other_program = confirmed.clone();
        other_program.program = r"C:\Users\x\evil.exe".into();
        if let Some(c) = other_program.command.as_mut() {
            c.program = r"C:\Users\x\evil.exe".into();
        }
        for fresh in [other_name, other_version, other_program] {
            assert_eq!(
                uninstall("a", &shown, &[fresh], &rec).err(),
                Some(Refusal::Changed)
            );
        }
        assert!(rec.calls.borrow().is_empty());
        assert_eq!(
            Refusal::Changed.sentence(),
            "This app changed since you confirmed - try again"
        );
        // unchanged: it runs
        assert!(uninstall("a", &shown, std::slice::from_ref(&confirmed), &rec).is_ok());
        assert_eq!(rec.calls.borrow().len(), 1);
    }

    #[test]
    fn the_program_is_sent_for_display_but_never_the_params() {
        let r = row("a", "A", Removable::Yes);
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["program"], r"C:\Program Files\A\uninst.exe");
        assert!(json.get("command").is_none());
        assert!(!json.to_string().contains("/x"), "{json}");
    }

    #[test]
    fn id_is_stable_and_opaque() {
        let a = stable_id(&["windows", "hklm", "7-Zip"]);
        assert_eq!(a, stable_id(&["windows", "hklm", "7-Zip"]));
        assert_ne!(a, stable_id(&["windows", "hkcu", "7-Zip"]));
        // parts do not run together: ("ab","c") is not ("a","bc")
        assert_ne!(stable_id(&["ab", "c"]), stable_id(&["a", "bc"]));
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!a.contains("7-Zip"));
    }

    #[test]
    fn unknown_id_is_refused_and_nothing_runs() {
        let rec = Recorder::new(Waited::Exited);
        let fresh = vec![row("a", "A", Removable::Yes)];
        assert_eq!(
            uninstall("zzz", &seen(&fresh[0]), &fresh, &rec).err(),
            Some(Refusal::UnknownId)
        );
        assert!(rec.calls.borrow().is_empty());
    }

    #[test]
    fn system_and_trove_rows_are_refused() {
        let rec = Recorder::new(Waited::Exited);
        for r in [
            Removable::System,
            Removable::Trove,
            Removable::NoUninstaller,
        ] {
            let fresh = vec![row("a", "A", r)];
            assert_eq!(
                uninstall("a", &seen(&fresh[0]), &fresh, &rec).err(),
                Some(Refusal::Not(r))
            );
        }
        assert!(rec.calls.borrow().is_empty());
    }

    #[test]
    fn the_recorder_sees_exactly_one_call() {
        let rec = Recorder::new(Waited::Exited);
        let fresh = vec![row("a", "A", Removable::Yes), row("b", "B", Removable::Yes)];
        let Ok(mut started) = uninstall("b", &seen(&fresh[1]), &fresh, &rec) else {
            panic!("not started");
        };
        assert_eq!(
            started.wait(std::time::Duration::from_secs(1)),
            Waited::Exited
        );
        assert_eq!(
            *rec.calls.borrow(),
            vec![r"C:\Program Files\B\uninst.exe | /x | C:\Program Files\B".to_string()]
        );
        // a Store app's way: Settings, through the same seam
        let rec = Recorder::new(Waited::Exited);
        assert_eq!(rec.open_apps_settings(), Ok(()));
        assert_eq!(*rec.calls.borrow(), vec!["settings".to_string()]);
    }

    /// Test safety 2: doc-tests and `tests/*.rs` link the lib without `cfg(test)`, where
    /// `LiveLauncher` exists. So no doc-test block may sit in these files, `tests/` may not
    /// name the live launcher or the command, and the command file names `LiveLauncher` only
    /// inside items marked `#[cfg(not(test))]`.
    #[test]
    fn live_launcher_is_never_reachable_from_tests() {
        let fence = "`".repeat(3);
        let sources = [
            ("core/uninstall.rs", include_str!("uninstall.rs")),
            (
                "core/uninstall_windows.rs",
                include_str!("uninstall_windows.rs"),
            ),
            (
                "core/uninstall_linux.rs",
                include_str!("uninstall_linux.rs"),
            ),
            (
                "commands/uninstall.rs",
                include_str!("../commands/uninstall.rs"),
            ),
            ("core/uninstall_mac.rs", include_str!("uninstall_mac.rs")),
        ];
        for (name, src) in sources {
            assert!(!src.contains(&fence), "{name} holds a doc-test fence");
        }

        let live = ["Live", "Launcher"].concat();
        // in this file the struct itself is cfg(not(test))
        let core = sources[0].1;
        let decl = format!("pub struct {live};");
        let at = core
            .find(&decl)
            .expect("the live launcher is declared here");
        assert!(
            core[..at].trim_end().ends_with("#[cfg(not(test))]"),
            "the live launcher must be #[cfg(not(test))]"
        );

        // in the command file every line naming it sits in an item marked cfg(not(test))
        let lines: Vec<&str> = sources[3].1.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if !line.contains(&live) || line.trim_start().starts_with("//") {
                continue;
            }
            let item = (0..=i)
                .rev()
                .find(|&j| {
                    let t = lines[j].trim_start();
                    lines[j].starts_with(|c: char| !c.is_whitespace())
                        && (t.starts_with("pub ")
                            || t.starts_with("fn ")
                            || t.starts_with("async fn ")
                            || t.starts_with("use "))
                })
                .expect("an item holds the line");
            let attrs = lines[item.saturating_sub(4)..item].join("\n");
            assert!(
                attrs.contains("#[cfg(not(test))]") || lines[item].contains("cfg(not(test))"),
                "commands/uninstall.rs line {} names the live launcher outside a cfg(not(test)) item",
                i + 1
            );
        }

        let tests_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
        if let Ok(entries) = std::fs::read_dir(&tests_dir) {
            for e in entries.flatten() {
                let text = std::fs::read_to_string(e.path()).unwrap_or_default();
                assert!(
                    !text.contains(&live),
                    "{:?} names the live launcher",
                    e.path()
                );
                assert!(
                    !text.contains(&["uninstall", "_app"].concat()),
                    "{:?} names the uninstall command",
                    e.path()
                );
            }
        }
    }
}

//! Who is holding a file open (plan 21 phase 21B). A delete, move or rename that fails with
//! "being used by another process" names the program instead, and can ask it to close.
//!
//! Windows asks the Restart Manager (`RmStartSession` → `RmRegisterResources` → `RmGetList`),
//! the API Explorer's own "File In Use" dialog and PowerToys' File Locksmith use. It needs no
//! admin and works on Trove's own process too (the test relies on that). Other systems return
//! no lockers: the error they show stays the OS's sentence (lsof is out of scope, plan 21).
//!
//! ⛔ Ending a program loses its unsaved work. [`end`] never touches Trove (this window or
//! another), the terminal pane's shell, Explorer, a service, anything the Restart Manager calls
//! critical, or a program in another Windows session; it closes politely first (`WM_CLOSE` to
//! the program's windows) and only kills with `force` after that polite try, within
//! [`POLITE_FRESH`]. The frontend asks the person before each step; this side re-checks
//! everything on its own.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Windows' "in use" codes: `ERROR_SHARING_VIOLATION` (32) and `ERROR_LOCK_VIOLATION` (33).
pub const IN_USE_CODES: [i32; 2] = [32, 33];

/// One program that holds a file open.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Locker {
    pub pid: u32,
    /// "Microsoft Word" (the Restart Manager's `strAppName`), else the exe's file name
    pub app: String,
    /// the program's file name, `WINWORD.EXE`; empty when Windows would not say
    pub exe: String,
    /// false: Windows needs it, or it is Trove — no End task, "close it yourself" instead
    pub can_end: bool,
    /// why there is no End task; None exactly when `can_end`
    pub no_end: Option<NoEnd>,
}

/// Why a program gets no End task; the frontend words each one.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NoEnd {
    /// Trove itself, or another Trove window ([`TROVE_EXES`])
    Trove,
    /// the terminal pane's shell, or a program started in it
    Terminal,
    /// Windows needs it: a [`NEVER_END`] name, a service, Explorer, critical
    Windows,
    /// it runs in another Windows session (another person signed in, or Windows' own)
    OtherSession,
}

/// A path and who holds it; a path nobody holds is left out.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LockedPath {
    pub path: String,
    pub lockers: Vec<Locker>,
}

/// What [`end`] did. Only Windows ends anything; elsewhere [`end`] always errors.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub enum Ended {
    /// it is gone (closed when asked, or killed with `force`)
    Ended,
    /// asked politely and still running after the wait: the frontend may offer Force end
    StillRunning,
}

/// What the `trash` crate says when the shell's Recycle Bin move fails on a file in use: no
/// code at all, only `Unknown { description: "Some operations were aborted" }`.
const TRASH_ABORTED: &str = "some operations were aborted";

/// An OS error text means "in use": `(os error 32)` / `(os error 33)` from std, the same two
/// as an HRESULT (`0x80070020` / `0x80070021`), or Delete to the Recycle Bin's
/// [`TRASH_ABORTED`] — which the lookup then confirms or finds nobody behind.
pub fn is_in_use_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let os = IN_USE_CODES
        .iter()
        .any(|c| lower.contains(&format!("os error {c})")));
    let hresult = IN_USE_CODES
        .iter()
        .any(|c| lower.contains(&format!("0x800700{c:x}")));
    os || hresult || lower.contains(TRASH_ABORTED)
}

/// Programs Windows itself needs: ending one logs the person out or blue-screens the machine.
/// Matched on the exe's file name, case-insensitively. Explorer is here too: it is the desktop.
const NEVER_END: [&str; 14] = [
    "explorer.exe",
    "csrss.exe",
    "winlogon.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "smss.exe",
    "svchost.exe",
    "dwm.exe",
    "system",
    "registry",
    "fontdrvhost.exe",
    "sihost.exe",
    "msmpeng.exe",
];

/// The Restart Manager's kinds (`RM_APP_TYPE`) that are never ended: a service (3), Explorer
/// (4) and critical (1000).
const NEVER_END_TYPES: [i32; 3] = [3, 4, 1000];

/// Trove's own file names, lower case: the release build (`productName`), the screen build
/// (`tauri.screen.conf.json`) and `cargo` / `tauri dev` (the crate's bin name). Another Trove
/// window holding a file is Trove too, never ended from here.
const TROVE_EXES: [&str; 2] = ["trove.exe", "trove screen.exe"];

/// What the terminal pane starts (`core/pty.rs` `shell_for`, and `cmd.exe` in its tests): a
/// process whose parent is Trove and whose name is one of these is the pane's own shell.
const TERMINAL_SHELLS: [&str; 4] = ["pwsh.exe", "powershell.exe", "wsl.exe", "cmd.exe"];

/// The last part of a Windows program path, lower-cased. It splits on `\` and `/` itself
/// rather than through `Path`, which on Mac and Linux keeps a Windows path whole.
fn file_name_lower(exe: &str) -> String {
    exe.rsplit(['\\', '/'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Why Trove may not offer End task for this program, or None: it may. `in_terminal`: it is
/// the terminal pane's shell or runs under it ([`in_terminal`]); `same_session`: it runs in
/// Trove's own Windows session ([`same_session`]).
// only the Windows lookup asks it (and the tests, everywhere)
#[cfg_attr(not(windows), allow(dead_code))]
pub fn no_end(
    pid: u32,
    exe: &str,
    app_type: i32,
    in_terminal: bool,
    same_session: bool,
) -> Option<NoEnd> {
    let name = file_name_lower(exe);
    if pid == std::process::id() || TROVE_EXES.contains(&name.as_str()) {
        Some(NoEnd::Trove)
    } else if in_terminal {
        Some(NoEnd::Terminal)
    } else if pid <= 4 // 0 Idle, 4 System
        || NEVER_END_TYPES.contains(&app_type)
        || NEVER_END.contains(&name.as_str())
    {
        Some(NoEnd::Windows)
    } else if !same_session {
        Some(NoEnd::OtherSession)
    } else {
        None
    }
}

/// Both sessions are known and the same: a program in another session (another person's, or
/// Windows' session 0) is never ended, even when it is not on any never-end list.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn same_session(theirs: Option<u32>, mine: Option<u32>) -> bool {
    matches!((theirs, mine), (Some(a), Some(b)) if a == b)
}

/// Is `pid` the terminal pane's shell, or a program started under it? Walks up the parents
/// (`parent_of(pid)` → its parent's pid and its own exe name) until one is a child of `me`;
/// that child must be a [`TERMINAL_SHELLS`] name. Anything else Trove started (a file opened
/// with its app) is not the terminal. At most 64 steps, so a parent loop cannot hang it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn in_terminal(pid: u32, me: u32, parent_of: impl Fn(u32) -> Option<(u32, String)>) -> bool {
    let mut at = pid;
    for _ in 0..64 {
        let Some((parent, exe)) = parent_of(at) else {
            return false;
        };
        if parent == me {
            return TERMINAL_SHELLS.contains(&file_name_lower(&exe).as_str());
        }
        if parent == 0 || parent == at {
            return false;
        }
        at = parent;
    }
    false
}

/// Does `path` name the program's own exe (`image`)? The Restart Manager reports a running
/// program as holding its own file; ending it to delete that file is never what was meant.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_own_image(path: &Path, image: &str) -> bool {
    let plain = |s: &str| {
        let s = s.replace('/', "\\").to_lowercase();
        s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
    };
    !image.is_empty() && plain(&path.to_string_lossy()) == plain(image)
}

/// How long a polite close counts: Force end is for a program asked to close in the last
/// two minutes, never a first move.
pub const POLITE_FRESH: Duration = Duration::from_secs(120);

/// One polite close: the pid, its start time (so a reused pid does not count), and when.
type Asked = (u32, u64, Instant);

/// The polite closes [`end`] made, newest last; old ones fall out on each write.
#[cfg_attr(not(windows), allow(dead_code))]
static ASKED: Mutex<Vec<Asked>> = Mutex::new(Vec::new());

/// Write down a polite close of (`pid`, `started`) at `now`, and forget the stale ones.
#[cfg_attr(not(windows), allow(dead_code))]
fn remember_asked(asked: &mut Vec<Asked>, pid: u32, started: u64, now: Instant) {
    asked.retain(|&(p, s, at)| now.duration_since(at) < POLITE_FRESH && (p, s) != (pid, started));
    asked.push((pid, started, now));
}

/// Was (`pid`, `started`) asked to close politely within [`POLITE_FRESH`] before `now`?
#[cfg_attr(not(windows), allow(dead_code))]
fn asked_recently(asked: &[Asked], pid: u32, started: u64, now: Instant) -> bool {
    asked
        .iter()
        .any(|&(p, s, at)| (p, s) == (pid, started) && now.duration_since(at) < POLITE_FRESH)
}

/// What [`end`] says when it refuses `app` for `why`.
#[cfg_attr(not(windows), allow(dead_code))]
fn refusal(why: NoEnd, app: &str) -> String {
    match why {
        NoEnd::Trove => "Trove itself has this file open".to_string(),
        NoEnd::Terminal => "Trove's terminal has this file open — close it there".to_string(),
        NoEnd::Windows => format!("Windows needs {app}; close it yourself"),
        NoEnd::OtherSession => {
            format!("{app} runs in another Windows session; Trove cannot end it")
        }
    }
}

/// Who holds each of `paths` open, at most [`MAX_PATHS`] of them. Empty off Windows, and when
/// `error` is not an "in use" error — the caller passes every failure and this side decides.
pub fn locked(paths: &[PathBuf], error: &str) -> Vec<LockedPath> {
    if !is_in_use_error(error) {
        return Vec::new();
    }
    paths
        .iter()
        .take(MAX_PATHS)
        .filter_map(|p| {
            let lockers = lockers(std::slice::from_ref(p));
            (!lockers.is_empty()).then(|| LockedPath {
                path: p.to_string_lossy().into_owned(),
                lockers,
            })
        })
        .collect()
}

/// A batch delete names at most this many paths; each is one Restart Manager session.
pub const MAX_PATHS: usize = 20;

/// Who holds any of `paths` open. Empty off Windows, and on any Restart Manager failure.
pub fn lockers(paths: &[PathBuf]) -> Vec<Locker> {
    #[cfg(windows)]
    return win::lockers(paths);
    #[cfg(not(windows))]
    {
        let _ = paths;
        Vec::new()
    }
}

/// End the program `pid`, which must still hold `path` open (so a pid reused since the notice
/// was shown is never touched). Politely first: `WM_CLOSE` to its windows, then up to
/// 8 s (`win::POLITE_WAIT_MS`) for it to go. `force` kills it outright — only after a second
/// "yes", and only for a program this side asked politely within [`POLITE_FRESH`].
pub fn end(path: &Path, pid: u32, force: bool) -> Result<Ended, String> {
    #[cfg(windows)]
    return win::end(path, pid, force);
    #[cfg(not(windows))]
    {
        let _ = (path, pid, force);
        Err("Ending a program is only available on Windows".to_string())
    }
}

#[cfg(windows)]
mod win {
    use super::{
        asked_recently, in_terminal, is_own_image, no_end, refusal, remember_asked, same_session,
        Ended, Locker, ASKED,
    };
    use std::collections::HashMap;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::time::Instant;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_MORE_DATA, ERROR_SUCCESS, FILETIME, HANDLE, HWND, INVALID_HANDLE_VALUE,
        LPARAM, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows_sys::Win32::System::RestartManager::{
        RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
        RM_PROCESS_INFO,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
        WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, PostMessageW, WM_CLOSE,
    };

    /// How long a polite close gets before the frontend offers Force end: long enough for a
    /// "Save changes?" box to come up and be seen.
    const POLITE_WAIT_MS: u32 = 8000;

    /// One Restart Manager entry: the locker, plus the start time that pins its pid.
    struct Found {
        locker: Locker,
        started: FILETIME,
    }

    /// Every running process: pid → (parent pid, exe file name), from one Toolhelp snapshot.
    /// Empty when Windows will not take one (then nothing counts as the terminal's).
    fn processes() -> HashMap<u32, (u32, String)> {
        let mut all = HashMap::new();
        // SAFETY: plain call; INVALID_HANDLE_VALUE is checked.
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE {
            return all;
        }
        let snap = Process(snap);
        // SAFETY: zeroed is a valid PROCESSENTRY32W; dwSize is set before the first call.
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        // SAFETY: `entry` is sized; the snapshot handle is open.
        let mut more = unsafe { Process32FirstW(snap.0, &mut entry) } != 0;
        while more {
            all.insert(
                entry.th32ProcessID,
                (entry.th32ParentProcessID, text(&entry.szExeFile)),
            );
            // SAFETY: as above.
            more = unsafe { Process32NextW(snap.0, &mut entry) } != 0;
        }
        all
    }

    /// The Windows session `pid` runs in; None when Windows will not say.
    pub fn session_of(pid: u32) -> Option<u32> {
        let mut session = 0u32;
        // SAFETY: `session` is a stack out-pointer.
        (unsafe { ProcessIdToSessionId(pid, &mut session) } != 0).then_some(session)
    }

    fn ticks(t: FILETIME) -> u64 {
        (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn text(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    pub fn lockers(paths: &[PathBuf]) -> Vec<Locker> {
        found(paths).into_iter().map(|f| f.locker).collect()
    }

    fn found(paths: &[PathBuf]) -> Vec<Found> {
        if paths.is_empty() {
            return Vec::new();
        }
        let mut session = 0u32;
        let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
        // SAFETY: `key` is the CCH_RM_SESSION_KEY + 1 buffer the call asks for.
        if unsafe { RmStartSession(&mut session, 0, key.as_mut_ptr()) } != ERROR_SUCCESS {
            return Vec::new();
        }
        let list = list(session, paths);
        // SAFETY: the session was started above; ending it is always allowed.
        unsafe { RmEndSession(session) };
        list
    }

    fn list(session: u32, paths: &[PathBuf]) -> Vec<Found> {
        let names: Vec<Vec<u16>> = paths.iter().map(|p| wide(p)).collect();
        let ptrs: Vec<*const u16> = names.iter().map(|n| n.as_ptr()).collect();
        // SAFETY: `ptrs` points at NUL-terminated strings `names` keeps alive for the call.
        let registered = unsafe {
            RmRegisterResources(
                session,
                ptrs.len() as u32,
                ptrs.as_ptr(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
            )
        };
        if registered != ERROR_SUCCESS {
            return Vec::new();
        }
        let mut infos: Vec<RM_PROCESS_INFO> = Vec::new();
        // the list can grow between the size query and the read: ask again, a few times
        for _ in 0..4 {
            let mut needed = 0u32;
            let mut count = infos.len() as u32;
            let mut reasons = 0u32;
            // SAFETY: `infos` has room for `count` entries; the call writes at most that many.
            let r = unsafe {
                RmGetList(
                    session,
                    &mut needed,
                    &mut count,
                    infos.as_mut_ptr(),
                    &mut reasons,
                )
            };
            if r == ERROR_SUCCESS {
                infos.truncate(count as usize);
                if infos.is_empty() {
                    return Vec::new();
                }
                let all = processes();
                let mine = session_of(std::process::id());
                return infos.iter().map(|i| found_of(i, &all, mine)).collect();
            }
            if r != ERROR_MORE_DATA {
                return Vec::new();
            }
            infos = vec![RM_PROCESS_INFO::default(); needed as usize];
        }
        Vec::new()
    }

    fn found_of(
        info: &RM_PROCESS_INFO,
        all: &HashMap<u32, (u32, String)>,
        mine: Option<u32>,
    ) -> Found {
        let pid = info.Process.dwProcessId;
        let exe = exe_of(pid).unwrap_or_default();
        let file = Path::new(&exe)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let named = text(&info.strAppName);
        let app = if named.trim().is_empty() {
            if file.is_empty() {
                format!("Program {pid}")
            } else {
                file.clone()
            }
        } else {
            named
        };
        let terminal = in_terminal(pid, std::process::id(), |p| all.get(&p).cloned());
        let why = no_end(
            pid,
            &file,
            info.ApplicationType,
            terminal,
            same_session(session_of(pid), mine),
        );
        Found {
            locker: Locker {
                pid,
                app,
                can_end: why.is_none(),
                no_end: why,
                exe: file,
            },
            started: info.Process.ProcessStartTime,
        }
    }

    /// An open process handle, closed on drop.
    struct Process(HANDLE);
    impl Drop for Process {
        fn drop(&mut self) {
            // SAFETY: a handle OpenProcess returned, closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn open(pid: u32, access: u32) -> Option<Process> {
        // SAFETY: plain call; a null handle is checked.
        let h = unsafe { OpenProcess(access, 0, pid) };
        (!h.is_null()).then_some(Process(h))
    }

    fn exe_of(pid: u32) -> Option<String> {
        let p = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY: `buf` holds `len` u16s; the call writes at most that and sets `len`.
        let ok = unsafe {
            QueryFullProcessImageNameW(p.0, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        (ok != 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }

    fn started(p: &Process) -> Option<FILETIME> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: four FILETIME out-pointers on the stack.
        let ok = unsafe { GetProcessTimes(p.0, &mut created, &mut exited, &mut kernel, &mut user) };
        (ok != 0).then_some(created)
    }

    fn same_time(a: FILETIME, b: FILETIME) -> bool {
        a.dwLowDateTime == b.dwLowDateTime && a.dwHighDateTime == b.dwHighDateTime
    }

    /// Post `WM_CLOSE` to every top-level window `pid` owns: "close, please", as the title
    /// bar's × does. The program may ask the person to save first.
    fn close_windows(pid: u32) {
        unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> i32 {
            let mut owner = 0u32;
            // SAFETY: `hwnd` comes from EnumWindows; `owner` is a stack out-pointer.
            unsafe { GetWindowThreadProcessId(hwnd, &mut owner) };
            if owner == lparam as u32 {
                // SAFETY: posting a message to a live window; a dead one just fails.
                unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) };
            }
            1
        }
        // SAFETY: `each` matches WNDENUMPROC; the pid travels in `lparam`.
        unsafe { EnumWindows(Some(each), pid as LPARAM) };
    }

    pub fn end(path: &Path, pid: u32, force: bool) -> Result<Ended, String> {
        // the program must still hold the file, with the same start time as now: a pid that
        // was reused since the notice was shown is a different program
        let who = found(&[path.to_path_buf()])
            .into_iter()
            .find(|f| f.locker.pid == pid)
            .ok_or_else(|| "That program no longer has the file open".to_string())?;
        if let Some(why) = who.locker.no_end {
            return Err(refusal(why, &who.locker.app));
        }
        // the lookup already said so for this pid; asked again here so the refusal never rests
        // on a field the lookup might one day fill differently
        if !same_session(session_of(pid), session_of(std::process::id())) {
            return Err(refusal(super::NoEnd::OtherSession, &who.locker.app));
        }
        if exe_of(pid).is_some_and(|image| is_own_image(path, &image)) {
            return Err(format!(
                "That is {}'s own program file; close {} first",
                who.locker.app, who.locker.app
            ));
        }
        let born = ticks(who.started);
        let asked = ASKED.lock().unwrap_or_else(|e| e.into_inner());
        if force && !asked_recently(&asked, pid, born, Instant::now()) {
            return Err(format!("Ask {} to close first", who.locker.app));
        }
        drop(asked);
        let access = PROCESS_SYNCHRONIZE
            | PROCESS_QUERY_LIMITED_INFORMATION
            | if force { PROCESS_TERMINATE } else { 0 };
        let process = open(pid, access)
            .ok_or_else(|| format!("Trove is not allowed to end {}", who.locker.app))?;
        if !started(&process).is_some_and(|t| same_time(t, who.started)) {
            return Err("That program no longer has the file open".to_string());
        }
        if force {
            // SAFETY: a handle opened with PROCESS_TERMINATE for this exact process.
            if unsafe { TerminateProcess(process.0, 1) } == 0 {
                return Err(format!("Windows would not end {}", who.locker.app));
            }
            // SAFETY: a handle opened with PROCESS_SYNCHRONIZE.
            unsafe { WaitForSingleObject(process.0, POLITE_WAIT_MS) };
            return Ok(Ended::Ended);
        }
        remember_asked(
            &mut ASKED.lock().unwrap_or_else(|e| e.into_inner()),
            pid,
            born,
            Instant::now(),
        );
        close_windows(pid);
        // SAFETY: a handle opened with PROCESS_SYNCHRONIZE.
        let gone = unsafe { WaitForSingleObject(process.0, POLITE_WAIT_MS) } == WAIT_OBJECT_0;
        Ok(if gone {
            Ended::Ended
        } else {
            Ended::StillRunning
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_use_is_os_error_32_or_33_and_their_hresults() {
        for yes in [
            "The process cannot access the file because it is being used by another process. (os error 32)",
            "C:\\a.docx: The process cannot access the file because another process has locked a portion of the file. (os error 33)",
            "Os { code: -2147024864 } 0x80070020",
            "HRESULT 0X80070021",
            // the `trash` crate's Recycle Bin failure on a file in use (finding 1, review 21B)
            "Some operations were aborted",
            "Error: Unknown { description: \"Some operations were aborted\" }",
        ] {
            assert!(is_in_use_error(yes), "{yes}");
        }
        for no in [
            "Access is denied. (os error 5)",
            "The system cannot find the file specified. (os error 2)",
            "(os error 320)",
            "There is already a file or folder named 'a' here",
            "",
        ] {
            assert!(!is_in_use_error(no), "{no}");
        }
    }

    /// `no_end` for a program in Trove's session and not under its terminal, as a yes / no.
    fn can_end(pid: u32, exe: &str, app_type: i32) -> bool {
        no_end(pid, exe, app_type, false, true).is_none()
    }

    #[test]
    fn never_ends_trove_windows_programs_services_or_critical() {
        let me = std::process::id();
        assert!(!can_end(me, "trove.exe", 1), "Trove itself");
        assert_eq!(no_end(me, "x.exe", 1, false, true), Some(NoEnd::Trove));
        for trove in [
            "trove.exe",
            "Trove.exe",
            "Trove Screen.exe",
            r"C:\Apps\Trove\trove.exe",
        ] {
            assert_eq!(
                no_end(9999, trove, 1, false, true),
                Some(NoEnd::Trove),
                "another Trove window: {trove}"
            );
        }
        assert_eq!(
            no_end(9999, "pwsh.exe", 1, true, true),
            Some(NoEnd::Terminal),
            "the terminal pane's shell"
        );
        assert_eq!(
            no_end(9999, "WINWORD.EXE", 1, false, false),
            Some(NoEnd::OtherSession),
            "another Windows session"
        );
        assert_eq!(
            no_end(9999, "explorer.exe", 1, false, false),
            Some(NoEnd::Windows)
        );
        for exe in [
            "explorer.exe",
            "EXPLORER.EXE",
            "csrss.exe",
            "winlogon.exe",
            "services.exe",
            "lsass.exe",
            "svchost.exe",
            r"C:\Windows\System32\dwm.exe",
        ] {
            assert!(!can_end(9999, exe, 1), "{exe}");
        }
        assert!(!can_end(9999, "WINWORD.EXE", 3), "a service");
        assert!(!can_end(9999, "WINWORD.EXE", 4), "Explorer by kind");
        assert!(!can_end(9999, "WINWORD.EXE", 1000), "critical");
        assert!(!can_end(4, "", 0), "System");
        assert!(!can_end(0, "", 0), "Idle");
        assert!(can_end(9999, "WINWORD.EXE", 1), "an ordinary app");
        assert!(can_end(9999, r"C:\Tools\notepad.exe", 2));
    }

    #[test]
    fn not_in_use_error_asks_nobody() {
        let p = std::env::temp_dir().join("trove-lockers-none.txt");
        assert!(locked(&[p], "Access is denied. (os error 5)").is_empty());
    }

    #[test]
    fn another_session_or_an_unknown_one_is_never_ours() {
        assert!(same_session(Some(1), Some(1)));
        assert!(
            !same_session(Some(0), Some(1)),
            "session 0: services.exe and friends"
        );
        assert!(!same_session(Some(2), Some(1)), "another person signed in");
        assert!(!same_session(None, Some(1)), "Windows would not say");
        assert!(!same_session(Some(1), None));
    }

    #[test]
    fn the_terminal_is_a_shell_trove_started_or_anything_under_it() {
        let me = 100;
        let tree = |p: u32| -> Option<(u32, String)> {
            match p {
                200 => Some((me, "pwsh.exe".into())),    // the pane's shell
                300 => Some((200, "python.exe".into())), // started in it
                400 => Some((me, "WINWORD.EXE".into())), // a file Trove opened with its app
                500 => Some((4, "WINWORD.EXE".into())),  // nothing to do with Trove
                600 => Some((600, "loop.exe".into())),   // its own parent
                _ => None,
            }
        };
        assert!(in_terminal(200, me, tree));
        assert!(in_terminal(300, me, tree));
        assert!(!in_terminal(400, me, tree));
        assert!(!in_terminal(500, me, tree));
        assert!(!in_terminal(600, me, tree));
        assert!(!in_terminal(999, me, tree), "a pid that is gone");
    }

    #[test]
    fn a_program_holding_its_own_exe_is_not_ended_for_it() {
        let image = r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE";
        assert!(is_own_image(
            Path::new(r"c:\program files\microsoft office\root\office16\winword.exe"),
            image
        ));
        assert!(is_own_image(
            Path::new(r"\\?\C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE"),
            image
        ));
        assert!(!is_own_image(
            Path::new(r"C:\trove-test\report.docx"),
            image
        ));
        assert!(!is_own_image(Path::new(r"C:\trove-test\a.exe"), ""));
    }

    #[test]
    fn force_end_only_after_a_polite_close_of_that_same_program_in_the_last_two_minutes() {
        let t0 = Instant::now();
        let mut asked = Vec::new();
        assert!(
            !asked_recently(&asked, 42, 7, t0),
            "never asked: no Force end"
        );
        remember_asked(&mut asked, 42, 7, t0);
        assert!(asked_recently(&asked, 42, 7, t0 + Duration::from_secs(60)));
        assert!(
            !asked_recently(&asked, 42, 8, t0),
            "the pid reused by another program"
        );
        assert!(!asked_recently(&asked, 43, 7, t0), "another pid");
        assert!(
            !asked_recently(&asked, 42, 7, t0 + POLITE_FRESH),
            "asked too long ago"
        );
        // a later write drops what has gone stale, and asking again refreshes, not doubles
        remember_asked(&mut asked, 42, 7, t0 + Duration::from_secs(30));
        remember_asked(
            &mut asked,
            9,
            1,
            t0 + POLITE_FRESH + Duration::from_secs(31),
        );
        assert_eq!(asked.len(), 1, "{asked:?}");
    }

    #[test]
    fn end_refusals_name_why() {
        assert_eq!(
            refusal(NoEnd::Trove, "Trove"),
            "Trove itself has this file open"
        );
        assert_eq!(
            refusal(NoEnd::Terminal, "PowerShell"),
            "Trove's terminal has this file open — close it there"
        );
        assert!(refusal(NoEnd::Windows, "Explorer").contains("Windows needs Explorer"));
        assert!(refusal(NoEnd::OtherSession, "Word").contains("another Windows session"));
    }

    /// The Restart Manager sees Trove's own handle: open a file with share mode 0 (nobody else
    /// may open it), ask who holds it, and find this process — with no End task offered.
    #[cfg(windows)]
    #[test]
    fn finds_this_process_holding_a_file_with_no_sharing() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join(format!("trove-lockers-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("held.docx");
        let held = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(0)
            .open(&path)
            .unwrap();

        let err = std::fs::remove_file(&path).unwrap_err();
        assert!(is_in_use_error(&err.to_string()), "{err}");
        let found = locked(std::slice::from_ref(&path), &err.to_string());
        assert_eq!(found.len(), 1, "{found:?}");
        let me = found[0]
            .lockers
            .iter()
            .find(|l| l.pid == std::process::id())
            .unwrap_or_else(|| panic!("own pid missing from {found:?}"));
        assert!(!me.can_end, "Trove never offers to end itself");
        assert_eq!(me.no_end, Some(NoEnd::Trove));
        assert!(!me.app.is_empty());
        assert_eq!(
            end(&path, std::process::id(), false),
            Err("Trove itself has this file open".to_string()),
            "end refuses Trove itself"
        );
        assert!(end(&path, std::process::id(), true).is_err());

        drop(held);
        assert!(lockers(std::slice::from_ref(&path)).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Delete to the Recycle Bin on a held file fails with the `trash` crate's own words, not
    /// os error 32 — and the lookup still names who holds it (finding 1, review 21B).
    #[cfg(windows)]
    #[test]
    fn delete_to_the_bin_of_a_held_file_names_the_holder() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join(format!("trove-lockers-bin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("held.txt");
        let held = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(0)
            .open(&path)
            .unwrap();

        let err = crate::core::ops::trash(std::slice::from_ref(&path)).unwrap_err();
        let found = locked(std::slice::from_ref(&path), &err.to_string());
        assert!(
            found
                .iter()
                .flat_map(|f| &f.lockers)
                .any(|l| l.pid == std::process::id()),
            "{err} → {found:?}"
        );

        drop(held);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn trove_knows_its_own_session() {
        assert!(win::session_of(std::process::id()).is_some());
    }
}

//! A pseudo-console session for the terminal pane: which shell to start for a folder, the line
//! that makes a running shell follow a navigation, and the session itself over `portable-pty`
//! (ConPTY on Windows). Output is handed out as UTF-8 strings cut at character boundaries, so a
//! multibyte character split across two reads never arrives as U+FFFD.

use std::io::{Read, Write};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};

use crate::core::pty_cwd::{self, OscScanner};
use crate::core::wsl;

/// Which kind of shell a session runs; a navigation is followed only within the same kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionKind {
    Windows,
    Wsl {
        distro: String,
    },
    /// The user's own shell on macOS / Linux.
    Unix,
    /// A plain `/bin/sh` Trove opened itself to type one uninstall line into (plan 18, 4.1):
    /// no rc file, a known prompt, and it never follows a navigation (a `cd` line typed after
    /// the removal line would run with it on Enter).
    Plain,
}

/// The prompt a `Plain` session prints. The frontend types into that session only after it has
/// seen exactly this, so the line lands at a shell prompt Trove knows, not in a program an rc
/// file started (tmux, a REPL, a Y/n prompt).
pub const PLAIN_PROMPT: &str = "trove-uninstall$ ";

/// Variables an interactive `sh`/`bash` reads a start-up file from; a `Plain` session drops them.
pub const PLAIN_ENV_REMOVE: &[&str] = &["ENV", "BASH_ENV"];

/// The `Plain` shell: `/bin/sh -i` in `$HOME` (else `/`). Never `$SHELL`, whose rc may start
/// anything.
pub fn plain_shell(home: Option<String>) -> PtyCommand {
    PtyCommand {
        program: "/bin/sh".into(),
        args: vec!["-i".into()],
        cwd: home.filter(|h| !h.is_empty()).unwrap_or_else(|| "/".into()),
        kind: SessionKind::Plain,
    }
}

/// What to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub kind: SessionKind,
}

/// The shell for a folder. On Windows: `wsl.exe -d <distro> --cd <linux path>` on a WSL share,
/// else PowerShell (`pwsh.exe` when installed, `powershell.exe` otherwise) started in the
/// folder. Elsewhere: `$SHELL` (see [`unix_shell_for_with`]).
pub fn shell_for(path: &str) -> PtyCommand {
    if cfg!(windows) {
        shell_for_with(path, wsl::on_path("pwsh.exe"), user_profile())
    } else {
        unix_shell_for_with(
            path,
            std::path::Path::new(path).is_dir(),
            std::env::var("SHELL").ok(),
            std::env::var("HOME").ok(),
            std::path::Path::new("/bin/zsh").exists(),
        )
    }
}

/// The macOS / Linux shell: `$SHELL` when set and non-blank, else `/bin/zsh` on macOS when it
/// exists, else `/bin/sh`. Starts in the folder when it is a directory, else in `$HOME`
/// (else `/`).
fn unix_shell_for_with(
    path: &str,
    path_is_dir: bool,
    shell_env: Option<String>,
    home: Option<String>,
    have_zsh: bool,
) -> PtyCommand {
    let program = match shell_env.filter(|s| !s.trim().is_empty()) {
        Some(s) => s,
        None if cfg!(target_os = "macos") && have_zsh => "/bin/zsh".into(),
        None => "/bin/sh".into(),
    };
    let cwd = if path_is_dir && !path.is_empty() {
        path.to_string()
    } else {
        home.filter(|h| !h.is_empty()).unwrap_or_else(|| "/".into())
    };
    PtyCommand {
        program,
        args: Vec::new(),
        cwd,
        kind: SessionKind::Unix,
    }
}

fn shell_for_with(path: &str, have_pwsh: bool, profile: String) -> PtyCommand {
    if let Some((distro, linux)) = wsl::split_wsl_path(path) {
        return PtyCommand {
            program: "wsl.exe".into(),
            args: vec!["-d".into(), distro.clone(), "--cd".into(), linux],
            cwd: profile,
            kind: SessionKind::Wsl { distro },
        };
    }
    PtyCommand {
        program: if have_pwsh {
            "pwsh.exe"
        } else {
            "powershell.exe"
        }
        .into(),
        args: vec!["-NoLogo".into()],
        cwd: path.to_string(),
        kind: SessionKind::Windows,
    }
}

fn user_profile() -> String {
    std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into())
}

/// The line typed into a running shell of `kind` so it follows a navigation to `path`, or
/// `None` when the path belongs to another kind of shell (a WSL folder in PowerShell, a
/// Windows folder or another distro inside `wsl.exe`).
pub fn cd_command(path: &str, kind: &SessionKind) -> Option<String> {
    match (wsl::split_wsl_path(path), kind) {
        (Some((distro, linux)), SessionKind::Wsl { distro: session }) => {
            (distro.eq_ignore_ascii_case(session)).then(|| format!("cd '{}'\n", sh_quote(&linux)))
        }
        (None, SessionKind::Windows) => Some(format!(
            "Set-Location -LiteralPath '{}'\r",
            path.replace('\'', "''")
        )),
        (None, SessionKind::Unix) => Some(format!("cd '{}'\n", sh_quote(path))),
        _ => None,
    }
}

/// Why a navigation was not typed into the shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Follow {
    /// A program is running in the shell: the line would be that program's input.
    Busy,
    /// The folder belongs to another kind of shell (see `cd_command`).
    OtherShell,
}

/// The line to type so the shell follows a navigation to `path`, or why not. `busy` is asked
/// only once the line exists, because on Windows it takes a process snapshot.
pub fn follow_line(
    path: &str,
    kind: &SessionKind,
    busy: impl FnOnce() -> bool,
) -> Result<String, Follow> {
    let line = cd_command(path, kind).ok_or(Follow::OtherShell)?;
    if busy() {
        Err(Follow::Busy)
    } else {
        Ok(line)
    }
}

/// Console hosts that can sit under a shell: plumbing, not a program the user started.
const CONSOLE_HOSTS: [&str; 2] = ["conhost.exe", "OpenConsole.exe"];

/// Whether `shell` has a child process that is a real program, from `(pid, parent pid, exe
/// name)` rows. A shell at its prompt has none; `ping`, `python`, `vim` run as its children.
///
/// ⚠️ A shell's own built-ins (`Start-Sleep`, a long `Get-ChildItem`) start no child, so they
/// read as idle. And a parent pid can be stale (Windows reuses pids), which can only make a
/// shell read busy, never idle — the safe direction.
#[cfg_attr(not(windows), allow(dead_code))]
fn has_running_child<'a>(shell: u32, procs: impl IntoIterator<Item = (u32, u32, &'a str)>) -> bool {
    procs.into_iter().any(|(pid, parent, name)| {
        parent == shell
            && pid != shell
            && !CONSOLE_HOSTS.iter().any(|h| h.eq_ignore_ascii_case(name))
    })
}

/// One Toolhelp snapshot of every process, asked whether `shell` has a running child. A
/// failed snapshot reads as idle, which is how the pane behaved before this check existed.
#[cfg(windows)]
fn shell_has_child(shell: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY: plain call; INVALID_HANDLE_VALUE is checked.
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return false;
    }
    let mut rows: Vec<(u32, u32, String)> = Vec::new();
    // SAFETY: zeroed is a valid PROCESSENTRY32W; dwSize is set before the first call.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: `entry` is sized; the snapshot handle is open until CloseHandle below.
    let mut more = unsafe { Process32FirstW(snap, &mut entry) } != 0;
    while more {
        let name = &entry.szExeFile;
        let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        rows.push((
            entry.th32ProcessID,
            entry.th32ParentProcessID,
            String::from_utf16_lossy(&name[..len]),
        ));
        // SAFETY: as above.
        more = unsafe { Process32NextW(snap, &mut entry) } != 0;
    }
    // SAFETY: `snap` is a handle this function opened and closes once.
    unsafe { CloseHandle(snap) };
    has_running_child(shell, rows.iter().map(|(p, pp, n)| (*p, *pp, n.as_str())))
}

/// POSIX single-quote escaping: `'` → `'\''`.
fn sh_quote(s: &str) -> String {
    s.replace('\'', "'\\''")
}

/// Cut `buf` at the last complete UTF-8 character: the decodable head as a string, and the
/// trailing bytes of an unfinished character to prepend to the next read. Bytes that can never
/// start a valid sequence are replaced with U+FFFD rather than carried forever.
pub fn split_utf8(mut buf: Vec<u8>) -> (String, Vec<u8>) {
    match std::str::from_utf8(&buf) {
        Ok(_) => (String::from_utf8(buf).expect("checked"), Vec::new()),
        Err(e) => {
            let valid = e.valid_up_to();
            match e.error_len() {
                // an incomplete sequence at the end: keep it for the next chunk
                None if buf.len() - valid < 4 => {
                    let carry = buf.split_off(valid);
                    (String::from_utf8(buf).expect("valid prefix"), carry)
                }
                _ => (String::from_utf8_lossy(&buf).into_owned(), Vec::new()),
            }
        }
    }
}

/// One running shell in a pseudo-console.
///
/// ConPTY gives the reader no EOF while the console is open, so the reader thread ends when
/// the session (its master) is dropped — the owner drops it from `on_exit`, which a separate
/// waiter thread calls the moment the child ends. Dropping closes the console only after the
/// reader has drained what the child wrote last.
pub struct PtySession {
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Dropped last (declaration order), after the writer, so the child sees its input end.
    master: Box<dyn MasterPty + Send>,
    pub kind: SessionKind,
    /// The shell's process id, for `busy`.
    pid: Option<u32>,
}

const READ_CHUNK: usize = 64 * 1024;

impl PtySession {
    /// Start `cmd` in a `cols`×`rows` console. `on_output` gets each chunk of decoded output
    /// as it arrives; `on_exit` is called once with the exit code when the child ends. The
    /// owner should drop the session then, which ends the output stream. The app spawns through
    /// `spawn_with_cwd`; this is the tests' shorthand for a session whose folder nobody watches.
    #[cfg(test)]
    pub fn spawn(
        cmd: PtyCommand,
        cols: u16,
        rows: u16,
        on_output: impl Fn(String) + Send + 'static,
        on_exit: impl FnOnce(Option<u32>) + Send + 'static,
    ) -> std::io::Result<PtySession> {
        Self::spawn_with_cwd(cmd, cols, rows, on_output, |_| {}, on_exit)
    }

    /// `spawn`, plus `on_cwd`: called with the folder each time the shell reports a NEW one
    /// (OSC 7 / OSC 9;9, `core::pty_cwd`) that exists on this machine. The bytes still reach
    /// `on_output` unchanged. A shell that reports nothing never calls it.
    pub fn spawn_with_cwd(
        cmd: PtyCommand,
        cols: u16,
        rows: u16,
        on_output: impl Fn(String) + Send + 'static,
        on_cwd: impl Fn(String) + Send + 'static,
        on_exit: impl FnOnce(Option<u32>) + Send + 'static,
    ) -> std::io::Result<PtySession> {
        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(std::io::Error::other)?;
        let mut builder = CommandBuilder::new(&cmd.program);
        builder.args(&cmd.args);
        builder.cwd(&cmd.cwd);
        if cmd.kind == SessionKind::Plain {
            for var in PLAIN_ENV_REMOVE {
                builder.env_remove(var);
            }
            builder.env("PS1", PLAIN_PROMPT);
        }
        let mut child = pair
            .slave
            .spawn_command(builder)
            .map_err(std::io::Error::other)?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(std::io::Error::other)?;
        let writer = pair.master.take_writer().map_err(std::io::Error::other)?;
        let killer = child.clone_killer();
        let pid = child.process_id();
        let kind = cmd.kind.clone();

        std::thread::Builder::new()
            .name("pty-reader".into())
            .spawn(move || {
                let mut buf = vec![0u8; READ_CHUNK];
                let mut carry: Vec<u8> = Vec::new();
                let mut scanner = OscScanner::new();
                let local_host = pty_cwd::local_hostname();
                // a prompt reports its folder on every line; only a change is news
                let mut last_cwd: Option<String> = None;
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            for report in scanner.feed(&buf[..n]) {
                                if let Some(dir) = pty_cwd::resolve(&report, &kind, &local_host) {
                                    if last_cwd.as_deref() != Some(dir.as_str()) {
                                        last_cwd = Some(dir.clone());
                                        on_cwd(dir);
                                    }
                                }
                            }
                            carry.extend_from_slice(&buf[..n]);
                            let (text, rest) = split_utf8(std::mem::take(&mut carry));
                            carry = rest;
                            if !text.is_empty() {
                                on_output(text);
                            }
                        }
                    }
                }
                if !carry.is_empty() {
                    on_output(String::from_utf8_lossy(&carry).into_owned());
                }
            })?;

        std::thread::Builder::new()
            .name("pty-waiter".into())
            .spawn(move || {
                let code = child.wait().ok().map(|status| status.exit_code());
                on_exit(code);
            })?;

        Ok(PtySession {
            writer,
            killer,
            master: pair.master,
            kind: cmd.kind,
            pid,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> std::io::Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(std::io::Error::other)
    }

    /// Whether a program is running in the shell, so typed input would reach it instead of the
    /// prompt. Windows: the shell has a child process. Unix: the terminal's foreground process
    /// group is not the shell's. `false` when there is no way to tell.
    pub fn busy(&self) -> bool {
        let Some(pid) = self.pid else { return false };
        self.busy_os(pid)
    }

    #[cfg(windows)]
    fn busy_os(&self, pid: u32) -> bool {
        // a WSL shell's programs are Linux processes, invisible to a Windows snapshot, and
        // `wsl.exe` keeps Windows-side helpers of its own: no honest signal, so never busy
        if matches!(self.kind, SessionKind::Wsl { .. }) {
            return false;
        }
        shell_has_child(pid)
    }

    #[cfg(unix)]
    fn busy_os(&self, pid: u32) -> bool {
        self.master
            .process_group_leader()
            .is_some_and(|leader| leader as u32 != pid)
    }

    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(list: &[&str]) -> Vec<String> {
        list.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn a_windows_folder_gets_powershell_started_in_it() {
        let c = shell_for_with(r"C:\Users\alex\src", true, "C:\\Users\\alex".into());
        assert_eq!(c.program, "pwsh.exe");
        assert_eq!(c.args, s(&["-NoLogo"]));
        assert_eq!(c.cwd, r"C:\Users\alex\src");
        assert_eq!(c.kind, SessionKind::Windows);
        let c = shell_for_with(r"C:\x", false, "C:\\Users\\alex".into());
        assert_eq!(c.program, "powershell.exe");
    }

    #[test]
    fn a_wsl_folder_gets_wsl_exe_in_that_distro_and_folder() {
        let c = shell_for_with(
            r"\\wsl.localhost\Ubuntu\home\alex",
            true,
            "C:\\Users\\alex".into(),
        );
        assert_eq!(c.program, "wsl.exe");
        assert_eq!(c.args, s(&["-d", "Ubuntu", "--cd", "/home/alex"]));
        assert_eq!(c.cwd, r"C:\Users\alex");
        assert_eq!(
            c.kind,
            SessionKind::Wsl {
                distro: "Ubuntu".into()
            }
        );
    }

    #[test]
    fn cd_command_follows_within_a_kind_and_escapes_quotes() {
        assert_eq!(
            cd_command(r"C:\it's here", &SessionKind::Windows).as_deref(),
            Some("Set-Location -LiteralPath 'C:\\it''s here'\r")
        );
        let ubuntu = SessionKind::Wsl {
            distro: "Ubuntu".into(),
        };
        assert_eq!(
            cd_command(r"\\wsl.localhost\Ubuntu\home\it's", &ubuntu).as_deref(),
            Some("cd '/home/it'\\''s'\n")
        );
    }

    #[test]
    fn unix_shell_is_env_shell_then_fallback_and_starts_in_folder_or_home() {
        let home = Some("/home/alex".to_string());
        let sh = |p: &str, dir: bool, env: Option<&str>, h: Option<String>, zsh: bool| {
            unix_shell_for_with(p, dir, env.map(String::from), h, zsh)
        };
        let c = sh("/srv/x", true, Some("/usr/bin/fish"), home.clone(), true);
        assert_eq!(c.program, "/usr/bin/fish");
        assert!(c.args.is_empty());
        assert_eq!(c.cwd, "/srv/x");
        assert_eq!(c.kind, SessionKind::Unix);
        // an unusable folder falls back to HOME, and no HOME to /
        let bash = Some("/bin/bash");
        assert_eq!(
            sh("/gone", false, bash, home.clone(), true).cwd,
            "/home/alex"
        );
        assert_eq!(sh("/gone", false, bash, None, true).cwd, "/");
        // unset or blank $SHELL falls back
        let want = if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/sh"
        };
        assert_eq!(sh("/x", true, None, home.clone(), true).program, want);
        assert_eq!(sh("/x", true, Some("  "), home.clone(), true).program, want);
        assert_eq!(sh("/x", true, None, home, false).program, "/bin/sh");
    }

    #[test]
    fn unix_cd_command_is_posix_quoted() {
        let u = SessionKind::Unix;
        assert_eq!(cd_command("/a b/c", &u).as_deref(), Some("cd '/a b/c'\n"));
        assert_eq!(cd_command("/it's", &u).as_deref(), Some("cd '/it'\\''s'\n"));
        assert_eq!(
            cd_command("/日本 語/é", &u).as_deref(),
            Some("cd '/日本 語/é'\n")
        );
        assert_eq!(
            cd_command("/$x `y` \"z\"", &u).as_deref(),
            Some("cd '/$x `y` \"z\"'\n")
        );
        assert_eq!(cd_command(r"\\wsl.localhost\Ubuntu\home", &u), None);
    }

    #[test]
    fn cd_command_is_none_across_kinds() {
        let ubuntu = SessionKind::Wsl {
            distro: "Ubuntu".into(),
        };
        assert_eq!(cd_command(r"C:\x", &ubuntu), None);
        assert_eq!(
            cd_command(r"\\wsl.localhost\Ubuntu\home", &SessionKind::Windows),
            None
        );
        assert_eq!(cd_command(r"\\wsl.localhost\Debian\home", &ubuntu), None);
    }

    #[test]
    fn split_utf8_carries_an_unfinished_character() {
        // "é" is C3 A9; "€" is E2 82 AC
        let (text, carry) = split_utf8(vec![b'a', 0xC3]);
        assert_eq!(text, "a");
        assert_eq!(carry, vec![0xC3]);
        let (text, carry) = split_utf8(vec![0xC3, 0xA9, 0xE2, 0x82]);
        assert_eq!(text, "é");
        assert_eq!(carry, vec![0xE2, 0x82]);
        let (text, carry) = split_utf8(vec![0xE2, 0x82, 0xAC]);
        assert_eq!(text, "€");
        assert!(carry.is_empty());
        // a byte that can never start a sequence is replaced, not carried
        let (text, carry) = split_utf8(vec![b'x', 0xFF, b'y']);
        assert_eq!(text, "x\u{FFFD}y");
        assert!(carry.is_empty());
    }

    #[test]
    fn plain_shell_is_bin_sh_with_no_rc_and_never_follows() {
        let c = plain_shell(Some("/home/ana".into()));
        assert_eq!(c.program, "/bin/sh");
        assert_eq!(c.args, s(&["-i"]));
        assert_eq!(c.cwd, "/home/ana");
        assert_eq!(c.kind, SessionKind::Plain);
        assert_eq!(plain_shell(None).cwd, "/");
        assert_eq!(plain_shell(Some(String::new())).cwd, "/");
        // a navigation never types a `cd` into it
        assert_eq!(cd_command("/tmp", &SessionKind::Plain), None);
        assert!(PLAIN_PROMPT.ends_with("$ ") && !PLAIN_PROMPT.contains('\n'));
    }

    /// The real thing: a plain session's first prompt is `PLAIN_PROMPT`, even with `ENV`
    /// pointing at a start-up file that would print something else.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn a_plain_session_prints_the_known_prompt() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let dir = std::env::temp_dir().join(format!("trove-plain-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("rc.sh");
        std::fs::write(&rc, "echo RC-RAN\nPS1='hijacked> '\n").unwrap();
        // what a person's environment might carry; the session must not inherit it
        std::env::set_var("ENV", &rc);
        let (tx, rx) = mpsc::channel::<String>();
        let mut session = PtySession::spawn(
            plain_shell(Some(dir.to_string_lossy().into_owned())),
            80,
            24,
            move |chunk| {
                let _ = tx.send(chunk);
            },
            |_| {},
        )
        .expect("spawn /bin/sh");
        std::env::remove_var("ENV");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut all = String::new();
        while Instant::now() < deadline && !all.contains(PLAIN_PROMPT) {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(50)) {
                all.push_str(&chunk);
            }
        }
        session.kill();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(all.contains(PLAIN_PROMPT), "output was {all:?}");
        assert!(
            !all.contains("RC-RAN") && !all.contains("hijacked"),
            "{all:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_session_runs_a_command_and_reports_its_exit() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let (out_tx, out_rx) = mpsc::channel::<String>();
        let (exit_tx, exit_rx) = mpsc::channel::<Option<u32>>();
        let cmd = PtyCommand {
            program: "cmd.exe".into(),
            args: s(&["/c", "echo hi"]),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            kind: SessionKind::Windows,
        };
        let mut session = PtySession::spawn(
            cmd,
            80,
            24,
            move |chunk| {
                let _ = out_tx.send(chunk);
            },
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("ConPTY spawn");
        // ConPTY asks the terminal where the cursor is (DSR, `ESC[6n`) and waits for the
        // answer before it runs anything; the terminal emulator answers in the app, we do here.
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut all = String::new();
        let mut code = None;
        while Instant::now() < deadline {
            if let Ok(chunk) = out_rx.recv_timeout(Duration::from_millis(50)) {
                if chunk.contains("\x1b[6n") {
                    session.write(b"\x1b[1;1R").expect("reply to DSR");
                }
                all.push_str(&chunk);
            }
            if let Ok(c) = exit_rx.try_recv() {
                code = Some(c);
                break;
            }
        }
        assert_eq!(code, Some(Some(0)), "no clean exit; output was {all:?}");
        // as the owner does on exit: dropping the session ends the output stream
        drop(session);
        while !all.contains("hi") {
            match out_rx.recv_timeout(Duration::from_secs(3)) {
                Ok(chunk) => all.push_str(&chunk),
                Err(_) => break,
            }
        }
        assert!(all.contains("hi"), "output was {all:?}");
    }

    #[test]
    fn follow_types_the_line_only_into_an_idle_shell_of_the_same_kind() {
        let win = SessionKind::Windows;
        assert_eq!(
            follow_line(r"C:\x", &win, || false),
            Ok("Set-Location -LiteralPath 'C:\\x'\r".to_string())
        );
        // a program is running: its input is not the shell's, so nothing is typed
        assert_eq!(follow_line(r"C:\x", &win, || true), Err(Follow::Busy));
        // another kind of shell: refused before the (costly) busy check is even asked
        let asked = std::cell::Cell::new(false);
        let r = follow_line(r"\\wsl.localhost\Ubuntu\home\alex", &win, || {
            asked.set(true);
            true
        });
        assert_eq!(r, Err(Follow::OtherShell));
        assert!(!asked.get());
    }

    #[test]
    fn a_shell_is_busy_while_it_has_a_child_process_other_than_a_console_host() {
        let shell = 100;
        let idle = [
            (4, 0, "System"),
            (100, 50, "pwsh.exe"),
            (200, 7, "ping.exe"),
        ];
        assert!(!has_running_child(
            shell,
            idle.iter().map(|&(p, pp, n)| (p, pp, n))
        ));
        let busy = [(100, 50, "pwsh.exe"), (300, 100, "python.exe")];
        assert!(has_running_child(
            shell,
            busy.iter().map(|&(p, pp, n)| (p, pp, n))
        ));
        let host = [
            (100, 50, "pwsh.exe"),
            (301, 100, "conhost.exe"),
            (302, 100, "OpenConsole.exe"),
        ];
        assert!(!has_running_child(
            shell,
            host.iter().map(|&(p, pp, n)| (p, pp, n))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn a_live_shell_reads_busy_while_a_program_runs_and_idle_after() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let (out_tx, out_rx) = mpsc::channel::<String>();
        let cmd = PtyCommand {
            program: "cmd.exe".into(),
            args: s(&["/q", "/k"]),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            kind: SessionKind::Windows,
        };
        let mut session = PtySession::spawn(
            cmd,
            80,
            24,
            move |chunk| {
                let _ = out_tx.send(chunk);
            },
            |_| {},
        )
        .expect("ConPTY spawn");
        // pump output (answering the DSR) until `until` holds or the deadline passes
        let mut all = String::new();
        let mut pump = |session: &mut PtySession, until: &dyn Fn(&str, &PtySession) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(8);
            while Instant::now() < deadline {
                if let Ok(chunk) = out_rx.recv_timeout(Duration::from_millis(50)) {
                    if chunk.contains("\x1b[6n") {
                        session.write(b"\x1b[1;1R").expect("reply to DSR");
                    }
                    all.push_str(&chunk);
                }
                if until(&all, session) {
                    return true;
                }
            }
            false
        };
        assert!(pump(&mut session, &|out, _| out.contains('>')), "no prompt");
        assert!(!session.busy(), "an idle cmd.exe read as busy");
        // about 3 s of ping: long enough to be seen running, short enough to wait out
        session
            .write(b"ping -n 4 127.0.0.1\r")
            .expect("type a command");
        assert!(
            pump(&mut session, &|_, s| s.busy()),
            "ping never showed as busy"
        );
        assert!(
            pump(&mut session, &|_, s| !s.busy()),
            "still busy after ping ended"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_live_unix_shell_reads_busy_while_a_program_runs_and_idle_after() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let (out_tx, out_rx) = mpsc::channel::<String>();
        let cmd = PtyCommand {
            // -i: an interactive shell does job control, as the user's own shell does
            program: "/bin/bash".into(),
            args: s(&["--norc", "--noprofile", "-i"]),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            kind: SessionKind::Unix,
        };
        let mut session = PtySession::spawn(
            cmd,
            80,
            24,
            move |chunk| {
                let _ = out_tx.send(chunk);
            },
            |_| {},
        )
        .expect("pty spawn");
        let mut all = String::new();
        let mut pump = |session: &mut PtySession, until: &dyn Fn(&str, &PtySession) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(8);
            while Instant::now() < deadline {
                if let Ok(chunk) = out_rx.recv_timeout(Duration::from_millis(50)) {
                    all.push_str(&chunk);
                }
                if until(&all, session) {
                    return true;
                }
            }
            false
        };
        assert!(pump(&mut session, &|out, _| out.contains('$')), "no prompt");
        assert!(!session.busy(), "an idle bash read as busy");
        session.write(b"sleep 3\n").expect("type a command");
        assert!(
            pump(&mut session, &|_, s| s.busy()),
            "sleep never showed as busy"
        );
        assert!(
            pump(&mut session, &|_, s| !s.busy()),
            "still busy after sleep ended"
        );
    }

    /// Plan 08 E1, the real check: a bash whose prompt emits OSC 7 (set by THIS harness through
    /// its own rc file — the app never sets `PROMPT_COMMAND`) reports each `cd`, the folder
    /// arrives on `on_cwd`, a folder that does not exist is never reported, and the escape
    /// itself still reaches `on_output` unchanged.
    #[cfg(unix)]
    #[test]
    fn a_shell_that_emits_osc7_reports_each_cd() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let root = std::env::temp_dir().join(format!("trove-osc7-{}", std::process::id()));
        let into = root.join("dir with space");
        std::fs::create_dir_all(&into).unwrap();
        let root = root.canonicalize().unwrap();
        let into = into.canonicalize().unwrap();
        let rc = root.join("rc.bash");
        // the URI must percent-encode the space; this is what VTE's `__vte_urlencode` does too
        std::fs::write(
            &rc,
            "PROMPT_COMMAND='printf \"\\033]7;file://%s%s\\033\\\\\" \"$HOSTNAME\" \"${PWD// /%20}\"'\n",
        )
        .unwrap();
        let (out_tx, out_rx) = mpsc::channel::<String>();
        let (cwd_tx, cwd_rx) = mpsc::channel::<String>();
        let cmd = PtyCommand {
            program: "/bin/bash".into(),
            args: vec![
                "--noprofile".into(),
                "--rcfile".into(),
                rc.to_string_lossy().into_owned(),
                "-i".into(),
            ],
            cwd: root.to_string_lossy().into_owned(),
            kind: SessionKind::Unix,
        };
        let mut session = PtySession::spawn_with_cwd(
            cmd,
            80,
            24,
            move |chunk| {
                let _ = out_tx.send(chunk);
            },
            move |dir| {
                let _ = cwd_tx.send(dir);
            },
            |_| {},
        )
        .expect("spawn bash");
        let wait_cwd = |want: &str| {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut seen = Vec::new();
            while Instant::now() < deadline {
                if let Ok(dir) = cwd_rx.recv_timeout(Duration::from_millis(50)) {
                    if dir == want {
                        return seen;
                    }
                    seen.push(dir);
                }
            }
            panic!("never saw {want:?}; saw {seen:?}");
        };
        let root_s = root.to_string_lossy().into_owned();
        let into_s = into.to_string_lossy().into_owned();
        // the first prompt reports the start folder
        wait_cwd(&root_s);
        session
            .write(format!("cd '{}'\n", sh_quote(&into_s)).as_bytes())
            .unwrap();
        wait_cwd(&into_s);
        // a prompt that does not move (plain Enter) is not news
        session.write(b"\n").unwrap();
        // a cd that fails leaves the shell where it was: nothing new is reported
        session.write(b"cd /no/such/trove/dir\n").unwrap();
        session.write(b"cd ..\n").unwrap();
        let between = wait_cwd(&root_s);
        assert!(between.is_empty(), "unexpected reports {between:?}");
        session.kill();
        let all: String = out_rx.try_iter().collect();
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            all.contains("\x1b]7;file://"),
            "the escape must reach the emulator unchanged: {all:?}"
        );
    }
}

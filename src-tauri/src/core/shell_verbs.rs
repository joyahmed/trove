//! The verbs Windows' own installers put on the context menu — "Open with Code", "Open Git
//! Bash here", "Add to archive…" — read from `Software\Classes\<class>\shell\*` in both hives
//! and offered on our menus with the same wording. Read-only: nothing here writes a key.
//!
//! A verb's `command` is Explorer's template (`"C:\…\Code.exe" "%V"`); `command_line` turns it
//! into a program and arguments for one path.

use std::path::Path;

use serde::Serialize;

use crate::core::known_apps;
use crate::core::registry::{self, Hive, DEFAULT_VALUE};

/// Which class a verb was registered on — Explorer shows each on a different target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VerbScope {
    /// `Directory` — a folder row
    Directory,
    /// `Directory\Background` — the empty space of an open folder
    DirectoryBackground,
    /// `*` — any file
    File,
    /// `Drive` — a drive root
    Drive,
}

impl VerbScope {
    pub const ALL: [VerbScope; 4] = [
        VerbScope::Directory,
        VerbScope::DirectoryBackground,
        VerbScope::File,
        VerbScope::Drive,
    ];

    /// The registry class the scope lives under.
    pub fn class(self) -> &'static str {
        match self {
            VerbScope::Directory => "Directory",
            VerbScope::DirectoryBackground => "Directory\\Background",
            VerbScope::File => "*",
            VerbScope::Drive => "Drive",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellVerb {
    /// the subkey name, e.g. `VSCode`
    pub key: String,
    /// what the menu shows, `&` accelerators stripped
    pub label: String,
    /// Explorer's command template, `%1` / `%V` and friends unexpanded
    pub command: String,
    /// the `Icon` value (`path,index`) when the verb has one
    pub icon: Option<String>,
    pub scope: VerbScope,
}

/// A raw verb key as read: the values the rules below look at.
#[derive(Debug, Default, Clone)]
pub struct RawVerb {
    pub key: String,
    pub default: Option<String>,
    pub mui_verb: Option<String>,
    pub icon: Option<String>,
    pub command: Option<String>,
    pub legacy_disable: bool,
    pub programmatic_only: bool,
    pub extended: bool,
}

/// Explorer's own rules for whether a verb key is a menu entry, and what it says.
pub fn verb_from(raw: RawVerb, scope: VerbScope, include_extended: bool) -> Option<ShellVerb> {
    let command = raw.command.filter(|c| !c.trim().is_empty())?;
    if raw.legacy_disable || raw.programmatic_only || (raw.extended && !include_extended) {
        return None;
    }
    // MUIVerb wins over (default); an `@dll,-id` resource is resolved through the shell, and
    // when that fails the key name is the honest fallback.
    let label = [raw.mui_verb, raw.default]
        .into_iter()
        .flatten()
        .filter(|l| !l.trim().is_empty())
        .find_map(|l| {
            if l.starts_with('@') {
                load_indirect_string(&l)
            } else {
                Some(l)
            }
        })
        .unwrap_or_else(|| raw.key.clone());
    Some(ShellVerb {
        key: raw.key,
        label: strip_accelerator(&label),
        command,
        icon: raw.icon.filter(|i| !i.trim().is_empty()),
        scope,
    })
}

/// `@C:\…\x.dll,-1002` → the localized string the resource holds (`SHLoadIndirectString`).
#[cfg(windows)]
pub fn load_indirect_string(resource: &str) -> Option<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::SHLoadIndirectString;
    let source: Vec<u16> = OsStr::new(resource)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut buf = [0u16; 512];
    // SAFETY: `source` is NUL-terminated; `buf` has `buf.len()` units for the result; the
    // reserved pointer must be null.
    let hr = unsafe {
        SHLoadIndirectString(
            source.as_ptr(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            std::ptr::null_mut(),
        )
    };
    if hr != 0 {
        return None;
    }
    let len = buf.iter().position(|&u| u == 0).unwrap_or(buf.len());
    let s = String::from_utf16_lossy(&buf[..len]);
    (!s.trim().is_empty()).then_some(s)
}

#[cfg(not(windows))]
pub fn load_indirect_string(_resource: &str) -> Option<String> {
    None
}

/// `Open with &Code` → `Open with Code`; a doubled `&&` is a literal ampersand.
pub fn strip_accelerator(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut chars = label.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                out.push('&');
                chars.next();
            }
            continue;
        }
        out.push(c);
    }
    out.trim().to_string()
}

/// Read one class's verbs under `hive\<root>Software\Classes\<class>\shell`. `root` is `""`
/// for the real hive; tests pass their throw-away key so nothing real is read or written.
pub fn read_verbs(
    hive: Hive,
    root: &str,
    scope: VerbScope,
    include_extended: bool,
) -> Vec<ShellVerb> {
    let shell = format!("{}Software\\Classes\\{}\\shell", root, scope.class());
    let keys = registry::subkeys_in(hive, &shell).unwrap_or_default();
    keys.into_iter()
        .filter_map(|key| {
            let path = format!("{shell}\\{key}");
            let sz = |name: &str| registry::read_sz_in(hive, &path, name).ok().flatten();
            let raw = RawVerb {
                default: sz(DEFAULT_VALUE),
                mui_verb: sz("MUIVerb"),
                icon: sz("Icon"),
                command: registry::read_sz_in(hive, &format!("{path}\\command"), DEFAULT_VALUE)
                    .ok()
                    .flatten(),
                legacy_disable: value_present(hive, &path, "LegacyDisable"),
                programmatic_only: value_present(hive, &path, "ProgrammaticAccessOnly"),
                extended: value_present(hive, &path, "Extended"),
                key,
            };
            verb_from(raw, scope, include_extended)
        })
        .collect()
}

/// The flag values are empty `REG_SZ`s in practice; their presence is the signal.
fn value_present(hive: Hive, path: &str, name: &str) -> bool {
    registry::read_sz_in(hive, path, name)
        .ok()
        .flatten()
        .is_some()
}

/// HKCU over HKLM, per scope: a verb already listed by key — or by label, since an installer
/// that registered itself in both hives under different key names is still one entry — is
/// not repeated.
pub fn merge(user: Vec<ShellVerb>, machine: Vec<ShellVerb>) -> Vec<ShellVerb> {
    let mut out: Vec<ShellVerb> = Vec::new();
    for v in user.into_iter().chain(machine) {
        let taken = out.iter().any(|u| {
            u.scope == v.scope
                && (u.key.eq_ignore_ascii_case(&v.key) || u.label.eq_ignore_ascii_case(&v.label))
        });
        if !taken {
            out.push(v);
        }
    }
    out
}

/// Every verb on this machine, the four classes, HKCU winning over HKLM.
pub fn all_verbs() -> Vec<ShellVerb> {
    let mut out = Vec::new();
    for scope in VerbScope::ALL {
        let user = read_verbs(Hive::CurrentUser, "", scope, false);
        let machine = read_verbs(Hive::LocalMachine, "", scope, false);
        out.extend(merge(user, machine));
    }
    out
}

/// Explorer's template → the program and its arguments for `path`: `%1` `%V` `%L` `%d` are the
/// path, `%W` its parent, `%*` and `%2`… are dropped, `%VAR%` comes from the environment.
pub fn command_line(template: &str, path: &str) -> Option<(String, Vec<String>)> {
    let parent = Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let expanded = expand_env(template)
        .replace("%1", path)
        .replace("%V", path)
        .replace("%v", path)
        .replace("%L", path)
        .replace("%l", path)
        .replace("%d", path)
        .replace("%W", &parent)
        .replace("%w", &parent);
    let mut parts = split_args(&expanded);
    parts.retain(|a| !is_positional(a));
    if parts.is_empty() {
        return None;
    }
    let program = parts.remove(0);
    Some((program, parts))
}

/// `%2`…`%9` and `%*` after expansion: the extra selected items Explorer would pass.
fn is_positional(arg: &str) -> bool {
    arg == "%*" || (arg.len() == 2 && arg.starts_with('%') && arg.as_bytes()[1].is_ascii_digit())
}

/// `%ProgramFiles%\x` → the variable's value; unknown names are left as they are.
pub fn expand_env(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end)
                if end > 0
                    && after[..end]
                        .chars()
                        .all(|c| c.is_alphanumeric() || c == '_') =>
            {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A command line into arguments, double quotes grouping, as `CommandLineToArgvW` does for the
/// simple cases (no backslash-escaping of quotes — Explorer templates never use it).
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut had_token = false;
    for c in s.chars() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                had_token = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if had_token {
                    out.push(std::mem::take(&mut cur));
                    had_token = false;
                }
            }
            c => {
                cur.push(c);
                had_token = true;
            }
        }
    }
    if had_token {
        out.push(cur);
    }
    out
}

/// Run a verb's command for `path` from the folder that holds it; detached, no console.
pub fn run(template: &str, path: &str) -> std::io::Result<()> {
    let (program, args) = command_line(template, path)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "an empty command"))?;
    let cwd = cwd_for(path);
    let mut cmd = std::process::Command::new(program);
    cmd.args(args).current_dir(cwd);
    cmd.spawn().map(drop)
}

/// A user command: program + already-expanded arguments, from `cwd`.
///
/// ⛔ The program is **resolved first**, and that one line is the whole of the "the shipped
/// default command never ran" bug: `Command::new` is `CreateProcess`, which appends only `.exe`
/// to a bare name, and VS Code ships no `code.exe`. See `known_apps::resolve_program` for the
/// ladder and why the fix is not `program: "code.cmd"`.
///
/// ⚠️ Do **not** add a `cmd /c` wrapper for a `.cmd`/`.bat` that comes out of the resolver —
/// measured here, `Command::new(r"…\x.cmd").spawn()` returns `Ok` and the script runs. Since the
/// BatBadBut fix (CVE-2024-24576) std recognises those extensions itself and quotes the arguments
/// for cmd.exe's parser, which a hand-rolled `cmd.exe /c <file> <args…>` would undo — an argument
/// holding `&` or `%` would then be interpreted rather than passed. The `live_tests` module keeps
/// that measurement honest.
/// ⛔ A console program started from a GUI process gets **no console** unless it is asked for,
/// and a shell with no console is a process nobody can see or type into. `open_terminal`
/// (`core/wsl.rs`) has always passed `CREATE_NEW_CONSOLE` for `cmd.exe` and `wsl.exe`; nothing on
/// the custom-command path ever did, so `cmd /K`, `pwsh` or bare `wsl` offered as a menu entry
/// started invisibly and stayed that way. This is the predicate `run_custom` uses.
///
/// ⚠️ **It is a second copy of a decision `wsl.rs` also makes, and that is on purpose — with a
/// tripwire.** The other copy is not a function but the third element of `wsl::terminal_command`'s
/// tuple, so it cannot be called from here without reshaping that module. Rather than mirror it
/// silently, `the_console_rule_agrees_with_the_terminal_path` asserts the two agree for every
/// program `terminal_command` can return; change one and the build says so.
///
/// It matches on the program **name**, not on the PE subsystem header, because the names that
/// matter most reach us as zero-byte App Execution Aliases (`pwsh.exe`, `wsl.exe` in
/// `WindowsApps`) and as `.cmd` scripts, neither of which has a subsystem to read. The list is
/// shells only: a `.cmd` helper someone wired up to run quietly should keep running quietly.
#[cfg_attr(not(windows), allow(dead_code))] // only the Windows spawn path asks; tests cover the rule on every OS
pub fn needs_console(program: &str) -> bool {
    let stem = Path::new(program)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        stem.as_str(),
        "cmd" | "wsl" | "pwsh" | "powershell" | "bash" | "sh" | "zsh" | "fish" | "busybox"
    )
}

pub fn run_custom(program: &str, args: &[String], cwd: &str) -> std::io::Result<()> {
    let resolved = known_apps::resolve_program(program);
    let mut cmd = std::process::Command::new(&resolved);
    cmd.args(args);
    if !cwd.is_empty() && Path::new(cwd).is_dir() {
        cmd.current_dir(cwd);
    }
    // ⚠️ Decided on the **resolved** program: `wsl` arrives bare from the catalogue and comes back
    // as `…\WindowsApps\wsl.exe`, and the stem is what either spelling has in common.
    #[cfg(windows)]
    if needs_console(&resolved) {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NEW_CONSOLE);
    }
    // stderr goes to a temp file, not a pipe: a program that outlives the wait below keeps its end
    // open, where a dropped pipe would break it on its next write.
    let err_path = std::env::temp_dir().join(format!(
        "trove-cmd-{}-{}.err",
        std::process::id(),
        ERR_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    if let Ok(f) = std::fs::File::create(&err_path) {
        cmd.stderr(f);
    }
    let result = spawn_and_watch(&mut cmd, &err_path, QUICK_EXIT_WAIT);
    let _ = std::fs::remove_file(&err_path);
    result
}

static ERR_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// How long a started command is watched for an immediate failure (bad arguments).
const QUICK_EXIT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// Spawn, then poll up to `wait`. A non-zero exit inside the window is an `Err` carrying the exit
/// code and the first ~300 chars of stderr; still running, or exited 0, is `Ok`. Blocks the calling
/// thread for at most `wait` (the Tauri command is `async`, so that is a pool thread).
fn spawn_and_watch(
    cmd: &mut std::process::Command,
    err_path: &Path,
    wait: std::time::Duration,
) -> std::io::Result<()> {
    let mut child = cmd.spawn()?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait()? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => {
                let text = std::fs::read(err_path).unwrap_or_default();
                let text = String::from_utf8_lossy(&text);
                let text: String = text.trim().chars().take(300).collect();
                let code = status
                    .code()
                    .map_or_else(|| "a signal".to_string(), |c| c.to_string());
                let msg = if text.is_empty() {
                    format!("exited with code {code}")
                } else {
                    format!("exited with code {code}: {text}")
                };
                return Err(std::io::Error::other(msg));
            }
            None if start.elapsed() >= wait => return Ok(()),
            None => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
}

/// The folder a command starts in: the path itself for a folder, else its parent.
fn cwd_for(path: &str) -> String {
    let p = Path::new(path);
    if p.is_dir() {
        path.to_string()
    } else {
        p.parent()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn raw(key: &str, command: &str) -> RawVerb {
        RawVerb {
            key: key.to_string(),
            command: Some(command.to_string()),
            ..RawVerb::default()
        }
    }

    /// An absolute path in the platform's own form (`C:` on Windows, `/a/b` elsewhere).
    fn abs(parts: &[&str]) -> String {
        let mut p = PathBuf::from(if cfg!(windows) { r"C:\" } else { "/" });
        p.extend(parts);
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn a_quoted_exe_and_percent_one_become_program_and_one_argument() {
        let (program, args) =
            command_line(r#""C:\Program Files\Code\Code.exe" "%1""#, r"C:\a b\c.txt").unwrap();
        assert_eq!(program, r"C:\Program Files\Code\Code.exe");
        assert_eq!(args, vec![r"C:\a b\c.txt".to_string()]);
    }

    #[test]
    fn percent_v_and_w_expand_and_positionals_drop() {
        // A native path: `parent()` splits on the platform's separator, as the real item paths do.
        let sub = abs(&["dir", "sub"]);
        let (_, args) = command_line(r#"x.exe "%V" --cwd "%W" %2 %*"#, &sub).unwrap();
        assert_eq!(args, vec![sub, "--cwd".into(), abs(&["dir"])]);
    }

    #[test]
    fn environment_variables_expand_and_unknown_ones_stay() {
        std::env::set_var("EXPLORER_TAURI_TEST_DIR", r"C:\tools");
        assert_eq!(
            expand_env(r"%EXPLORER_TAURI_TEST_DIR%\bin\x.exe %1"),
            r"C:\tools\bin\x.exe %1"
        );
        assert_eq!(
            expand_env("%NOT_A_REAL_VAR_42% 50%"),
            "%NOT_A_REAL_VAR_42% 50%"
        );
    }

    #[test]
    fn mui_verb_from_a_dll_falls_back_to_the_key_and_accelerators_are_stripped() {
        let mut r = raw("VSCode", "code.exe %1");
        r.mui_verb = Some("@no-such-dll-anywhere.dll,-8506".into());
        assert_eq!(
            verb_from(r, VerbScope::File, false).unwrap().label,
            "VSCode"
        );
        let mut r = raw("git_shell", "bash.exe");
        r.default = Some("Open Git &Bash here".into());
        assert_eq!(
            verb_from(r, VerbScope::Directory, false).unwrap().label,
            "Open Git Bash here"
        );
        assert_eq!(strip_accelerator("Fish && Chips"), "Fish & Chips");
    }

    #[test]
    fn disabled_hidden_extended_and_commandless_verbs_are_not_entries() {
        let mut r = raw("a", "a.exe");
        r.legacy_disable = true;
        assert!(verb_from(r, VerbScope::File, false).is_none());
        let mut r = raw("b", "b.exe");
        r.programmatic_only = true;
        assert!(verb_from(r, VerbScope::File, false).is_none());
        let mut r = raw("c", "c.exe");
        r.extended = true;
        assert!(verb_from(r.clone(), VerbScope::File, false).is_none());
        assert!(verb_from(r, VerbScope::File, true).is_some());
        let r = RawVerb {
            key: "d".into(),
            ..RawVerb::default()
        };
        assert!(verb_from(r, VerbScope::File, false).is_none());
    }

    #[test]
    fn merge_prefers_the_user_hive_by_key() {
        let mk = |key: &str, label: &str| ShellVerb {
            key: key.into(),
            label: label.into(),
            command: "x".into(),
            icon: None,
            scope: VerbScope::File,
        };
        let merged = merge(
            vec![mk("VSCode", "user")],
            vec![mk("vscode", "machine"), mk("Zed", "zed"), mk("Zed2", "ZED")],
        );
        assert_eq!(
            merged.iter().map(|v| v.label.as_str()).collect::<Vec<_>>(),
            ["user", "zed"]
        );
    }

    /// A path stays a path, and an unknown bare name stays as typed so the OS error reaches the
    /// toast rather than a guess.
    #[test]
    fn resolve_program_leaves_paths_and_unknown_names_alone() {
        let full = r"C:\Users\x\AppData\Local\Programs\Microsoft VS Code\Code.exe";
        assert_eq!(known_apps::resolve_program(full), full);
        assert_eq!(known_apps::resolve_program("bin/tool"), "bin/tool");
        assert_eq!(
            known_apps::resolve_program("no-such-program-anywhere-42"),
            "no-such-program-anywhere-42"
        );
        assert_eq!(known_apps::resolve_program(""), "");
    }

    /// ⛔ The shipped default command. `code` has no `.exe` on this planet, so the resolver must
    /// hand back something that exists — otherwise `Command::new` fails before Code ever sees an
    /// argument. Skipped where VS Code is not installed; asserted hard where it is.
    #[test]
    fn a_bare_code_resolves_to_a_real_file_when_vs_code_is_installed() {
        let resolved = known_apps::resolve_program("code");
        if resolved == "code" {
            eprintln!("VS Code not installed on this machine; nothing to resolve");
            return;
        }
        println!("code -> {resolved}");
        assert!(
            Path::new(&resolved).is_file(),
            "{resolved} is not a file, so CreateProcess cannot start it"
        );
        // And what it resolved to must be something the loader (or std's batch handling) accepts.
        let ext = Path::new(&resolved)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        assert!(
            ["exe", "com", "cmd", "bat"].contains(&ext.as_str()),
            "{resolved} is not something CreateProcess can start"
        );
    }

    /// ⛔ The tripwire for the copy this module keeps of `wsl.rs`'s console decision. Every
    /// program `terminal_command` can return, with the answer it gives for it: if the two ever
    /// disagree, one of the two paths is opening a window the other is not.
    #[test]
    fn the_console_rule_agrees_with_the_terminal_path() {
        use crate::core::wsl::terminal_command;
        for (path, have_wt) in [
            (r"C:\some\dir", false),
            (r"C:\some\dir", true),
            (r"\\wsl.localhost\Ubuntu\home\alex", false),
            (r"\\wsl.localhost\Ubuntu\home\alex", true),
        ] {
            let (program, _, wants_console) = terminal_command(path, have_wt);
            assert_eq!(
                needs_console(&program),
                wants_console,
                "{program} (wt: {have_wt}) is a console program on one path and not the other"
            );
        }
    }

    /// The custom-command path offers these four, and three of them are console programs. A
    /// resolved full path has to answer the same as the bare name it came from.
    #[test]
    fn the_shells_we_offer_get_a_console_and_the_windowed_apps_do_not() {
        let wsl_alias = abs(&[
            "Users",
            "x",
            "AppData",
            "Local",
            "Microsoft",
            "WindowsApps",
            "wsl.exe",
        ]);
        let git_bash = abs(&["Program Files", "Git", "usr", "bin", "bash.exe"]);
        for console in ["cmd.exe", "wsl", "pwsh.exe", &wsl_alias, &git_bash] {
            assert!(needs_console(console), "{console} would start invisibly");
        }
        // git-bash.exe is a windowed launcher for mintty, and the rest are plain GUI apps; a
        // console for any of them is a black rectangle nobody asked for.
        let windowed_apps = [
            "wt.exe".to_string(),
            abs(&["Program Files", "Git", "git-bash.exe"]),
            abs(&["Program Files", "Microsoft VS Code", "Code.exe"]),
            abs(&["x", "zed.exe"]),
            String::new(),
        ];
        for windowed in &windowed_apps {
            assert!(
                !needs_console(windowed),
                "{windowed} would sprout a console"
            );
        }
        // ⚠️ A `.cmd` a person wired up themselves keeps running quietly, as it does today.
        assert!(!needs_console(&abs(&["tools", "nightly-backup.cmd"])));
    }

    #[test]
    fn split_args_groups_quotes() {
        assert_eq!(split_args(r#"a "b c" d"#), vec!["a", "b c", "d"]);
        assert_eq!(split_args(r#""" x"#), vec!["", "x"]);
    }

    /// `run_custom` of a one-line script through the platform shell.
    fn run_script(script: &str) -> std::io::Result<()> {
        let flag = if cfg!(windows) { "/C" } else { "-c" };
        let shell = if cfg!(windows) { "cmd" } else { "sh" };
        run_custom(shell, &[flag.to_string(), script.to_string()], "")
    }

    #[test]
    fn a_command_that_exits_nonzero_at_once_is_an_error_with_code_and_stderr() {
        let script = if cfg!(windows) {
            "echo bad-args-here 1>&2 & exit 3"
        } else {
            "echo bad-args-here 1>&2; exit 3"
        };
        let err = run_script(script).expect_err("exit 3 must be reported");
        let msg = err.to_string();
        assert!(msg.contains("code 3"), "{msg}");
        assert!(msg.contains("bad-args-here"), "{msg}");
    }

    #[test]
    fn a_command_that_keeps_running_is_ok_after_about_two_seconds() {
        let script = if cfg!(windows) {
            "ping -n 6 127.0.0.1 >nul"
        } else {
            "sleep 5"
        };
        let start = std::time::Instant::now();
        run_script(script).expect("still running is fine");
        let took = start.elapsed();
        assert!(took >= std::time::Duration::from_millis(1900), "{took:?}");
        assert!(took < std::time::Duration::from_millis(4000), "{took:?}");
    }

    #[test]
    fn a_command_that_exits_zero_is_ok() {
        run_script("exit 0").expect("exit 0 is fine");
    }
}

/// Tests that actually start a process, to measure what `CreateProcess` does rather than repeat
/// folklore about it.
#[cfg(all(test, windows))]
mod live_tests {
    use super::*;

    /// ⛔ The bug, isolated: a real `.cmd` on `PATH` is invisible to a **bare-name** spawn (only
    /// `.exe` is appended — this is why `program: "code"` never ran), yet the very same file
    /// spawns fine once it has a path. So resolution is the fix and a `cmd /c` wrapper is not:
    /// std recognises `.cmd`/`.bat` itself and quotes their arguments for cmd.exe's parser
    /// (CVE-2024-24576), which wrapping by hand would undo.
    #[test]
    fn a_bare_name_cannot_reach_a_cmd_but_a_resolved_path_runs_it() {
        let dir = std::env::temp_dir().join(format!("trove-batch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("trove-probe.cmd");
        let marker = dir.join("ran.txt");
        std::fs::write(&script, "@echo ran > \"%~dp0ran.txt\"\r\n").unwrap();
        let _ = std::fs::remove_file(&marker);

        // With the script's own folder as the whole of the child's PATH: the bare stem is still
        // not found, because only `trove-probe.exe` is ever tried…
        let bare = std::process::Command::new("trove-probe")
            .env("PATH", &dir)
            .current_dir(&dir)
            .spawn();
        assert!(
            bare.is_err(),
            "a bare name reached a .cmd — then `program: \"code\"` would have worked all along"
        );
        // …while spelling the extension out finds it on the same PATH. The only difference is the
        // extension, which is the whole of the bug.
        let named = std::process::Command::new("trove-probe.cmd")
            .env("PATH", &dir)
            .current_dir(&dir)
            .spawn();
        assert!(named.is_ok(), "positive control failed: {named:?}");
        let _ = std::fs::remove_file(&marker);

        // The same file with a path, through `run_custom`: it runs, side effect on disk.
        run_custom(&script.to_string_lossy(), &[], &dir.to_string_lossy()).unwrap();
        let mut waited = 0;
        while !marker.is_file() && waited < 100 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            waited += 1;
        }
        assert!(marker.is_file(), "the batch file never ran");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(all(test, windows))]
mod registry_live_tests {
    use super::*;
    use crate::core::registry::{delete_key_if_empty, delete_tree, write_sz};

    struct Scratch(
        String,
        #[allow(dead_code)] std::sync::MutexGuard<'static, ()>,
    );
    impl Scratch {
        fn new() -> Scratch {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            Scratch(
                format!(
                    "Software\\trove-test\\verbs-{}-{nanos}\\",
                    std::process::id()
                ),
                crate::core::registry::tests::scratch_lock(),
            )
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = delete_tree(self.0.trim_end_matches('\\'));
            let _ = delete_key_if_empty("Software\\trove-test");
        }
    }

    #[test]
    fn reads_two_verbs_and_skips_the_disabled_one() {
        let s = Scratch::new();
        let shell = format!("{}Software\\Classes\\Directory\\shell", s.0);
        write_sz(
            &format!("{shell}\\VSCode"),
            DEFAULT_VALUE,
            "Open with &Code",
        )
        .unwrap();
        write_sz(&format!("{shell}\\VSCode"), "Icon", r"C:\code.exe,0").unwrap();
        write_sz(
            &format!("{shell}\\VSCode\\command"),
            DEFAULT_VALUE,
            r#""C:\code.exe" "%V""#,
        )
        .unwrap();
        write_sz(&format!("{shell}\\Old"), DEFAULT_VALUE, "Old thing").unwrap();
        write_sz(&format!("{shell}\\Old"), "LegacyDisable", "").unwrap();
        write_sz(&format!("{shell}\\Old\\command"), DEFAULT_VALUE, "old.exe").unwrap();
        write_sz(&format!("{shell}\\NoCommand"), DEFAULT_VALUE, "Nothing").unwrap();

        let verbs = read_verbs(Hive::CurrentUser, &s.0, VerbScope::Directory, false);
        assert_eq!(verbs.len(), 1, "{verbs:?}");
        assert_eq!(verbs[0].key, "VSCode");
        assert_eq!(verbs[0].label, "Open with Code");
        assert_eq!(verbs[0].icon.as_deref(), Some(r"C:\code.exe,0"));
        assert_eq!(verbs[0].scope, VerbScope::Directory);
    }

    #[test]
    fn the_real_hives_read_without_panicking() {
        let verbs = all_verbs();
        for scope in VerbScope::ALL {
            let labels: Vec<&str> = verbs
                .iter()
                .filter(|v| v.scope == scope)
                .map(|v| v.label.as_str())
                .collect();
            println!("{scope:?}: {labels:?}");
        }
        assert!(verbs.iter().all(|v| !v.command.is_empty()));
    }
}

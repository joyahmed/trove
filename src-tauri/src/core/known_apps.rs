//! Common context-menu entries, detected rather than hand-typed.
//!
//! The Customize dialog is three empty text boxes plus a legend of `%path%`-style tokens the
//! person is expected to read and retype, with no feedback until the command fails silently at
//! first use. This module finds what is actually installed and offers a ready-made entry per app,
//! so the common cases are one click.
//!
//! ⚠️ **The strategies are not equally trustworthy, and the caller is told which was used.**
//!   - `App Paths` is a *fact*: an installer wrote the full exe path there. (Code, VLC)
//!   - a Start-menu `.lnk` target is nearly a fact, but the display name is the publisher's.
//!   - PATH is a fact about this session's environment, not about the install.
//!   - a well-known install directory is a *guess* that happens to be right most of the time. (Zed)
//!   - whether an editor exists **inside** a WSL distro is not knowable from Windows at all — the
//!     registry has no record of a Linux filesystem — and ⛔ nothing here asks the distro either,
//!     because asking means booting it. Such an entry rides on the distro merely *existing* in
//!     `Lxss`, and is marked `certain: false` for the part nobody checked.
//!
//! ⛔ Nothing here writes a setting. `detect()` only reports what it found; adding an entry stays
//! the person's click, in the dialog. A file manager that silently grows context-menu items
//! because it noticed an installer is a file manager nobody trusts.

use std::path::{Path, PathBuf};

use crate::core::{registry, spotlight, wsl};

/// Where a program was found. Serialised to the frontend so the dialog can say so plainly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    /// `App Paths` — an installer registered the exe. The strongest signal Windows offers.
    AppPaths,
    /// A `.lnk` in either Start-menu tree, resolved to its target.
    StartMenu,
    /// Found on `PATH`.
    Path,
    /// A documented default install directory, probed with `is_file()`.
    KnownDir,
    /// A distro exists, and the entry needs something **inside** it that Windows cannot see.
    ///
    /// ⛔ Nothing is executed in any distro, despite the name. `detect()` reads the `Lxss`
    /// registry key (`wsl::distros()`) and starts no VM: the grade means "Windows can see the
    /// distro, and cannot see what is installed in it", which is why every entry carrying it is
    /// `certain: false`. The variant keeps its name because `wsl-probe` is the wire value the
    /// dialog matches on (`DetectSource`, `types/shell-verbs.ts`) and the wording it shows —
    /// "needs the Remote-WSL extension inside your distro" — is about that unseen half. A real
    /// probe (`wsl -d <name> -- which code`) boots the distro, so it belongs on a click, never on
    /// dialog-open; until one is written this variant claims only what the registry said.
    WslProbe,
    /// Linux: the app's `.desktop` file in an XDG `applications/` folder, its `Exec` program
    /// checked on disk. What the app menu shows, so as good a fact as `App Paths` is on Windows.
    #[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
    DesktopEntry,
}

/// One ready-made context-menu entry, shaped to drop straight into `CustomCommand`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedApp {
    /// Stable across runs, so the dialog can tell "already added" from "new".
    pub id: String,
    pub label: String,
    pub program: String,
    pub args: String,
    pub scope: Vec<String>,
    pub source: Source,
    /// `false` when the detection is a heuristic the person should sanity-check.
    pub certain: bool,
}

const APP_PATHS: &str = r"Software\Microsoft\Windows\CurrentVersion\App Paths";

/// The full path an installer registered for `exe`.
///
/// HKCU is tried before HKLM on purpose: a per-user install is the copy this person actually
/// launches, and when both exist the per-user one is newer more often than not.
///
/// ⚠️ The value is verified with `is_file()` before it is returned. An uninstall frequently
/// leaves the key behind, so a bare registry read would hand back a path to nothing.
pub fn app_path(exe: &str) -> Option<String> {
    let sub = format!(r"{APP_PATHS}\{exe}");
    for hive in [registry::Hive::CurrentUser, registry::Hive::LocalMachine] {
        if let Ok(Some(raw)) = registry::read_sz_in(hive, &sub, registry::DEFAULT_VALUE) {
            let path = raw.trim().trim_matches('"').to_string();
            if !path.is_empty() && Path::new(&path).is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// The first of `candidates` that exists, expanded against the environment.
///
/// `%LOCALAPPDATA%\Zed\zed.exe` style — each candidate is a documented default location, not a
/// search. Probing the whole disk for an exe is how a file manager earns a reputation for
/// hanging on startup.
fn known_dir(candidates: &[(&str, &str)]) -> Option<String> {
    for (var, tail) in candidates {
        let Some(base) = std::env::var_os(var) else {
            continue;
        };
        let full = PathBuf::from(base).join(tail);
        if full.is_file() {
            return Some(full.to_string_lossy().into_owned());
        }
    }
    None
}

/// A Start-menu shortcut whose display name contains `needle`, resolved to its target exe.
///
/// Case-insensitive because publishers are inconsistent ("Visual Studio Code", "VLC media
/// player"). `apps` is passed in rather than read here so one Start-menu walk serves every
/// candidate — the walk is the expensive part.
fn start_menu(apps: &[spotlight::AppEntry], needle: &str) -> Option<String> {
    let needle = needle.trim().to_ascii_lowercase();
    // ⚠️ `contains("")` is true of every name, so an app with no Start-menu name to look for
    // would otherwise be "found" as whichever shortcut the walk happened to list first.
    if needle.is_empty() {
        return None;
    }
    apps.iter()
        .find(|a| {
            a.name.to_ascii_lowercase().contains(&needle)
                && !a.target.is_empty()
                && Path::new(&a.target).is_file()
        })
        .map(|a| a.target.clone())
}

/// Try each strategy in descending order of how much it actually proves.
fn resolve(
    exe: &str,
    start_menu_name: &str,
    dirs: &[(&str, &str)],
    apps: &[spotlight::AppEntry],
) -> Option<(String, Source)> {
    if let Some(p) = app_path(exe) {
        return Some((p, Source::AppPaths));
    }
    if let Some(p) = start_menu(apps, start_menu_name) {
        return Some((p, Source::StartMenu));
    }
    if let Some(p) = known_dir(dirs) {
        return Some((p, Source::KnownDir));
    }
    if wsl::on_path(exe) {
        // PATH search order decided it; keep the bare name so it keeps working if the
        // install moves.
        return Some((exe.to_string(), Source::Path));
    }
    None
}

/// `resolve()` with the first two rungs swapped, for apps that ship as an MSIX package.
///
/// ⚠️ **The strongest source hands back the least durable value for a Store app.** Read on this
/// machine, `App Paths\wt.exe` is
/// `C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.24.11911.0_x64__8wekyb3d8bbwe\wt.exe`
/// — the package *version* is in the path, so a saved command breaks at the next Terminal update.
/// The same is true of `pwsh.exe` and `wsl.exe`. Each of the three also has an App Execution Alias
/// of the plain name in `%LOCALAPPDATA%\Microsoft\WindowsApps`, which is on `PATH` by default and
/// does not move; `Command::new` starts one happily, and `resolve_program` re-resolves the bare
/// name at every launch rather than at detection time. So for exactly these, `PATH` is asked
/// first and the bare name is what gets saved.
fn resolve_packaged(
    exe: &str,
    start_menu_name: &str,
    dirs: &[(&str, &str)],
    apps: &[spotlight::AppEntry],
) -> Option<(String, Source)> {
    if wsl::on_path(exe) {
        return Some((exe.to_string(), Source::Path));
    }
    resolve(exe, start_menu_name, dirs, apps)
}

/// The extensions worth appending to a bare name: what `PATHEXT` holds, minus the ones that need
/// an interpreter we would have to pick (`.vbs`, `.ps1`, `.msc`, …). `.exe` leads rather than
/// following `PATHEXT`'s own `.COM;.EXE;.BAT;.CMD`, because when an app ships both — VS Code does
/// not, but many do — the exe is the one to launch from a GUI. CreateProcess tries `.exe` alone.
const EXEC_EXTS: [&str; 4] = ["exe", "com", "cmd", "bat"];

/// The first match for `program` on `PATH`, extensions included.
///
/// Per-directory then per-extension, as `cmd.exe` searches: every spelling in one directory before
/// moving to the next, so a `code.cmd` early on `PATH` beats a `code.exe` later on it.
fn on_path_with_ext(program: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    let named = Path::new(program).extension().is_some();
    for dir in std::env::split_paths(&path) {
        if named {
            let full = dir.join(program);
            if full.is_file() {
                return Some(full.to_string_lossy().into_owned());
            }
            continue;
        }
        for ext in EXEC_EXTS {
            let full = dir.join(format!("{program}.{ext}"));
            if full.is_file() {
                return Some(full.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// A user command's `program` → the file to actually hand to `CreateProcess`.
///
/// ⛔ Why this is needed at all: `Command::new` is `CreateProcess`, and CreateProcess appends
/// **only** `.exe` to a bare name — no `PATHEXT`, no `App Paths`. VS Code ships no `code.exe`
/// anywhere: `bin\code` is a POSIX script and `bin\code.cmd` is the Windows wrapper. So the
/// shipped default command (`program: "code"`) failed with "The system cannot find the file
/// specified" every single time it was clicked, and the same trap catches every bare name a
/// person types into the Customize dialog.
///
/// ⭐ So a bare name walks the ladder `resolve()` already uses for the detected catalogue rather
/// than hardcoding `code.cmd`: `App Paths` first — an installer's own record of the real exe, and
/// for Code that is `Code.exe`, which accepts the same `--remote`/folder arguments the `.cmd`
/// wrapper forwards — then `PATH` with the extensions cmd.exe would have tried. A `.cmd`/`.bat`
/// found that way needs no wrapper of ours: measured in `shell_verbs::live_tests`, std spawns one
/// by path quite happily, and does its own cmd.exe-safe argument quoting while it is at it.
///
/// ⚠️ A program with a separator in it is a path the person (or the detector) already chose, and
/// is returned untouched. So is a bare name nothing knows about: spawning it and letting the OS
/// error reach the toast is more honest than guessing.
pub fn resolve_program(program: &str) -> String {
    let trimmed = program.trim();
    if trimmed.is_empty() || trimmed.contains('\\') || trimmed.contains('/') {
        return program.to_string();
    }
    // `App Paths` keys are file names with the extension; a bare name means the exe.
    let key = if Path::new(trimmed).extension().is_some() {
        trimmed.to_string()
    } else {
        format!("{trimmed}.exe")
    };
    if let Some(p) = app_path(&key) {
        return p;
    }
    on_path_with_ext(trimmed).unwrap_or_else(|| program.to_string())
}

fn app(
    id: &str,
    label: &str,
    program: &str,
    args: &str,
    scope: &[&str],
    source: Source,
    certain: bool,
) -> DetectedApp {
    DetectedApp {
        id: id.to_string(),
        label: label.to_string(),
        program: program.to_string(),
        args: args.to_string(),
        scope: scope.iter().map(|s| s.to_string()).collect(),
        source,
        certain,
    }
}

/// What the machine turned out to have. Filled by `detect()`, consumed by `catalogue()`.
///
/// ⭐ A struct rather than a row of positional `Option`s: the list only grows, and the fourth
/// `None, None, None, None` in a test says nothing about which app is missing.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Probed {
    pub code: Option<(String, Source)>,
    pub zed: Option<(String, Source)>,
    pub vlc: Option<(String, Source)>,
    /// Windows Terminal (`wt.exe`).
    pub terminal: Option<(String, Source)>,
    /// PowerShell 7 (`pwsh.exe`) — not Windows PowerShell 5, which is a different program.
    pub pwsh: Option<(String, Source)>,
    pub git_bash: Option<(String, Source)>,
    /// `wsl.exe` itself, the fallback host for a distro shell when Terminal is absent.
    pub wsl: Option<(String, Source)>,
    pub cmd: Option<(String, Source)>,
    /// Every installed distro, the default first. ⚠️ A **registry** fact (`Lxss`) and nothing
    /// more: no distro was started, and nothing is known about what is inside one.
    pub distros: Vec<String>,
}

/// `Ubuntu-26.04` → `ubuntu-26-04`, for an id that stays the same across runs.
fn slug(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    s.trim_matches('-').to_string()
}

/// A distro name as one argument: `openSUSE Leap 15.6` has spaces, and the argument line is
/// split by the shell rules the expander applies (`utils/custom-commands.ts`).
fn as_arg(name: &str) -> String {
    if name.chars().any(char::is_whitespace) {
        format!("\"{name}\"")
    } else {
        name.to_string()
    }
}

/// What to run a distro shell *in*, and what has to come before `-d`.
///
/// ⭐ The same pair `wsl::terminal_command` picks between for the toolbar button: Windows
/// Terminal gets its own window and takes the whole `wsl …` line as the command to run, while
/// bare `wsl.exe` is a console program and needs a console of its own — which is what
/// `shell_verbs::needs_console` gives it on the custom-command path.
fn wsl_host(p: &Probed) -> Option<(&str, Source, &'static [&'static str])> {
    if let Some((program, source)) = &p.terminal {
        return Some((program, *source, &["wsl"]));
    }
    if let Some((program, source)) = &p.wsl {
        return Some((program, *source, &[]));
    }
    None
}

/// Everything worth offering, given what is installed.
///
/// Pure: the probing happens in `detect()` and is handed in, so the catalogue's shape — labels,
/// tokens, scopes — is testable without a registry or a WSL install.
pub fn catalogue(p: &Probed) -> Vec<DetectedApp> {
    let mut out = Vec::new();

    if let Some((program, source)) = p.code.clone() {
        out.push(app(
            "vscode",
            "Open with Code",
            &program,
            "%path%",
            &["file", "folder", "background"],
            source,
            true,
        ));
        // ⚠️ Offered only when a distro exists, and never `certain`: Windows knows the distro is
        // installed, but nothing on this side knows whether Code's Remote-WSL extension is set up
        // inside it. `%distro%` fills itself from the clicked path at run time.
        if !p.distros.is_empty() {
            out.push(app(
                "vscode-wsl",
                "Open with Code (WSL)",
                &program,
                "--remote wsl+%distro% %linuxpath%",
                &["wsl"],
                Source::WslProbe,
                false,
            ));
        }
    }

    if let Some((program, source)) = p.zed.clone() {
        out.push(app(
            "zed",
            "Open with Zed",
            &program,
            "%path%",
            &["file", "folder", "background"],
            source,
            // Zed has no App Paths entry from most installers; anything softer than that is a
            // guess worth flagging.
            source == Source::AppPaths,
        ));
        // ⭐ `--wsl`, not `--remote wsl+…`. Code's spelling is Code's; Zed grew its own, and this
        // entry waited until the installed binary was asked rather than guessed at:
        // `Zed.exe --help` documents `--wsl <USER@DISTRO>` ("The username is optional, and if not
        // specified, the default user for the distribution will be used"), and the shell script
        // Zed itself ships at `bin/zed` runs `zed.exe --wsl "$USER@$WSL_DISTRO_NAME" "$@"` with
        // Linux paths. `%distro%` alone is therefore the right filling: Trove knows the distro
        // from the clicked path and does **not** know the Linux user, and Zed's own default is
        // the one to use. The same binary rejects `--remote` outright.
        //
        // ⚠️ Never `certain`, for the same reason as `vscode-wsl` and not a different one: Zed
        // provisions a remote server *inside* the distro the first time it opens one, and nothing
        // on the Windows side can see whether that has happened or can happen. The registry knows
        // a distro exists; that is the whole of the claim.
        if !p.distros.is_empty() {
            out.push(app(
                "zed-wsl",
                "Open with Zed (WSL)",
                &program,
                "--wsl %distro% %linuxpath%",
                &["wsl"],
                Source::WslProbe,
                false,
            ));
        }
    }

    if let Some((program, source)) = p.vlc.clone() {
        out.push(app(
            "vlc",
            "Play with VLC",
            &program,
            "%paths%",
            // Folders too: VLC treats a directory as a playlist, which is the point.
            &["file", "folder"],
            source,
            true,
        ));
    }

    if let Some((program, source)) = p.terminal.clone() {
        out.push(app(
            "terminal-here",
            "Open in Windows Terminal",
            &program,
            // ⚠️ `%path%`, not `%parent%`. `wt -d` takes the folder to open, and the token is
            // already the folder the menu was opened on — the clicked row for `folder`, the open
            // folder for `background`. `%parent%` therefore opened the folder ABOVE it: a
            // right-click on `D:\proj` landed you in `D:\`.
            "-d %path%",
            &["folder", "background"],
            source,
            true,
        ));
    }

    // ⭐ The working-directory flag is different for every terminal, and this is the one place
    // that knows all of them: `wt -d <dir>`, `pwsh -WorkingDirectory <dir>`, `git-bash --cd=<dir>`,
    // `cmd /K cd /d <dir>`. A second copy is how the `-d %parent%` bug survived its own fix.
    if let Some((program, source)) = p.pwsh.clone() {
        out.push(app(
            "pwsh-here",
            "Open in PowerShell",
            &program,
            // `-NoExit` so the shell stays after the profile runs; without it pwsh would open and
            // close again. `-WorkingDirectory` is PowerShell 7's own flag — 5.1 has no such thing,
            // which is the other reason this entry is `pwsh` and never `powershell`.
            "-NoExit -WorkingDirectory %path%",
            &["folder", "background"],
            source,
            true,
        ));
    }

    if let Some((program, source)) = p.git_bash.clone() {
        out.push(app(
            "git-bash-here",
            "Open Git Bash here",
            &program,
            // `--cd=<dir>`, one argument with an `=`: git-bash.exe does not take `--cd <dir>`.
            "--cd=%path%",
            &["folder", "background"],
            source,
            // Git ships no `App Paths` key, so this is the Start-menu shortcut's target or a
            // guess at `Program Files\Git` — worth a glance either way.
            source == Source::AppPaths,
        ));
    }

    if let Some((program, source)) = p.cmd.clone() {
        out.push(app(
            "cmd-here",
            "Open Command Prompt here",
            &program,
            "/K cd /d %path%",
            &["folder", "background"],
            source,
            // `%SystemRoot%\System32\cmd.exe` is where cmd.exe is, not where it usually is.
            true,
        ));
    }

    // ⚠️ Two different jobs, not two copies of one command.
    //
    // `wsl-shell` is scoped to `wsl` and spells the distro with `%distro%`, which the expander
    // fills from the **clicked path** — so one entry serves every distro, including ones
    // installed after this ran. It is the only one that can use `%linuxpath%`, because a
    // `%linuxpath%` built from `C:\Users\alex` is `C:/Users/alex`, which is not a path in any distro.
    //
    // `wsl-shell-<distro>` is scoped to Windows folders and names one distro outright: the
    // clicked path says nothing about which distro to use, so the entry has to. `wsl --cd` takes
    // an absolute Windows path and translates it, which is what makes this pair work at all.
    if let Some((host, source, prefix)) = wsl_host(p) {
        if !p.distros.is_empty() {
            let line = |distro: &str, cd: &str| {
                let mut parts: Vec<String> = prefix.iter().map(|s| s.to_string()).collect();
                parts.extend([
                    "-d".to_string(),
                    distro.to_string(),
                    "--cd".into(),
                    cd.into(),
                ]);
                parts.join(" ")
            };
            out.push(app(
                "wsl-shell",
                "Open a shell here (WSL)",
                host,
                &line("%distro%", "%linuxpath%"),
                &["wsl"],
                source,
                true,
            ));
            let mut used: Vec<String> = Vec::new();
            for (i, distro) in p.distros.iter().enumerate() {
                let stem = slug(distro);
                let mut id = format!("wsl-shell-{stem}");
                if stem.is_empty() || used.contains(&id) {
                    id = format!("wsl-shell-{i}");
                }
                used.push(id.clone());
                out.push(app(
                    &id,
                    &format!("Open {distro} here"),
                    host,
                    &line(&as_arg(distro), "%path%"),
                    &["folder", "background"],
                    source,
                    // The distro is in the registry and the host was found on disk. Nothing here
                    // claims anything about what is installed *inside* the distro — a login shell
                    // is what `wsl -d` starts by definition — so this is not a `WslProbe` entry.
                    true,
                ));
            }
        }
    }

    out
}

/// `%LOCALAPPDATA%\Programs\Zed\Zed.exe` is where Zed's own installer puts it.
///
/// ⛔ This list read `Zed\zed.exe` — no `Programs\` — from the day it was written, so the
/// known-directory rung never fired for Zed and the entry only ever appeared because the
/// Start-menu shortcut answered first. A Zed install without a shortcut was invisible.
const ZED_DIRS: [(&str, &str); 3] = [
    ("LOCALAPPDATA", r"Programs\Zed\Zed.exe"),
    ("ProgramFiles", r"Zed\Zed.exe"),
    ("ProgramFiles(x86)", r"Zed\Zed.exe"),
];

/// Git for Windows: machine-wide, 32-bit machine-wide, then the per-user install.
const GIT_BASH_DIRS: [(&str, &str); 3] = [
    ("ProgramFiles", r"Git\git-bash.exe"),
    ("ProgramFiles(x86)", r"Git\git-bash.exe"),
    ("LOCALAPPDATA", r"Programs\Git\git-bash.exe"),
];

/// Probe the machine, then build the catalogue.
///
/// One Start-menu walk is shared by every candidate. Called from a `#[tauri::command(async)]`,
/// never on the main thread: it reads the registry, the Start menu and the disk.
pub fn detect() -> Vec<DetectedApp> {
    // ⛔ Linux has none of the Windows rungs below (no registry, no Start menu, no `Code.exe`),
    // so every probe missed and the found-apps strip was empty even with `code` on PATH.
    if let Some(found) = linux_detect_env() {
        return found;
    }
    // ⛔ Same on macOS: no registry, no Start menu, no `Code.exe`, so the strip was always empty.
    if let Some(found) = mac_detect_env() {
        return found;
    }
    // the Start menu itself, not `app_roots()` — that is `/Applications` or the XDG dirs off
    // Windows, and a `.lnk` walk there would recurse through every bundle for nothing
    let apps = spotlight::apps_in(&spotlight::start_menu_roots());

    let code = resolve(
        "Code.exe",
        "Visual Studio Code",
        &[
            ("LOCALAPPDATA", r"Programs\Microsoft VS Code\Code.exe"),
            ("ProgramFiles", r"Microsoft VS Code\Code.exe"),
        ],
        &apps,
    );
    let zed = resolve("Zed.exe", "Zed", &ZED_DIRS, &apps);
    let vlc = resolve(
        "vlc.exe",
        "VLC media player",
        &[
            ("ProgramFiles", r"VideoLAN\VLC\vlc.exe"),
            ("ProgramFiles(x86)", r"VideoLAN\VLC\vlc.exe"),
        ],
        &apps,
    );
    // ⚠️ Terminal, PowerShell 7 and WSL are MSIX packages; see `resolve_packaged` for why their
    // `App Paths` value is the answer that rots. "PowerShell 7" as the Start-menu name and not
    // "PowerShell": the latter also matches "Windows PowerShell", which is 5.1 — a different
    // program that has no `-WorkingDirectory`.
    let terminal = resolve_packaged("wt.exe", "Terminal", &[], &apps);
    let pwsh = resolve_packaged("pwsh.exe", "PowerShell 7", &[], &apps);
    let wsl_exe = resolve_packaged("wsl.exe", "", &[("SystemRoot", r"System32\wsl.exe")], &apps);
    let git_bash = resolve("git-bash.exe", "Git Bash", &GIT_BASH_DIRS, &apps);
    // cmd.exe has no `App Paths` key and no shortcut worth matching. `PATH` first for the same
    // reason as the packaged three — the bare name is the durable spelling — with
    // `%SystemRoot%\System32` behind it for a PATH somebody has edited down.
    let cmd = resolve_packaged("cmd.exe", "", &[("SystemRoot", r"System32\cmd.exe")], &apps);

    // ⚠️ Every distro, not just the default one: a per-distro entry has to name its distro, and
    // `wsl::distros()` already returns the default first. This is a registry read — see
    // `Source::WslProbe` for what that does and does not prove.
    let distros: Vec<String> = wsl::distros().into_iter().map(|d| d.name).collect();

    catalogue(&Probed {
        code,
        zed,
        vlc,
        terminal,
        pwsh,
        git_bash,
        wsl: wsl_exe,
        cmd,
        distros,
    })
}

/// One app the Linux and Mac catalogues know: the names it goes by on `PATH`, the desktop ids its
/// packages install (deb/rpm, Flatpak, Snap), and the entry it becomes.
#[cfg(any(unix, test))]
#[allow(dead_code)]
struct KnownApp {
    id: &'static str,
    label: &'static str,
    commands: &'static [&'static str],
    /// Empty for terminals: their `Exec` opens a window, not a folder, so only a `PATH` hit
    /// says which flag to give them.
    desktop_ids: &'static [&'static str],
    /// macOS: the `.app` folder names, looked for in the Applications folders. Empty for the
    /// terminals — a Mac terminal takes its folder some other way, and nothing here knows how.
    bundles: &'static [&'static str],
    args: &'static str,
    scope: &'static [&'static str],
}

/// The apps worth one click on Linux and Mac. Ids shared with Windows (`vscode`, `zed`, `vlc`,
/// `pwsh-here`) are the same app, so a settings file synced across machines stays "added".
#[cfg(any(unix, test))]
const KNOWN_APPS: &[KnownApp] = &[
    KnownApp {
        id: "vscode",
        label: "Open with Code",
        commands: &["code"],
        desktop_ids: &[
            "code.desktop",
            "com.microsoft.VSCode.desktop",
            "com.visualstudio.code.desktop",
            "code_code.desktop",
        ],
        bundles: &["Visual Studio Code.app"],
        args: "%path%",
        scope: &["file", "folder", "background"],
    },
    KnownApp {
        id: "vscodium",
        label: "Open with VSCodium",
        commands: &["codium"],
        desktop_ids: &[
            "codium.desktop",
            "com.vscodium.codium.desktop",
            "codium_codium.desktop",
        ],
        bundles: &["VSCodium.app"],
        args: "%path%",
        scope: &["file", "folder", "background"],
    },
    KnownApp {
        id: "zed",
        label: "Open with Zed",
        // `zeditor` is the Arch and Fedora package's name for the same binary
        commands: &["zed", "zeditor"],
        desktop_ids: &["dev.zed.Zed.desktop", "zed.desktop"],
        bundles: &["Zed.app"],
        args: "%path%",
        scope: &["file", "folder", "background"],
    },
    KnownApp {
        id: "sublime",
        label: "Open with Sublime Text",
        commands: &["subl"],
        desktop_ids: &["sublime_text.desktop", "com.sublimetext.three.desktop"],
        bundles: &["Sublime Text.app"],
        args: "%path%",
        scope: &["file", "folder", "background"],
    },
    KnownApp {
        id: "gnome-text-editor",
        label: "Open with Text Editor",
        commands: &["gnome-text-editor"],
        desktop_ids: &["org.gnome.TextEditor.desktop"],
        bundles: &[],
        args: "%paths%",
        scope: &["file"],
    },
    KnownApp {
        id: "gedit",
        label: "Open with gedit",
        commands: &["gedit"],
        desktop_ids: &["org.gnome.gedit.desktop", "gedit.desktop"],
        bundles: &[],
        args: "%paths%",
        scope: &["file"],
    },
    KnownApp {
        id: "kate",
        label: "Open with Kate",
        commands: &["kate"],
        desktop_ids: &["org.kde.kate.desktop"],
        bundles: &[],
        args: "%paths%",
        scope: &["file"],
    },
    KnownApp {
        id: "vlc",
        label: "Play with VLC",
        commands: &["vlc"],
        desktop_ids: &["vlc.desktop", "org.videolan.VLC.desktop", "vlc_vlc.desktop"],
        bundles: &["VLC.app"],
        args: "%paths%",
        scope: &["file", "folder"],
    },
    KnownApp {
        id: "gnome-terminal-here",
        label: "Open in Terminal",
        commands: &["gnome-terminal"],
        desktop_ids: &[],
        bundles: &[],
        args: "--working-directory=%path%",
        scope: &["folder", "background"],
    },
    KnownApp {
        id: "ptyxis-here",
        label: "Open in Ptyxis",
        commands: &["ptyxis"],
        desktop_ids: &[],
        bundles: &[],
        args: "--new-window --working-directory=%path%",
        scope: &["folder", "background"],
    },
    KnownApp {
        id: "konsole-here",
        label: "Open in Konsole",
        commands: &["konsole"],
        desktop_ids: &[],
        bundles: &[],
        args: "--workdir %path%",
        scope: &["folder", "background"],
    },
    KnownApp {
        id: "xfce4-terminal-here",
        label: "Open in Xfce Terminal",
        commands: &["xfce4-terminal"],
        desktop_ids: &[],
        bundles: &[],
        args: "--working-directory=%path%",
        scope: &["folder", "background"],
    },
    KnownApp {
        id: "pwsh-here",
        label: "Open in PowerShell",
        commands: &["pwsh"],
        desktop_ids: &[],
        bundles: &[],
        args: "-NoExit -WorkingDirectory %path%",
        scope: &["folder", "background"],
    },
];

/// `(program, args)` from the first of `ids` installed in `dirs`' `applications/` folders.
///
/// Per id, the first dir that has the file decides, as the menu does: a `Hidden=true` copy in
/// `~/.local/share` hides the system one. The `Exec` program must exist (`find_on_path`, which
/// only looks). A plain launcher (`/usr/share/code/code %F`) keeps the catalogue's own argument
/// line; a wrapper with arguments of its own (`flatpak run … com.visualstudio.code @@u %U @@`)
/// keeps the `Exec` line, file token and all, because dropping its words breaks the launch.
#[cfg(any(all(unix, not(target_os = "macos")), test))]
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
fn desktop_command(
    ids: &[&str],
    dirs: &[PathBuf],
    path_var: Option<&std::ffi::OsStr>,
    args: &str,
) -> Option<(String, String)> {
    use crate::core::apps_linux::{exec_argv, exec_to_open_with, find_on_path, parse_desktop};
    for id in ids {
        let Some(file) = dirs
            .iter()
            .map(|d| d.join("applications").join(id))
            .find(|f| f.is_file())
        else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&file) else {
            continue;
        };
        let Some(entry) = parse_desktop(&String::from_utf8_lossy(&bytes), "") else {
            continue;
        };
        if entry.kind != "Application" || entry.hidden || entry.terminal {
            continue;
        }
        if let Some(t) = &entry.try_exec {
            if find_on_path(t, path_var).is_none() {
                continue;
            }
        }
        let Some(exec) = entry.exec.as_deref() else {
            continue;
        };
        let Some(open) = exec_to_open_with(exec, true) else {
            continue;
        };
        if find_on_path(&open.program, path_var).is_none() {
            continue;
        }
        let own_words = exec_argv(exec).map_or(0, |w| w.len().saturating_sub(1));
        let args = if own_words == 0 {
            args.to_string()
        } else {
            open.args
        };
        return Some((open.program, args));
    }
    None
}

/// Everything worth offering on Linux, from `dirs` (the XDG data dirs) and `path_var`.
///
/// `PATH` first, saving the bare name: it is what the person would type and it survives an
/// update moving the binary. The `.desktop` file second, for an app with no command on `PATH`
/// (a Flatpak). Read-only: files are looked at, nothing is started.
#[cfg(any(all(unix, not(target_os = "macos")), test))]
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
fn linux_catalogue(dirs: &[PathBuf], path_var: Option<&std::ffi::OsStr>) -> Vec<DetectedApp> {
    use crate::core::apps_linux::find_on_path;
    KNOWN_APPS
        .iter()
        .filter_map(|a| {
            let found = a
                .commands
                .iter()
                .find(|c| find_on_path(c, path_var).is_some())
                .map(|c| (c.to_string(), a.args.to_string(), Source::Path))
                .or_else(|| {
                    desktop_command(a.desktop_ids, dirs, path_var, a.args)
                        .map(|(p, args)| (p, args, Source::DesktopEntry))
                })?;
            let (program, args, source) = found;
            Some(app(a.id, a.label, &program, &args, a.scope, source, true))
        })
        .collect()
}

/// Linux's catalogue from this process's environment; `None` everywhere else.
#[cfg(all(unix, not(target_os = "macos")))]
fn linux_detect_env() -> Option<Vec<DetectedApp>> {
    Some(linux_catalogue(
        &crate::core::apps_linux::env_data_dirs(),
        std::env::var_os("PATH").as_deref(),
    ))
}

/// Everything worth offering on macOS: the known apps' `.app` bundles inside `roots`.
///
/// ⭐ Only the bundle names in `KNOWN_APPS`, looked for with `is_dir()` directly under each root
/// (`/Applications`, `~/Applications`, `/System/Applications`) — no folder is walked. The launch
/// form is the one a picked app gets (`apps_mac::read_bundle`): `open` + `-a "<bundle>"`, with the
/// catalogue's own file token after it. The first root that has a bundle decides.
#[cfg(any(target_os = "macos", test))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_catalogue(roots: &[PathBuf]) -> Vec<DetectedApp> {
    KNOWN_APPS
        .iter()
        .filter_map(|a| {
            let bundle = a
                .bundles
                .iter()
                .find_map(|b| roots.iter().map(|r| r.join(b)).find(|p| p.is_dir()))?;
            // a `"` in the path is legal on macOS; `splitArgs` reads `\"` back as a quote
            let quoted = bundle.to_string_lossy().replace('"', "\\\"");
            let args = format!("-a \"{quoted}\" {}", a.args);
            Some(app(
                a.id,
                a.label,
                "open",
                &args,
                a.scope,
                Source::KnownDir,
                true,
            ))
        })
        .collect()
}

/// macOS's catalogue from the real Applications folders; `None` everywhere else.
#[cfg(target_os = "macos")]
fn mac_detect_env() -> Option<Vec<DetectedApp>> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    Some(mac_catalogue(&crate::core::apps_mac::mac_roots(
        home.as_deref(),
    )))
}

#[cfg(not(target_os = "macos"))]
fn mac_detect_env() -> Option<Vec<DetectedApp>> {
    None
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn linux_detect_env() -> Option<Vec<DetectedApp>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(p: &str) -> Option<(String, Source)> {
        Some((p.to_string(), Source::AppPaths))
    }

    /// One field set, everything else missing — the shape most of these tests want.
    fn only(fill: impl FnOnce(&mut Probed)) -> Vec<DetectedApp> {
        let mut p = Probed::default();
        fill(&mut p);
        catalogue(&p)
    }

    /// Everything a machine could have at once, two distros included.
    fn everything() -> Probed {
        Probed {
            code: found(r"C:\Code.exe"),
            zed: found(r"C:\zed.exe"),
            vlc: found(r"C:\vlc.exe"),
            terminal: found(r"C:\wt.exe"),
            pwsh: found(r"C:\pwsh.exe"),
            git_bash: found(r"C:\git-bash.exe"),
            wsl: found(r"C:\wsl.exe"),
            cmd: found(r"C:\cmd.exe"),
            distros: vec!["Ubuntu-26.04".into(), "openSUSE Leap 15.6".into()],
        }
    }

    #[track_caller]
    fn entry<'a>(out: &'a [DetectedApp], id: &str) -> &'a DetectedApp {
        out.iter().find(|a| a.id == id).unwrap_or_else(|| {
            let ids: Vec<&str> = out.iter().map(|a| a.id.as_str()).collect();
            panic!("no {id} in {ids:?}")
        })
    }

    /// Every `%token%` in an argument line, wherever it sits — `--cd=%path%` hides one from a
    /// whitespace split.
    fn tokens_in(args: &str) -> Vec<String> {
        args.split('%')
            .skip(1)
            .step_by(2)
            .map(|body| format!("%{body}%"))
            .collect()
    }

    #[test]
    fn nothing_installed_offers_nothing() {
        assert!(catalogue(&Probed::default()).is_empty());
    }

    #[test]
    fn code_alone_offers_one_entry_and_no_wsl_one() {
        let out = only(|p| p.code = found(r"C:\Code.exe"));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "vscode");
        assert_eq!(out[0].args, "%path%");
        assert!(out[0].certain);
    }

    /// The WSL entry rides on Code being installed — offering "Code (WSL)" without Code is
    /// offering a command that cannot run.
    #[test]
    fn wsl_entry_needs_both_code_and_a_distro() {
        let no_code = only(|p| p.distros = vec!["Ubuntu".into()]);
        assert!(!no_code.iter().any(|a| a.id == "vscode-wsl"));

        let both = only(|p| {
            p.code = found(r"C:\Code.exe");
            p.distros = vec!["Ubuntu".into()];
        });
        let wsl = entry(&both, "vscode-wsl");
        assert_eq!(wsl.args, "--remote wsl+%distro% %linuxpath%");
        assert_eq!(wsl.scope, vec!["wsl"]);
    }

    /// The one claim this module must never overstate.
    #[test]
    fn the_wsl_entry_is_never_certain() {
        let out = only(|p| {
            p.code = found(r"C:\Code.exe");
            p.distros = vec!["Ubuntu".into()];
        });
        let wsl = entry(&out, "vscode-wsl");
        assert!(!wsl.certain);
        assert_eq!(wsl.source, Source::WslProbe);
    }

    /// ⚠️ `WslProbe` is the grade for "Windows sees the distro and not its contents", and only the
    /// two remote **editors** may carry it — each needs something installed inside the distro that
    /// Windows cannot see (Code's Remote-WSL extension, Zed's remote server). A distro shell is
    /// not that claim: `wsl -d <name>` starts a login shell by definition, so those entries are
    /// graded by how their host program was found, exactly like every Windows entry.
    #[test]
    fn nothing_but_the_wsl_editors_claim_to_know_the_inside_of_a_distro() {
        let out = catalogue(&everything());
        let probed: Vec<&str> = out
            .iter()
            .filter(|a| a.source == Source::WslProbe)
            .map(|a| a.id.as_str())
            .collect();
        assert_eq!(probed, ["vscode-wsl", "zed-wsl"]);
    }

    /// ⭐ The flag that was deferred rather than guessed. `--remote wsl+<distro>` is **Code's**
    /// spelling and the installed Zed binary rejects it outright; `--wsl <USER@DISTRO>` is Zed's
    /// own, documented in its `--help` and used by the `bin/zed` script Zed ships. `%distro%` with
    /// no user is the deliberate filling — Trove reads the distro off the clicked path and cannot
    /// know the Linux user, and Zed falls back to the distro's default user when none is given.
    #[test]
    fn the_zed_wsl_entry_uses_zeds_own_flag_and_not_codes() {
        let out = only(|p| {
            p.zed = found(r"C:\zed.exe");
            p.distros = vec!["Ubuntu-26.04".into()];
        });
        let zed_wsl = entry(&out, "zed-wsl");
        assert_eq!(zed_wsl.args, "--wsl %distro% %linuxpath%");
        assert!(
            !zed_wsl.args.contains("--remote"),
            "`--remote wsl+…` is VS Code's flag; Zed's CLI rejects it"
        );
        assert!(
            !zed_wsl.args.contains('@'),
            "a hand-written Linux user is a guess; Zed defaults to the distro's own"
        );
        assert_eq!(zed_wsl.scope, vec!["wsl"]);
        assert_eq!(zed_wsl.program, r"C:\zed.exe");
    }

    /// The WSL entry rides on Zed being installed **and** a distro existing — offering either
    /// half alone offers a command that cannot run. And it is never `certain`, however strongly
    /// Zed itself was found: the half nobody checked is inside the distro.
    #[test]
    fn the_zed_wsl_entry_needs_both_halves_and_is_never_certain() {
        let no_zed = only(|p| p.distros = vec!["Ubuntu".into()]);
        assert!(!no_zed.iter().any(|a| a.id == "zed-wsl"));

        let no_distro = only(|p| p.zed = found(r"C:\zed.exe"));
        assert!(!no_distro.iter().any(|a| a.id == "zed-wsl"));

        // `found()` is `AppPaths`, the strongest grade there is — and it still may not leak here.
        let both = only(|p| {
            p.zed = found(r"C:\zed.exe");
            p.distros = vec!["Ubuntu".into()];
        });
        assert!(entry(&both, "zed").certain);
        assert!(!entry(&both, "zed-wsl").certain);
        assert_eq!(entry(&both, "zed-wsl").source, Source::WslProbe);
    }

    /// Zed's confidence follows the evidence rather than a fixed value.
    #[test]
    fn zed_is_certain_only_from_app_paths() {
        let strong = only(|p| p.zed = found(r"C:\zed.exe"));
        assert!(strong[0].certain);

        let weak = only(|p| p.zed = Some((r"C:\zed.exe".into(), Source::KnownDir)));
        assert!(!weak[0].certain);
    }

    /// ⛔ The candidate that never fired. Zed installs to `%LOCALAPPDATA%\Programs\Zed`, the list
    /// said `%LOCALAPPDATA%\Zed`, and the Start-menu shortcut answering first hid it for the whole
    /// life of the module — so a Zed install without a shortcut was invisible.
    #[test]
    fn the_zed_known_dir_is_where_zed_actually_installs() {
        assert!(
            ZED_DIRS.iter().any(|(var, tail)| *var == "LOCALAPPDATA"
                && tail.eq_ignore_ascii_case(r"Programs\Zed\Zed.exe")),
            "the per-user candidate is missing its `Programs\\` segment: {ZED_DIRS:?}"
        );
        // …and where Zed is actually installed, the rung itself must fire.
        let Some(base) = std::env::var_os("LOCALAPPDATA") else {
            return;
        };
        let real = PathBuf::from(base).join(r"Programs\Zed\Zed.exe");
        if real.is_file() {
            assert_eq!(
                known_dir(&ZED_DIRS).map(|p| p.to_ascii_lowercase()),
                Some(real.to_string_lossy().to_ascii_lowercase()),
                "Zed is installed and the known-directory rung still missed it"
            );
        }
    }

    /// ⛔ `wt -d` wants the folder to OPEN, and `%path%` is already that folder — the clicked row
    /// for `folder`, the open folder for `background`. With `%parent%` a right-click on `D:\proj`
    /// opened Terminal in `D:\`.
    #[test]
    fn the_terminal_entry_opens_the_clicked_folder_not_its_parent() {
        let out = only(|p| p.terminal = found(r"C:\wt.exe"));
        let terminal = entry(&out, "terminal-here");
        assert_eq!(terminal.args, "-d %path%");
        assert!(!terminal.args.contains("%parent%"));
    }

    /// ⭐ Four terminals, four different ways to say "start here", and every one of them wrong in
    /// a different way if it is guessed. They live in one function so they cannot drift apart.
    #[test]
    fn each_terminal_carries_its_own_working_directory_flag() {
        let out = catalogue(&everything());
        assert_eq!(entry(&out, "terminal-here").args, "-d %path%");
        assert_eq!(
            entry(&out, "pwsh-here").args,
            "-NoExit -WorkingDirectory %path%"
        );
        assert_eq!(entry(&out, "git-bash-here").args, "--cd=%path%");
        assert_eq!(entry(&out, "cmd-here").args, "/K cd /d %path%");
        for id in ["terminal-here", "pwsh-here", "git-bash-here", "cmd-here"] {
            assert_eq!(
                entry(&out, id).scope,
                vec!["folder", "background"],
                "{id} opens a shell; there is nothing to open a shell *at* for a file"
            );
        }
    }

    /// Git ships no `App Paths` key, so the shortcut's target is the usual answer — nearly a fact,
    /// and flagged so the person glances at it.
    #[test]
    fn git_bash_from_a_shortcut_is_flagged_and_from_app_paths_is_not() {
        let shortcut = only(|p| {
            p.git_bash = Some((
                r"C:\Program Files\Git\git-bash.exe".into(),
                Source::StartMenu,
            ))
        });
        assert!(!entry(&shortcut, "git-bash-here").certain);
        let registered = only(|p| p.git_bash = found(r"C:\Program Files\Git\git-bash.exe"));
        assert!(entry(&registered, "git-bash-here").certain);
    }

    /// ⭐ Two jobs, not two copies: the generic entry serves any distro through `%distro%` on a
    /// WSL path, and the per-distro entries name a distro for a **Windows** folder, where the
    /// clicked path says nothing about which distro was meant.
    #[test]
    fn a_wsl_shell_is_offered_per_distro_and_once_for_the_clicked_distro() {
        let out = catalogue(&everything());
        let generic = entry(&out, "wsl-shell");
        assert_eq!(generic.program, r"C:\wt.exe");
        assert_eq!(generic.args, "wsl -d %distro% --cd %linuxpath%");
        assert_eq!(generic.scope, vec!["wsl"]);

        let ubuntu = entry(&out, "wsl-shell-ubuntu-26-04");
        assert_eq!(ubuntu.args, "wsl -d Ubuntu-26.04 --cd %path%");
        assert_eq!(ubuntu.label, "Open Ubuntu-26.04 here");
        assert_eq!(ubuntu.scope, vec!["folder", "background"]);
        assert!(ubuntu.certain);
    }

    /// ⚠️ `%linuxpath%` built from `C:\Users\alex` is `C:/Users/alex`, which is not a path inside any
    /// distro — so a Windows-scoped entry must never use it, and a `wsl`-scoped one must never use
    /// `%path%`.
    #[test]
    fn a_wsl_entry_uses_the_token_that_matches_its_scope() {
        for a in catalogue(&everything()) {
            let windows_scoped = a.scope.iter().any(|s| s != "wsl");
            let tokens = tokens_in(&a.args);
            if windows_scoped {
                assert!(
                    !tokens.iter().any(|t| t == "%linuxpath%"),
                    "{} is offered on Windows folders and uses %linuxpath%",
                    a.id
                );
            } else {
                assert!(
                    !tokens.iter().any(|t| t == "%path%" || t == "%paths%"),
                    "{} is offered inside a distro and uses a Windows path",
                    a.id
                );
            }
        }
    }

    /// A distro name is not a safe bare word: `openSUSE Leap 15.6` would split into three.
    #[test]
    fn a_distro_name_with_spaces_stays_one_argument() {
        let out = catalogue(&everything());
        let suse = entry(&out, "wsl-shell-opensuse-leap-15-6");
        assert_eq!(suse.args, r#"wsl -d "openSUSE Leap 15.6" --cd %path%"#);
    }

    /// Terminal is the nicer host, but `wsl.exe` on its own is a working one — and the console it
    /// needs is `shell_verbs::needs_console`'s job.
    #[test]
    fn a_distro_shell_falls_back_to_wsl_exe_and_is_dropped_without_a_host() {
        let bare = only(|p| {
            p.wsl = found(r"C:\wsl.exe");
            p.distros = vec!["Ubuntu".into()];
        });
        assert_eq!(entry(&bare, "wsl-shell").program, r"C:\wsl.exe");
        assert_eq!(
            entry(&bare, "wsl-shell").args,
            "-d %distro% --cd %linuxpath%"
        );
        assert_eq!(
            entry(&bare, "wsl-shell-ubuntu").args,
            "-d Ubuntu --cd %path%"
        );

        let hostless = only(|p| p.distros = vec!["Ubuntu".into()]);
        assert!(hostless.is_empty(), "{hostless:?}");
    }

    #[test]
    fn ids_are_unique_so_already_added_can_be_told_apart() {
        let mut p = everything();
        // Two names that slug the same, plus one that slugs to nothing at all.
        p.distros = vec![
            "Ubuntu 24.04".into(),
            "Ubuntu-24-04".into(),
            "…".into(),
            "Ubuntu".into(),
        ];
        let out = catalogue(&p);
        let mut ids: Vec<&str> = out.iter().map(|a| a.id.as_str()).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "duplicate id in the catalogue");
        assert!(ids.iter().all(|id| !id.is_empty()));
    }

    /// Every entry must be usable by the existing expander: an unknown token would reach the
    /// shell verbatim.
    #[test]
    fn only_tokens_the_expander_knows_are_used() {
        const KNOWN: [&str; 6] = [
            "%path%",
            "%paths%",
            "%parent%",
            "%name%",
            "%linuxpath%",
            "%distro%",
        ];
        for a in catalogue(&everything()) {
            assert_eq!(
                a.args.matches('%').count() % 2,
                0,
                "{} has an unclosed token: {}",
                a.id,
                a.args
            );
            for token in tokens_in(&a.args) {
                assert!(
                    KNOWN.contains(&token.as_str()),
                    "{} uses unknown token {}",
                    a.id,
                    token
                );
            }
        }
    }

    /// `--cd=%path%` hides its token from a whitespace split, which is how the check above used
    /// to miss one.
    #[test]
    fn a_token_glued_to_a_flag_is_still_seen() {
        assert_eq!(tokens_in("--cd=%path%"), ["%path%"]);
        assert_eq!(
            tokens_in("--remote wsl+%distro% %linuxpath%"),
            ["%distro%", "%linuxpath%"]
        );
        assert!(tokens_in("-d Ubuntu").is_empty());
    }

    /// Scopes have to match the frontend's `CommandScope` union, or the entry never shows.
    #[test]
    fn scopes_are_all_known_values() {
        const KNOWN: [&str; 4] = ["file", "folder", "background", "wsl"];
        for a in catalogue(&everything()) {
            assert!(!a.scope.is_empty(), "{} has no scope", a.id);
            for s in &a.scope {
                assert!(KNOWN.contains(&s.as_str()), "{} has scope {}", a.id, s);
            }
        }
    }

    /// ⚠️ `contains("")` is true of everything, so a candidate with no Start-menu name to look
    /// for would be "found" as whichever shortcut the walk listed first.
    #[test]
    fn an_empty_start_menu_needle_matches_nothing() {
        let real = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let apps = vec![spotlight::AppEntry {
            name: "Some Other App".into(),
            target: real.clone(),
            ..Default::default()
        }];
        assert_eq!(start_menu(&apps, ""), None);
        assert_eq!(start_menu(&apps, "  "), None);
        assert_eq!(start_menu(&apps, "other app"), Some(real));
    }

    /// A registry value pointing at a deleted exe must not be offered — uninstalls leave the
    /// key behind constantly.
    #[test]
    fn app_path_rejects_a_path_to_nothing() {
        assert_eq!(app_path("definitely-not-installed-xyz.exe"), None);
    }

    #[test]
    fn known_dir_returns_none_when_the_variable_is_missing() {
        assert_eq!(known_dir(&[("TROVE_NO_SUCH_VAR", "x.exe")]), None);
    }
}

/// What the ladder actually finds here, rather than what the catalogue's shape says it would.
#[cfg(all(test, windows))]
mod live_tests {
    use super::*;

    /// ⚠️ The inversion, measured rather than argued: for an MSIX app the *strongest* source is
    /// the one that rots, so `PATH` — the App Execution Alias — is asked first and the bare name
    /// is what a saved command keeps. Skipped where Terminal is not installed.
    #[test]
    fn a_packaged_app_is_offered_by_its_alias_not_by_its_versioned_path() {
        if !wsl::on_path("wt.exe") {
            eprintln!("no wt.exe on PATH; nothing to compare");
            return;
        }
        assert_eq!(
            resolve_packaged("wt.exe", "Terminal", &[], &[]),
            Some(("wt.exe".to_string(), Source::Path)),
            "a packaged app must be offered by the name that outlives its next update"
        );
        // What the plain ladder would have saved instead, for the record.
        println!("App Paths would have saved: {:?}", app_path("wt.exe"));
    }

    /// Prints the machine's real answer — the only way to see that `App Paths` hands back a
    /// versioned `WindowsApps\…` path and `PATH` hands back the alias — and asserts the one
    /// thing that must hold: every program offered is something `CreateProcess` can start.
    #[test]
    fn everything_offered_on_this_machine_resolves_to_something_startable() {
        for a in detect() {
            let resolved = resolve_program(&a.program);
            println!(
                "{:<22} {:<12} {} {}  [{}]",
                a.id,
                format!("{:?}", a.source),
                if a.certain { ' ' } else { '?' },
                a.program,
                resolved
            );
            assert!(
                Path::new(&resolved).is_file(),
                "{} offers {} which resolves to {resolved}, and that is not a file",
                a.id,
                a.program
            );
        }
    }
}

/// The Linux catalogue against a fake `PATH` and fake XDG data dirs. Unix only: the `PATH`
/// check reads the executable bit.
#[cfg(all(test, unix))]
mod linux_tests {
    use super::*;
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn scratch(tag: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("trove-known-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
    fn exe(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }
    fn desktop(data: &Path, id: &str, body: &str) {
        let apps = data.join("applications");
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::write(
            apps.join(id),
            format!("[Desktop Entry]\nType=Application\nName=X\n{body}\n"),
        )
        .unwrap();
    }
    fn ids(out: &[DetectedApp]) -> Vec<&str> {
        out.iter().map(|a| a.id.as_str()).collect()
    }

    /// The Ubuntu machine from C.6.6: `code` and `gnome-text-editor` on PATH, the strip empty.
    #[test]
    fn commands_on_path_are_offered_by_their_bare_name() {
        let s = scratch("path");
        let bin = s.0.join("bin");
        exe(&bin, "code");
        exe(&bin, "gnome-text-editor");
        exe(&bin, "gnome-terminal");
        // a file without the executable bit is not a command
        std::fs::write(bin.join("vlc"), "").unwrap();
        let path = OsString::from(bin.as_os_str());

        let out = linux_catalogue(&[], Some(&path));
        assert_eq!(
            ids(&out),
            ["vscode", "gnome-text-editor", "gnome-terminal-here"]
        );
        let code = entry(&out, "vscode");
        assert_eq!(
            (code.program.as_str(), code.args.as_str(), code.source),
            ("code", "%path%", Source::Path)
        );
        assert!(code.certain);
        let editor = entry(&out, "gnome-text-editor");
        assert_eq!(editor.label, "Open with Text Editor");
        assert_eq!(editor.args, "%paths%");
        assert_eq!(editor.scope, vec!["file"]);
        assert_eq!(
            entry(&out, "gnome-terminal-here").args,
            "--working-directory=%path%"
        );
    }

    #[test]
    fn nothing_installed_offers_nothing() {
        let s = scratch("empty");
        let path = OsString::from(s.0.join("bin").as_os_str());
        assert!(linux_catalogue(&[s.0.join("data")], Some(&path)).is_empty());
        assert!(linux_catalogue(&[], None).is_empty());
    }

    /// No command on PATH, but a `.desktop` file whose program exists: a plain launcher keeps
    /// the catalogue's argument line, a Flatpak wrapper keeps its own.
    #[test]
    fn a_desktop_file_is_the_fallback() {
        let s = scratch("desktop");
        let bin = s.0.join("bin");
        let flatpak = exe(&bin, "flatpak");
        let editor = exe(&s.0.join("opt"), "text-editor");
        let user = s.0.join("user");
        let system = s.0.join("system");
        desktop(
            &system,
            "com.visualstudio.code.desktop",
            &format!(
                "Exec={} run --command=code com.visualstudio.code @@u %F @@",
                flatpak.display()
            ),
        );
        desktop(
            &system,
            "org.gnome.TextEditor.desktop",
            &format!("Exec={} %U", editor.display()),
        );
        let path = OsString::from(bin.as_os_str());

        let out = linux_catalogue(&[user.clone(), system.clone()], Some(&path));
        assert_eq!(ids(&out), ["vscode", "gnome-text-editor"]);
        let code = entry(&out, "vscode");
        assert_eq!(code.source, Source::DesktopEntry);
        assert_eq!(code.program, flatpak.to_string_lossy());
        assert_eq!(
            code.args,
            "run --command=code com.visualstudio.code @@u %paths% @@"
        );
        let text = entry(&out, "gnome-text-editor");
        assert_eq!(text.program, editor.to_string_lossy());
        assert_eq!(text.args, "%paths%");

        // the user's `Hidden=true` copy hides the system one, as in the menu
        desktop(&user, "org.gnome.TextEditor.desktop", "Hidden=true");
        let out = linux_catalogue(&[user, system], Some(&path));
        assert_eq!(ids(&out), ["vscode"]);
    }

    /// A `.desktop` left behind by an uninstall points at nothing, and is not offered.
    #[test]
    fn a_desktop_file_whose_program_is_gone_is_skipped() {
        let s = scratch("gone");
        let data = s.0.join("data");
        desktop(&data, "code.desktop", "Exec=/nowhere/code %F");
        desktop(&data, "vlc.desktop", "Exec=vlc %U\nTryExec=vlc");
        assert!(linux_catalogue(&[data], None).is_empty());
    }

    /// PATH wins over a `.desktop` file for the same app: the bare name survives an update.
    #[test]
    fn path_beats_the_desktop_file() {
        let s = scratch("both");
        let bin = s.0.join("bin");
        exe(&bin, "code");
        let data = s.0.join("data");
        desktop(
            &data,
            "code.desktop",
            &format!("Exec={} %F", bin.join("code").display()),
        );
        let path = OsString::from(bin.as_os_str());
        let out = linux_catalogue(&[data], Some(&path));
        assert_eq!(out.len(), 1);
        assert_eq!(
            (out[0].program.as_str(), out[0].source),
            ("code", Source::Path)
        );
    }

    #[track_caller]
    fn entry<'a>(out: &'a [DetectedApp], id: &str) -> &'a DetectedApp {
        out.iter()
            .find(|a| a.id == id)
            .unwrap_or_else(|| panic!("no {id} in {:?}", ids(out)))
    }
}

/// The macOS catalogue against a fake Applications folder.
#[cfg(all(test, unix))]
mod mac_tests {
    use super::*;

    fn fake_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("trove-known-mac-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// C.6.6 on the Mac: VS Code and Zed sat in /Applications and the strip stayed empty.
    #[test]
    fn bundles_in_an_applications_folder_are_offered_as_open_dash_a() {
        let root = fake_root("found");
        std::fs::create_dir_all(root.join("Visual Studio Code.app")).unwrap();
        std::fs::create_dir_all(root.join("Zed.app")).unwrap();
        // a file named like a bundle is not one
        std::fs::write(root.join("VLC.app"), "").unwrap();

        let out = mac_catalogue(std::slice::from_ref(&root));
        let ids: Vec<&str> = out.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["vscode", "zed"]);
        let zed = &out[1];
        assert_eq!(zed.program, "open");
        assert_eq!(
            zed.args,
            format!("-a \"{}\" %path%", root.join("Zed.app").display())
        );
        assert_eq!(zed.label, "Open with Zed");
        assert_eq!(zed.source, Source::KnownDir);
        assert!(zed.certain);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_first_root_with_the_bundle_wins_and_nothing_found_offers_nothing() {
        let a = fake_root("a");
        let b = fake_root("b");
        assert!(mac_catalogue(&[a.clone(), b.clone()]).is_empty());
        std::fs::create_dir_all(a.join("VLC.app")).unwrap();
        std::fs::create_dir_all(b.join("VLC.app")).unwrap();
        let out = mac_catalogue(&[a.clone(), b.clone()]);
        assert_eq!(out.len(), 1);
        assert!(out[0].args.contains(&a.to_string_lossy().into_owned()));
        assert_eq!(out[0].args.rsplit(' ').next(), Some("%paths%"));
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
}

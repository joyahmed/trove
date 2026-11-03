//! "Start at login": written and removed by the residency toggle. The entry starts the exe
//! with `--hidden` so a resident app comes up in the tray, not as a window. Per user only —
//! no other user, no elevation.
//!
//! - Windows: one value under the user's `Run` key (HKCU). The Microsoft Store build
//!   (`core/channel.rs`, `msstore`) cannot use it — an MSIX package's HKCU writes are
//!   virtualized and the key never fires — so it turns the package's own `windows.startupTask`
//!   on and off through `Windows.ApplicationModel.StartupTask` instead.
//! - macOS: a LaunchAgent plist in `~/Library/LaunchAgents` with `RunAtLoad`. A plist, not
//!   `SMAppService`: the repo does not link ServiceManagement, and a plist needs no entitlement
//!   or helper bundle and works for an unsigned build. It runs the bundle's own binary.
//! - Linux: `$XDG_CONFIG_HOME/autostart/<id>.desktop` (`~/.config` when unset).
//!
//! The file contents and paths are pure functions, tested on every OS; the file write takes
//! the path as an argument so tests use a temp dir.

// The `Run` key half is Windows' only; macOS and Linux use a file.
#![cfg_attr(unix, allow(dead_code))]

use std::io::Result;
use std::path::Path;
#[cfg(any(unix, test))]
use std::path::PathBuf;

#[cfg(windows)]
use crate::core::channel;
use crate::core::registry;

/// The value name under the `Run` key.
pub const RUN_VALUE: &str = "Trove";
/// The `Run` key, relative to HKCU (or to a throw-away root in tests).
pub const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
/// The switch the entry passes so the app starts hidden.
pub const HIDDEN_ARG: &str = "--hidden";

/// `Run` key path under `root`; `root == ""` is HKCU itself.
fn run_key(root: &str) -> String {
    if root.is_empty() {
        RUN_KEY.to_string()
    } else {
        format!("{root}\\{RUN_KEY}")
    }
}

/// The command line the entry holds: `"<exe>" --hidden`.
pub fn run_command(exe: &Path) -> String {
    format!("\"{}\" {HIDDEN_ARG}", exe.display())
}

pub fn set_run_entry(root: &str, exe: &Path) -> Result<()> {
    registry::write_sz(&run_key(root), RUN_VALUE, &run_command(exe))
}

/// Ok when the value was already absent.
pub fn remove_run_entry(root: &str) -> Result<()> {
    registry::delete_value(&run_key(root), RUN_VALUE)
}

pub fn run_entry_exists(root: &str) -> bool {
    matches!(registry::read_sz(&run_key(root), RUN_VALUE), Ok(Some(_)))
}

/// The app identifier (`tauri.conf.json`): the LaunchAgent label and the autostart file name.
#[cfg(any(unix, test))]
pub const APP_ID: &str = "com.joyahmed.trove";

#[cfg(any(target_os = "macos", test))]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The LaunchAgent plist: runs `<exe> --hidden` at login.
#[cfg(any(target_os = "macos", test))]
pub fn launch_agent_plist(exe: &Path) -> String {
    let exe = xml_escape(&exe.to_string_lossy());
    let mut p = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    p.push_str("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n");
    p.push_str("<plist version=\"1.0\">\n<dict>\n");
    p.push_str(&format!(
        "\t<key>Label</key>\n\t<string>{APP_ID}</string>\n"
    ));
    p.push_str("\t<key>ProgramArguments</key>\n\t<array>\n");
    p.push_str(&format!("\t\t<string>{exe}</string>\n"));
    p.push_str(&format!("\t\t<string>{HIDDEN_ARG}</string>\n"));
    p.push_str("\t</array>\n\t<key>RunAtLoad</key>\n\t<true/>\n</dict>\n</plist>\n");
    p
}

/// `<home>/Library/LaunchAgents/<id>.plist`
#[cfg(any(target_os = "macos", test))]
pub fn launch_agent_path(home: &Path) -> PathBuf {
    home.join("Library")
        .join("LaunchAgents")
        .join(format!("{APP_ID}.plist"))
}

/// One argument of a desktop-entry `Exec` line, per the Desktop Entry spec. An argument made
/// only of safe characters (ASCII alphanumerics and `/ . _ + - ,`) stays bare: `xdg-mime` and
/// `xdg-open` read the first `Exec` word literally, quotes included, so a quoted program path
/// would not be found. Anything else is double-quoted, with `"`, `` ` ``, `$` and `\` backslash-escaped inside the quotes; then the string-value
/// rule doubles every backslash; `%` is doubled so it is not a field code.
#[cfg(any(all(unix, not(target_os = "macos")), test))]
pub fn desktop_exec_arg(arg: &str) -> String {
    let safe =
        |c: char| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '+' | '-' | ',');
    if !arg.is_empty() && arg.chars().all(safe) {
        return arg.to_string();
    }
    let mut quoted = String::from("\"");
    for c in arg.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    quoted.push('"');
    quoted.replace('\\', "\\\\").replace('%', "%%")
}

/// The autostart `.desktop` file: runs `"<exe>" --hidden` at login.
#[cfg(any(all(unix, not(target_os = "macos")), test))]
pub fn autostart_desktop(exe: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=Trove\nExec={} {HIDDEN_ARG}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        desktop_exec_arg(&exe.to_string_lossy())
    )
}

/// `<config>/autostart/<id>.desktop`, where `<config>` is `$XDG_CONFIG_HOME` when it is an
/// absolute path (the spec ignores a relative one), else `<home>/.config`.
#[cfg(any(all(unix, not(target_os = "macos")), test))]
pub fn autostart_path(xdg_config_home: Option<&str>, home: &Path) -> PathBuf {
    let base = match xdg_config_home {
        Some(x) if Path::new(x).is_absolute() => PathBuf::from(x),
        _ => home.join(".config"),
    };
    base.join("autostart").join(format!("{APP_ID}.desktop"))
}

/// Write `content` at `path`, creating the folder.
#[cfg(any(unix, test))]
pub fn write_entry_file(path: &Path, content: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, content)
}

/// Ok when the file was already absent.
#[cfg(any(unix, test))]
pub fn remove_entry_file(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// The login-entry file on macOS / Linux.
#[cfg(unix)]
fn login_file() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::other("HOME is not set"))?;
    #[cfg(target_os = "macos")]
    return Ok(launch_agent_path(&home));
    #[cfg(not(target_os = "macos"))]
    Ok(autostart_path(
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        &home,
    ))
}

#[cfg(target_os = "macos")]
fn login_content(exe: &Path) -> String {
    launch_agent_plist(exe)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn login_content(exe: &Path) -> String {
    autostart_desktop(exe)
}

/// `Windows.ApplicationModel.StartupTaskState`, by value.
pub mod task_state {
    // named for completeness and the tests; the code only compares against the others
    #[allow(dead_code)]
    pub const DISABLED: i32 = 0;
    pub const DISABLED_BY_USER: i32 = 1;
    pub const ENABLED: i32 = 2;
    pub const DISABLED_BY_POLICY: i32 = 3;
    pub const ENABLED_BY_POLICY: i32 = 4;
}

/// Whether a StartupTask in `state` starts the app at logon.
pub fn task_is_on(state: i32) -> bool {
    matches!(state, task_state::ENABLED | task_state::ENABLED_BY_POLICY)
}

/// What asking for `want` against a task in `state` comes to: `Ok` when it holds now, else the
/// sentence the person sees. Only the person (Task Manager > Startup apps) can undo their own
/// "off", and only an admin a policy — an app's request is refused for both, so say where.
pub fn task_outcome(want: bool, state: i32) -> std::result::Result<(), &'static str> {
    if task_is_on(state) == want {
        return Ok(());
    }
    Err(match state {
        task_state::DISABLED_BY_USER => {
            "Startup is turned off for Trove in Task Manager > Startup apps. Turn it on there."
        }
        task_state::DISABLED_BY_POLICY | task_state::ENABLED_BY_POLICY => {
            "Your organisation's policy decides whether Trove starts at sign-in."
        }
        _ => "Windows did not change Trove's startup setting.",
    })
}

/// `Windows.ApplicationModel.Activation.ActivationKind::StartupTask`, by value.
#[cfg_attr(not(windows), allow(dead_code))]
pub const ACTIVATION_STARTUP_TASK: i32 = 1020;

/// Whether a launch is the Store build's logon StartupTask, which must come up hidden like the
/// Run-key entry's `--hidden` does. `activation` is the activation kind the OS reports, `None`
/// when there is none (not packaged, or not Windows). Only the `msstore` channel asks.
pub fn starts_hidden_for(channel: super::channel::Channel, activation: Option<i32>) -> bool {
    channel == super::channel::Channel::Msstore && activation == Some(ACTIVATION_STARTUP_TASK)
}

/// The activation kind of this process, or `None` outside a package.
#[cfg(windows)]
fn activation_kind() -> Option<i32> {
    use windows::ApplicationModel::AppInstance;
    AppInstance::GetActivatedEventArgs()
        .and_then(|a| a.Kind())
        .ok()
        .map(|k| k.0)
}

#[cfg(not(windows))]
fn activation_kind() -> Option<i32> {
    None
}

/// Was this process started by the Store build's logon StartupTask? Probed once, and only in
/// the `msstore` build (no other build makes the probe).
pub fn launched_by_login_task() -> bool {
    use std::sync::OnceLock;
    static HIDDEN: OnceLock<bool> = OnceLock::new();
    *HIDDEN.get_or_init(|| {
        super::channel::CURRENT == super::channel::Channel::Msstore
            && starts_hidden_for(super::channel::CURRENT, activation_kind())
    })
}

/// The packaged app's `windows.startupTask` (Store build only; outside a package every call
/// fails, since there is no manifest to find the task in).
#[cfg(windows)]
mod startup_task {
    use windows::core::HSTRING;
    use windows::ApplicationModel::StartupTask;

    use super::{task_outcome, task_state};
    use crate::core::channel::STARTUP_TASK_ID;

    fn io(e: windows::core::Error) -> std::io::Error {
        std::io::Error::other(e.message())
    }

    fn task() -> std::io::Result<StartupTask> {
        StartupTask::GetAsync(&HSTRING::from(STARTUP_TASK_ID))
            .and_then(|op| op.get())
            .map_err(io)
    }

    pub fn state() -> std::io::Result<i32> {
        Ok(task()?.State().map_err(io)?.0)
    }

    pub fn set(on: bool) -> std::io::Result<()> {
        let task = task()?;
        let state = if on {
            match task.State().map_err(io)?.0 {
                // a user or policy "off" cannot be overridden; report it, do not ask
                s @ (task_state::DISABLED_BY_USER | task_state::DISABLED_BY_POLICY) => s,
                _ => {
                    task.RequestEnableAsync()
                        .and_then(|op| op.get())
                        .map_err(io)?
                        .0
                }
            }
        } else {
            task.Disable().map_err(io)?;
            task.State().map_err(io)?.0
        };
        task_outcome(on, state).map_err(std::io::Error::other)
    }
}

/// Start at login on or off, on whichever OS this is.
pub fn set_login_entry(on: bool, exe: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        if channel::CURRENT.uses_startup_task() {
            startup_task::set(on)
        } else if on {
            set_run_entry("", exe)
        } else {
            remove_run_entry("")
        }
    }
    #[cfg(unix)]
    {
        let path = login_file()?;
        if !on {
            return remove_entry_file(&path);
        }
        write_entry_file(&path, &login_content(exe))
    }
}

pub fn login_entry_exists() -> bool {
    #[cfg(windows)]
    {
        if channel::CURRENT.uses_startup_task() {
            return startup_task::state().is_ok_and(task_is_on);
        }
        run_entry_exists("")
    }
    #[cfg(unix)]
    {
        login_file().is_ok_and(|p| p.is_file())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_store_channel_hides_a_startup_task_launch() {
        use crate::core::channel::Channel::{Direct, Msstore};
        let task = Some(ACTIVATION_STARTUP_TASK);
        assert!(starts_hidden_for(Msstore, task));
        assert!(!starts_hidden_for(Direct, task));
        assert!(!starts_hidden_for(Msstore, Some(0))); // a normal Launch
        assert!(!starts_hidden_for(Msstore, None));
        assert!(!starts_hidden_for(Direct, None));
    }

    #[test]
    fn plist_runs_the_exe_hidden_at_load_and_escapes_xml() {
        let p = launch_agent_plist(Path::new(
            "/Applications/Trove & Co.app/Contents/MacOS/trove",
        ));
        assert!(p.contains("<key>Label</key>\n\t<string>com.joyahmed.trove</string>"));
        assert!(
            p.contains("<string>/Applications/Trove &amp; Co.app/Contents/MacOS/trove</string>")
        );
        assert!(p.contains("<string>--hidden</string>"));
        assert!(p.contains("<key>RunAtLoad</key>\n\t<true/>"));
        assert!(p.starts_with("<?xml"));
    }

    #[test]
    fn launch_agent_lives_in_the_users_library() {
        assert_eq!(
            launch_agent_path(Path::new("/Users/alex")),
            Path::new("/Users/alex")
                .join("Library")
                .join("LaunchAgents")
                .join("com.joyahmed.trove.plist")
        );
    }

    #[test]
    fn exec_arg_is_bare_when_safe_and_quoted_and_escaped_otherwise() {
        assert_eq!(desktop_exec_arg("/opt/trove"), "/opt/trove");
        assert_eq!(
            desktop_exec_arg("/usr/local/bin/trove-1.2_x+y,z"),
            "/usr/local/bin/trove-1.2_x+y,z"
        );
        assert_eq!(desktop_exec_arg(""), "\"\"");
        assert_eq!(desktop_exec_arg("/my apps/trove"), "\"/my apps/trove\"");
        // `$` and `"` get one escape for the quoting rule, which the string rule doubles
        assert_eq!(desktop_exec_arg("/a$b"), r#""/a\\$b""#);
        assert_eq!(desktop_exec_arg("/a\"b"), r#""/a\\"b""#);
        assert_eq!(desktop_exec_arg("/100%"), "\"/100%%\"");
    }

    #[test]
    fn autostart_file_runs_the_exe_hidden() {
        let d = autostart_desktop(Path::new("/opt/Trove App/trove"));
        assert!(d.starts_with("[Desktop Entry]\nType=Application\n"));
        assert!(d.contains("\nExec=\"/opt/Trove App/trove\" --hidden\n"));
    }

    #[test]
    fn autostart_path_honours_xdg_config_home() {
        let home = Path::new("/home/alex");
        let want = |base: &Path| base.join("autostart").join("com.joyahmed.trove.desktop");
        let dflt = want(&home.join(".config"));
        assert_eq!(autostart_path(None, home), dflt);
        assert_eq!(autostart_path(Some(""), home), dflt);
        assert_eq!(autostart_path(Some("rel/x"), home), dflt);
        let abs = std::env::temp_dir().join("xdg-cfg");
        assert_eq!(
            autostart_path(Some(&abs.to_string_lossy()), home),
            want(&abs)
        );
    }

    #[test]
    fn entry_file_write_remove_round_trip_in_a_temp_dir() {
        let dir = std::env::temp_dir().join(format!("trove-startup-{}", std::process::id()));
        let path = dir.join("autostart").join("x.desktop");
        remove_entry_file(&path).unwrap(); // absent: Ok
        write_entry_file(&path, "a").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a");
        remove_entry_file(&path).unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_command_quotes_the_exe_and_passes_hidden() {
        assert_eq!(
            run_command(Path::new(r"D:\Apps\explorer tauri.exe")),
            r#""D:\Apps\explorer tauri.exe" --hidden"#
        );
    }

    #[test]
    fn a_task_is_on_only_when_enabled() {
        use task_state::*;
        assert!(task_is_on(ENABLED));
        assert!(task_is_on(ENABLED_BY_POLICY));
        for s in [DISABLED, DISABLED_BY_USER, DISABLED_BY_POLICY, 7] {
            assert!(!task_is_on(s), "{s}");
        }
    }

    #[test]
    fn task_outcome_names_who_holds_the_switch() {
        use task_state::*;
        assert_eq!(task_outcome(true, ENABLED), Ok(()));
        assert_eq!(task_outcome(false, DISABLED), Ok(()));
        assert_eq!(task_outcome(false, DISABLED_BY_USER), Ok(()));
        assert!(task_outcome(true, DISABLED_BY_USER)
            .unwrap_err()
            .contains("Task Manager"));
        assert!(task_outcome(true, DISABLED_BY_POLICY)
            .unwrap_err()
            .contains("policy"));
        assert!(task_outcome(false, ENABLED_BY_POLICY)
            .unwrap_err()
            .contains("policy"));
        assert!(task_outcome(true, DISABLED)
            .unwrap_err()
            .contains("did not change"));
    }

    #[test]
    fn run_key_is_relative_to_the_root() {
        assert_eq!(run_key(""), RUN_KEY);
        assert_eq!(run_key("Software\\x"), format!("Software\\x\\{RUN_KEY}"));
    }
}

/// Under a throw-away `HKCU\Software\trove-test\…` root, never the real `Run` key.
#[cfg(all(test, windows))]
mod live_tests {
    use super::*;

    struct Scratch(
        String,
        #[allow(dead_code)] std::sync::MutexGuard<'static, ()>,
    );
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = registry::delete_tree(&self.0);
            let _ = registry::delete_key_if_empty("Software\\trove-test");
        }
    }

    #[test]
    fn set_exists_remove_round_trip() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let s = Scratch(
            format!(
                "Software\\trove-test\\startup-{}-{nanos}",
                std::process::id()
            ),
            registry::tests::scratch_lock(),
        );
        assert!(!run_entry_exists(&s.0));
        set_run_entry(&s.0, Path::new(r"D:\Apps\trove.exe")).unwrap();
        assert!(run_entry_exists(&s.0));
        assert_eq!(
            registry::read_sz(&run_key(&s.0), RUN_VALUE)
                .unwrap()
                .as_deref(),
            Some(r#""D:\Apps\trove.exe" --hidden"#)
        );
        remove_run_entry(&s.0).unwrap();
        assert!(!run_entry_exists(&s.0));
        remove_run_entry(&s.0).unwrap(); // already gone: still Ok
    }
}

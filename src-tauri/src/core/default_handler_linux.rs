//! Set as the default file manager on Linux, per user, reversibly: `xdg-mime default
//! <our>.desktop inode/directory` makes Trove the app that opens a folder. The default that
//! was there before is written to a backup file first, so `revert` puts exactly that back.
//!
//! The Linux bundle (`bundle.targets` is `["nsis"]` only today) installs no `.desktop` file,
//! so `apply` writes one to `~/.local/share/applications`. The command arguments and the
//! parsing of `xdg-mime query` are pure functions; the real runs go through an injected
//! runner so tests never call `xdg-mime` or touch the real mime associations.

use std::io::{Error, ErrorKind, Result};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::default_handler::Status;
use crate::core::startup::APP_ID;

/// The mime type every file manager registers for.
pub const MIME: &str = "inode/directory";
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
pub const BACKUP_FILE: &str = "default-backup-linux.json";

/// Our `.desktop` file name, the id `xdg-mime` takes.
pub fn desktop_id() -> String {
    format!("{APP_ID}.desktop")
}

/// `xdg-mime query default inode/directory`
pub fn query_args() -> Vec<String> {
    ["query", "default", MIME].map(String::from).to_vec()
}

/// `xdg-mime default <id> inode/directory`
pub fn set_args(desktop_id: &str) -> Vec<String> {
    ["default", desktop_id, MIME].map(String::from).to_vec()
}

/// The desktop id `xdg-mime query default` printed; `None` for empty output (no default).
pub fn parse_query(stdout: &str) -> Option<String> {
    let line = stdout.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.to_string())
}

/// `<data_home>/applications/<id>.desktop`; `<data_home>` is `$XDG_DATA_HOME` when absolute,
/// else `<home>/.local/share`.
pub fn desktop_file_path(xdg_data_home: Option<&str>, home: &Path) -> PathBuf {
    let base = match xdg_data_home {
        Some(x) if Path::new(x).is_absolute() => PathBuf::from(x),
        _ => home.join(".local").join("share"),
    };
    base.join("applications").join(desktop_id())
}

/// The launcher: opens the folder it is given (`%U` is the URI list a file manager gets).
pub fn desktop_file(exe: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=Trove\nComment=File explorer\nExec={} %U\nIcon=trove\nTerminal=false\nCategories=System;FileTools;FileManager;\nMimeType={MIME};\n",
        crate::core::startup::desktop_exec_arg(&exe.to_string_lossy())
    )
}

/// Runs `xdg-mime <args>` and returns its stdout.
pub type Runner<'a> = &'a dyn Fn(&[String]) -> Result<String>;

/// The real runner.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
pub fn run_xdg_mime(args: &[String]) -> Result<String> {
    let out = std::process::Command::new("xdg-mime").args(args).output()?;
    if !out.status.success() {
        return Err(Error::other(format!(
            "xdg-mime {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Backup {
    /// The desktop id that was the folder default before `apply`; `None` when there was none.
    pub previous: Option<String>,
}

fn write_backup(path: &Path, backup: &Backup) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(backup)?)?;
    std::fs::rename(&tmp, path)
}

fn read_backup(path: &Path) -> Result<Backup> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(Error::other),
        Err(e) if e.kind() == ErrorKind::NotFound => Err(Error::new(
            ErrorKind::NotFound,
            "No backup from a previous apply was found, so there is nothing to revert",
        )),
        Err(e) => Err(e),
    }
}

pub fn query_default(run: Runner) -> Result<Option<String>> {
    Ok(parse_query(&run(&query_args())?))
}

/// Applied when the folder default is our desktop id; anything else is not applied.
pub fn status(run: Runner) -> Status {
    match query_default(run) {
        Ok(Some(id)) if id == desktop_id() => Status::Applied,
        _ => Status::NotApplied,
    }
}

/// Write our launcher, remember the current default (an existing backup is kept: it holds
/// the state from before the first apply), then make us the default.
pub fn apply(run: Runner, exe: &Path, desktop_path: &Path, backup_path: &Path) -> Result<()> {
    if !backup_path.exists() {
        let previous = query_default(run)?.filter(|id| *id != desktop_id());
        write_backup(backup_path, &Backup { previous })?;
    }
    if let Some(dir) = desktop_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(desktop_path, desktop_file(exe))?;
    run(&set_args(&desktop_id()))?;
    Ok(())
}

/// Put the previous default back (when there was one), drop our launcher and the backup.
/// With no previous default `xdg-mime` has no "unset"; removing our launcher leaves the
/// association pointing at a file that no longer exists, which the system ignores.
pub fn revert(run: Runner, desktop_path: &Path, backup_path: &Path) -> Result<()> {
    let backup = read_backup(backup_path)?;
    if let Some(previous) = backup.previous {
        run(&set_args(&previous))?;
    }
    match std::fs::remove_file(desktop_path) {
        Err(e) if e.kind() != ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    std::fs::remove_file(backup_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn args_name_the_mime_type() {
        assert_eq!(query_args(), ["query", "default", "inode/directory"]);
        assert_eq!(
            set_args("a.desktop"),
            ["default", "a.desktop", "inode/directory"]
        );
        assert_eq!(desktop_id(), "com.joyahmed.trove.desktop");
    }

    #[test]
    fn parse_query_takes_the_first_non_empty_line() {
        assert_eq!(
            parse_query("org.gnome.Nautilus.desktop\n").as_deref(),
            Some("org.gnome.Nautilus.desktop")
        );
        assert_eq!(
            parse_query("  \n x.desktop \n").as_deref(),
            Some("x.desktop")
        );
        assert_eq!(parse_query(""), None);
        assert_eq!(parse_query("\n\n"), None);
    }

    #[test]
    fn desktop_file_path_honours_xdg_data_home() {
        let home = Path::new("/home/alex");
        let dflt = home
            .join(".local")
            .join("share")
            .join("applications")
            .join("com.joyahmed.trove.desktop");
        assert_eq!(desktop_file_path(None, home), dflt);
        assert_eq!(desktop_file_path(Some("rel"), home), dflt);
        let abs = std::env::temp_dir().join("xdg-data");
        assert_eq!(
            desktop_file_path(Some(&abs.to_string_lossy()), home),
            abs.join("applications").join("com.joyahmed.trove.desktop")
        );
    }

    #[test]
    fn desktop_file_handles_folders_and_quotes_the_exe() {
        let d = desktop_file(Path::new("/opt/Trove App/trove"));
        assert!(d.contains("\nExec=\"/opt/Trove App/trove\" %U\n"));
        assert!(d.contains("\nMimeType=inode/directory;\n"));
        assert!(d.contains("FileManager;"));
    }

    /// A fake `xdg-mime`: holds the folder default, records every call.
    struct Fake {
        default: RefCell<Option<String>>,
        calls: RefCell<Vec<Vec<String>>>,
    }
    impl Fake {
        fn new(default: Option<&str>) -> Self {
            Fake {
                default: RefCell::new(default.map(String::from)),
                calls: RefCell::new(Vec::new()),
            }
        }
        fn run(&self, args: &[String]) -> Result<String> {
            self.calls.borrow_mut().push(args.to_vec());
            if args == query_args() {
                return Ok(self.default.borrow().clone().unwrap_or_default());
            }
            assert_eq!(args[0], "default");
            *self.default.borrow_mut() = Some(args[1].clone());
            Ok(String::new())
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("trove-dh-linux-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn apply_then_revert_restores_the_previous_default() {
        let dir = scratch("round");
        let (desktop, backup) = (dir.join("apps").join("t.desktop"), dir.join("b.json"));
        let fake = Fake::new(Some("org.gnome.Nautilus.desktop"));
        let run = |a: &[String]| fake.run(a);
        assert_eq!(status(&run), Status::NotApplied);

        apply(&run, Path::new("/opt/trove"), &desktop, &backup).unwrap();
        assert_eq!(status(&run), Status::Applied);
        assert!(desktop.is_file());
        assert_eq!(
            read_backup(&backup).unwrap().previous.as_deref(),
            Some("org.gnome.Nautilus.desktop")
        );

        // a second apply keeps the first backup
        apply(&run, Path::new("/opt/trove"), &desktop, &backup).unwrap();
        assert_eq!(
            read_backup(&backup).unwrap().previous.as_deref(),
            Some("org.gnome.Nautilus.desktop")
        );

        revert(&run, &desktop, &backup).unwrap();
        assert_eq!(
            fake.default.borrow().as_deref(),
            Some("org.gnome.Nautilus.desktop")
        );
        assert_eq!(status(&run), Status::NotApplied);
        assert!(!desktop.exists() && !backup.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revert_with_no_previous_default_drops_our_files_and_sets_nothing() {
        let dir = scratch("none");
        let (desktop, backup) = (dir.join("t.desktop"), dir.join("b.json"));
        let fake = Fake::new(None);
        let run = |a: &[String]| fake.run(a);
        apply(&run, Path::new("/opt/trove"), &desktop, &backup).unwrap();
        assert_eq!(read_backup(&backup).unwrap().previous, None);
        let before = fake.calls.borrow().len();
        revert(&run, &desktop, &backup).unwrap();
        assert_eq!(fake.calls.borrow().len(), before);
        assert!(!desktop.exists() && !backup.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revert_without_a_backup_is_a_clear_error() {
        let dir = scratch("nobackup");
        let fake = Fake::new(None);
        let run = |a: &[String]| fake.run(a);
        let e = revert(&run, &dir.join("t.desktop"), &dir.join("b.json")).unwrap_err();
        assert_eq!(e.kind(), ErrorKind::NotFound);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_set_leaves_the_backup_for_a_retry() {
        let dir = scratch("fail");
        let (desktop, backup) = (dir.join("t.desktop"), dir.join("b.json"));
        let run = |a: &[String]| {
            if a[0] == "default" {
                Err(Error::other("boom"))
            } else {
                Ok("x.desktop\n".to_string())
            }
        };
        assert!(apply(&run, Path::new("/opt/trove"), &desktop, &backup).is_err());
        assert_eq!(
            read_backup(&backup).unwrap().previous.as_deref(),
            Some("x.desktop")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Both `.desktop` files we write pass `desktop-file-validate`; skipped where it is not
    /// installed (it ships with `desktop-file-utils`).
    #[test]
    fn our_desktop_files_pass_desktop_file_validate() {
        let tool = Path::new("/usr/bin/desktop-file-validate");
        if !tool.is_file() {
            eprintln!("no desktop-file-validate; skipped");
            return;
        }
        let dir = scratch("validate");
        let exe = Path::new("/opt/Trove App/trove");
        for (name, text) in [
            (
                "autostart.desktop",
                crate::core::startup::autostart_desktop(exe),
            ),
            ("handler.desktop", desktop_file(exe)),
        ] {
            let path = dir.join(name);
            std::fs::write(&path, text).unwrap();
            let out = std::process::Command::new(tool)
                .arg(&path)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{name}: {}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real `xdg-mime`, pointed at a scratch `XDG_CONFIG_HOME`/`XDG_DATA_HOME` so the
    /// user's own associations are never read or written: apply makes us the folder default,
    /// revert puts the pre-seeded one back. `#[ignore]`d: it depends on the desktop's
    /// `xdg-mime` backend. Run: `cargo test --lib -- --ignored xdg_mime_live`.
    #[test]
    #[ignore]
    fn xdg_mime_live_apply_then_revert_restores_the_previous_default() {
        let found = std::process::Command::new("xdg-mime")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success());
        if !found {
            eprintln!("no xdg-mime on PATH; skipped");
            return;
        }
        let dir = scratch("live");
        let (config, data) = (dir.join("config"), dir.join("data"));
        let apps = data.join("applications");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(&apps).unwrap();
        // `xdg-mime query` only reports a default whose `Exec` names a program that exists
        let exe = std::env::current_exe().unwrap();
        let previous = "org.example.Previous.desktop";
        std::fs::write(
            apps.join(previous),
            format!(
                "[Desktop Entry]\nType=Application\nName=Previous\nExec={} %U\nMimeType={MIME};\n",
                exe.display()
            ),
        )
        .unwrap();
        std::fs::write(
            config.join("mimeapps.list"),
            format!("[Default Applications]\n{MIME}={previous}\n"),
        )
        .unwrap();

        let run = |args: &[String]| -> Result<String> {
            let out = std::process::Command::new("xdg-mime")
                .args(args)
                .env("XDG_CONFIG_HOME", &config)
                .env("XDG_DATA_HOME", &data)
                .output()?;
            if !out.status.success() {
                return Err(Error::other(
                    String::from_utf8_lossy(&out.stderr).into_owned(),
                ));
            }
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        };
        let desktop = desktop_file_path(Some(&data.to_string_lossy()), &dir);
        let backup = dir.join(BACKUP_FILE);
        assert_eq!(query_default(&run).unwrap().as_deref(), Some(previous));

        apply(&run, &exe, &desktop, &backup).unwrap();
        assert_eq!(
            query_default(&run).unwrap().as_deref(),
            Some(desktop_id().as_str())
        );
        assert_eq!(status(&run), Status::Applied);

        revert(&run, &desktop, &backup).unwrap();
        assert_eq!(query_default(&run).unwrap().as_deref(), Some(previous));
        assert!(!desktop.exists() && !backup.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

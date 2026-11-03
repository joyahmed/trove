//! Set as the default file manager, per user, reversibly: the four `HKCU\Software\Classes`
//! command keys Explorer's callers hit (Win+E, a folder double-click, `explorer.exe <path>`,
//! a drive) get `"<exe>" "%1"` with an empty `DelegateExecute`; what they held before is
//! written to a backup file first, so `revert` restores exactly that. Nothing here touches
//! HKLM, HKCR, `Winlogon\Shell`, the desktop or the taskbar.
//!
//! `root` is `Software\Classes` in the app and a throw-away key in tests.

// The registry flow is Windows' (and Mac's stub); Linux has its own in `default_handler_linux`.
#![cfg_attr(all(unix, not(target_os = "macos")), allow(dead_code))]

use std::io::{Error, ErrorKind, Result};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::channel::{Channel, DEFAULT_HANDLER_UNAVAILABLE};
use crate::core::registry::{
    delete_key_if_empty, delete_tree, delete_value, key_exists, read_sz, write_sz, DEFAULT_VALUE,
};

/// The four `command` keys, relative to `Software\Classes`.
pub const HANDLER_KEYS: [&str; 4] = [
    r"CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command",
    r"Directory\shell\open\command",
    r"Folder\shell\open\command",
    r"Drive\shell\open\command",
];

/// The CLSID key normally delegates to Explorer; an empty value overrides that.
const DELEGATE_EXECUTE: &str = "DelegateExecute";

pub const BACKUP_FILE: &str = "default-backup.json";

/// Whether `channel` may write the keys at all. The Store build's HKCU writes go to the
/// package's private hive, which Explorer never reads (plan 22, risk table), so it is refused
/// with the sentence Settings shows — never a write that silently does nothing.
pub fn allowed(channel: Channel) -> Result<()> {
    if channel.offers_default_handler() {
        Ok(())
    } else {
        Err(Error::new(
            ErrorKind::Unsupported,
            DEFAULT_HANDLER_UNAVAILABLE,
        ))
    }
}

/// `"<exe>" "%1"`
pub fn command_line(exe: &Path) -> String {
    format!("\"{}\" \"%1\"", exe.display())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    /// Relative to the root (`Directory\shell\open\command`).
    pub key: String,
    /// Whether the `command` key existed at all before `apply`.
    pub existed: bool,
    pub default: Option<String>,
    pub delegate_execute: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Backup {
    pub entries: Vec<BackupEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Status {
    NotApplied,
    Applied,
    /// Some of the four keys hold our command; `applied` names them.
    PartiallyApplied {
        applied: Vec<String>,
    },
    /// All four point at one other executable (this exe moved, or another app took over).
    AppliedToOther {
        exe: String,
    },
}

fn full(root: &str, key: &str) -> String {
    format!("{root}\\{key}")
}

/// What the keys hold right now, as a backup would record it.
fn snapshot(root: &str) -> Result<Backup> {
    let mut entries = Vec::with_capacity(HANDLER_KEYS.len());
    for key in HANDLER_KEYS {
        let path = full(root, key);
        entries.push(BackupEntry {
            key: key.to_string(),
            existed: key_exists(&path),
            default: read_sz(&path, DEFAULT_VALUE)?,
            delegate_execute: read_sz(&path, DELEGATE_EXECUTE)?,
        });
    }
    Ok(Backup { entries })
}

/// Write via a temp file + rename, like the settings file.
fn write_backup(path: &Path, backup: &Backup) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = tmp_path(path);
    std::fs::write(&tmp, serde_json::to_vec_pretty(backup)?)?;
    std::fs::rename(&tmp, path)
}

fn tmp_path(target: &Path) -> PathBuf {
    target.with_extension(format!("json.{}.tmp", std::process::id()))
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

/// Point the four keys at `exe`. The prior values go to `backup_path` first; an existing
/// backup is kept, since it holds the true prior state from before the first apply.
pub fn apply(root: &str, exe: &Path, backup_path: &Path) -> Result<()> {
    if !backup_path.exists() {
        write_backup(backup_path, &snapshot(root)?)?;
    }
    let command = command_line(exe);
    for key in HANDLER_KEYS {
        let path = full(root, key);
        write_sz(&path, DEFAULT_VALUE, &command)?;
        write_sz(&path, DELEGATE_EXECUTE, "")?;
    }
    Ok(())
}

/// Put back exactly what `apply` found, then delete the backup.
pub fn revert(root: &str, backup_path: &Path) -> Result<()> {
    let backup = read_backup(backup_path)?;
    for entry in &backup.entries {
        let path = full(root, &entry.key);
        if entry.existed {
            restore_value(&path, DEFAULT_VALUE, entry.default.as_deref())?;
            restore_value(&path, DELEGATE_EXECUTE, entry.delegate_execute.as_deref())?;
        } else {
            delete_tree(&path)?;
            // `…\shell\<verb>` then `…\shell`, each only while empty — never the class root.
            let mut parent = Path::new(&entry.key).parent();
            for _ in 0..2 {
                let Some(p) = parent else { break };
                if !delete_key_if_empty(&full(root, &p.to_string_lossy()))? {
                    break;
                }
                parent = p.parent();
            }
        }
    }
    std::fs::remove_file(backup_path)
}

fn restore_value(path: &str, name: &str, prior: Option<&str>) -> Result<()> {
    match prior {
        Some(v) => write_sz(path, name, v),
        None => delete_value(path, name),
    }
}

/// The executable a `"<exe>" "%1"` command runs, when it is one; `None` for Explorer's own
/// delegation, an empty key, or a command without `%1`.
fn handler_exe(command: &str) -> Option<String> {
    let rest = command.strip_prefix('"')?;
    let end = rest.find('"')?;
    let exe = &rest[..end];
    let tail = &rest[end + 1..];
    if !tail.contains("%1") {
        return None;
    }
    let name = Path::new(exe)
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name == "explorer.exe" {
        return None;
    }
    Some(exe.to_string())
}

fn same_path(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

pub fn status(root: &str, exe: &Path) -> Status {
    let ours = exe.to_string_lossy();
    let held: Vec<(String, Option<String>)> = HANDLER_KEYS
        .iter()
        .map(|key| {
            let handler = read_sz(&full(root, key), DEFAULT_VALUE)
                .ok()
                .flatten()
                .and_then(|c| handler_exe(&c));
            (key.to_string(), handler)
        })
        .collect();

    let applied: Vec<String> = held
        .iter()
        .filter(|(_, h)| h.as_deref().is_some_and(|h| same_path(h, &ours)))
        .map(|(k, _)| k.clone())
        .collect();
    if applied.len() == HANDLER_KEYS.len() {
        return Status::Applied;
    }
    if held.iter().all(|(_, h)| h.is_none()) {
        return Status::NotApplied;
    }
    if applied.is_empty() {
        if let Some(first) = held[0].1.as_deref() {
            if held
                .iter()
                .all(|(_, h)| h.as_deref().is_some_and(|h| same_path(h, first)))
            {
                return Status::AppliedToOther {
                    exe: first.to_string(),
                };
            }
        }
    }
    Status::PartiallyApplied { applied }
}

/// A build output or a temp / download folder is not a place to register an exe from.
pub fn is_stable_path(exe: &Path) -> bool {
    const UNSTABLE: [&str; 4] = ["target", "temp", "tmp", "downloads"];
    if exe.starts_with(std::env::temp_dir()) {
        return false;
    }
    !exe.components().any(|c| {
        let s = c.as_os_str().to_string_lossy().to_ascii_lowercase();
        UNSTABLE.contains(&s.as_str())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The uninstaller (`nsis-hooks.nsh`) must drop exactly the keys `apply` writes, and the
    /// Run value `startup` writes, or an uninstall leaves Win+E pointing at a deleted exe.
    #[test]
    fn nsis_uninstall_hook_removes_exactly_the_keys_apply_writes() {
        let nsh = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/nsis-hooks.nsh"))
            .expect("nsis-hooks.nsh");
        let called: Vec<String> = nsh
            .lines()
            .filter_map(|l| l.trim().strip_prefix("!insertmacro TROVE_DROP_HANDLER \""))
            .map(|rest| rest.split('"').next().unwrap().to_string())
            .collect();
        let expected: Vec<String> = HANDLER_KEYS.iter().map(|k| k.to_string()).collect();
        assert_eq!(called, expected);
        assert!(nsh.contains(crate::core::startup::RUN_KEY));
        assert!(nsh.contains(&format!("\"{}\"", crate::core::startup::RUN_VALUE)));
        assert!(nsh.contains(crate::core::startup::HIDDEN_ARG));
    }

    #[test]
    fn only_the_direct_build_may_write_the_keys() {
        assert!(allowed(Channel::Direct).is_ok());
        let e = allowed(Channel::Msstore).unwrap_err();
        assert_eq!(e.kind(), ErrorKind::Unsupported);
        assert_eq!(e.to_string(), DEFAULT_HANDLER_UNAVAILABLE);
    }

    #[test]
    fn command_line_quotes_the_exe_and_the_argument() {
        assert_eq!(
            command_line(Path::new(r"D:\Apps\trove.exe")),
            r#""D:\Apps\trove.exe" "%1""#
        );
    }

    // Windows-only: these parse and judge registry command lines and `.exe` paths written by
    // the Windows default-file-manager feature; a drive-letter path is one opaque file name on
    // Unix, so the expectations only mean something there.
    #[cfg(windows)]
    #[test]
    fn handler_exe_reads_our_form_and_ignores_explorer_and_no_argument() {
        assert_eq!(
            handler_exe(r#""D:\Apps\x.exe" "%1""#).as_deref(),
            Some(r"D:\Apps\x.exe")
        );
        assert_eq!(handler_exe(r#""C:\Windows\explorer.exe" "%1""#), None);
        assert_eq!(handler_exe(r#""D:\Apps\x.exe""#), None);
        assert_eq!(handler_exe(""), None);
        assert_eq!(handler_exe("notepad.exe %1"), None);
    }

    // Windows-only: these parse and judge registry command lines and `.exe` paths written by
    // the Windows default-file-manager feature; a drive-letter path is one opaque file name on
    // Unix, so the expectations only mean something there.
    #[cfg(windows)]
    #[test]
    fn stable_paths_exclude_build_temp_and_download_folders() {
        assert!(is_stable_path(Path::new(r"D:\Apps\trove.exe")));
        assert!(is_stable_path(Path::new(
            r"C:\Users\alex\AppData\Local\Programs\Otter\otter.exe"
        )));
        assert!(!is_stable_path(Path::new(
            r"D:\08_TauriProjects\explorer-tauri\src-tauri\target\release\trove.exe"
        )));
        assert!(!is_stable_path(Path::new(
            r"C:\Users\alex\Downloads\trove.exe"
        )));
        assert!(!is_stable_path(Path::new(
            r"C:\Users\alex\AppData\Local\Temp\x.exe"
        )));
        assert!(!is_stable_path(&std::env::temp_dir().join("x.exe")));
    }

    #[test]
    fn status_serializes_with_a_kind_tag() {
        let s = serde_json::to_string(&Status::PartiallyApplied {
            applied: vec!["a".into()],
        })
        .unwrap();
        assert_eq!(s, r#"{"kind":"partially-applied","applied":["a"]}"#);
        assert_eq!(
            serde_json::to_string(&Status::NotApplied).unwrap(),
            r#"{"kind":"not-applied"}"#
        );
        assert_eq!(
            serde_json::to_string(&Status::AppliedToOther { exe: "x".into() }).unwrap(),
            r#"{"kind":"applied-to-other","exe":"x"}"#
        );
    }
}

/// Live tests against a throw-away key under `HKCU\Software\trove-test`, deleted on
/// drop. `HKCU\Software\Classes` is never touched here.
#[cfg(all(test, windows))]
mod live_tests {
    use super::*;

    struct Scratch {
        root: String,
        dir: PathBuf,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Scratch {
        fn new(tag: &str) -> Scratch {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            let id = format!("{tag}-{}-{nanos}", std::process::id());
            let dir = std::env::temp_dir().join(format!("trove-default-{id}"));
            std::fs::create_dir_all(&dir).unwrap();
            Scratch {
                root: format!("Software\\trove-test\\{id}"),
                dir,
                _lock: crate::core::registry::tests::scratch_lock(),
            }
        }
        fn backup(&self) -> PathBuf {
            self.dir.join(BACKUP_FILE)
        }
        fn read(&self, key: &str, name: &str) -> Option<String> {
            read_sz(&full(&self.root, key), name).unwrap()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = delete_tree(&self.root);
            let _ = delete_key_if_empty("Software\\trove-test");
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn exe() -> PathBuf {
        PathBuf::from(r"D:\Apps\trove.exe")
    }

    #[test]
    fn apply_on_empty_keys_writes_all_four_and_a_backup() {
        let s = Scratch::new("apply");
        apply(&s.root, &exe(), &s.backup()).unwrap();
        for key in HANDLER_KEYS {
            assert_eq!(s.read(key, DEFAULT_VALUE).unwrap(), command_line(&exe()));
            assert_eq!(s.read(key, DELEGATE_EXECUTE).as_deref(), Some(""));
        }
        let backup = read_backup(&s.backup()).unwrap();
        assert_eq!(backup.entries.len(), 4);
        assert!(backup
            .entries
            .iter()
            .all(|e| !e.existed && e.default.is_none()));
        assert_eq!(status(&s.root, &exe()), Status::Applied);
    }

    #[test]
    fn status_reports_the_four_states() {
        let s = Scratch::new("status");
        assert_eq!(status(&s.root, &exe()), Status::NotApplied);

        apply(&s.root, &exe(), &s.backup()).unwrap();
        assert_eq!(status(&s.root, &exe()), Status::Applied);

        // one key changed by hand → partially applied, naming the other three
        write_sz(
            &full(&s.root, HANDLER_KEYS[1]),
            DEFAULT_VALUE,
            r#""C:\other\app.exe" "%1""#,
        )
        .unwrap();
        let st = status(&s.root, &exe());
        let Status::PartiallyApplied { applied } = st else {
            panic!("expected partial, got {st:?}");
        };
        assert_eq!(applied.len(), 3);
        assert!(!applied.contains(&HANDLER_KEYS[1].to_string()));

        // all four at another exe → applied to other
        for key in HANDLER_KEYS {
            write_sz(
                &full(&s.root, key),
                DEFAULT_VALUE,
                r#""C:\other\app.exe" "%1""#,
            )
            .unwrap();
        }
        assert_eq!(
            status(&s.root, &exe()),
            Status::AppliedToOther {
                exe: r"C:\other\app.exe".into()
            }
        );

        // a key handed back to Explorer's own delegation counts as unset
        for key in HANDLER_KEYS {
            write_sz(
                &full(&s.root, key),
                DEFAULT_VALUE,
                r#""C:\Windows\explorer.exe" "%1""#,
            )
            .unwrap();
        }
        assert_eq!(status(&s.root, &exe()), Status::NotApplied);
    }

    #[test]
    fn status_compares_the_exe_path_case_insensitively() {
        let s = Scratch::new("case");
        apply(&s.root, &exe(), &s.backup()).unwrap();
        assert_eq!(
            status(&s.root, Path::new(r"d:\apps\TROVE.EXE")),
            Status::Applied
        );
    }

    #[test]
    fn revert_after_apply_on_empty_keys_removes_them_and_the_backup() {
        let s = Scratch::new("revert-empty");
        apply(&s.root, &exe(), &s.backup()).unwrap();
        revert(&s.root, &s.backup()).unwrap();
        for key in HANDLER_KEYS {
            assert!(!key_exists(&full(&s.root, key)), "{key} should be gone");
            let verb = Path::new(key).parent().unwrap();
            assert!(!key_exists(&full(&s.root, &verb.to_string_lossy())));
            let shell = verb.parent().unwrap();
            assert!(!key_exists(&full(&s.root, &shell.to_string_lossy())));
        }
        assert!(!s.backup().exists());
        assert_eq!(status(&s.root, &exe()), Status::NotApplied);
    }

    #[test]
    fn revert_restores_prior_values_exactly_and_keeps_siblings() {
        let s = Scratch::new("revert-prior");
        // two keys pre-exist: one with a command and a DelegateExecute, one with only a default
        let clsid = full(&s.root, HANDLER_KEYS[0]);
        write_sz(&clsid, DEFAULT_VALUE, "").unwrap();
        write_sz(
            &clsid,
            DELEGATE_EXECUTE,
            "{11dbb47c-a525-400b-9e80-a54615a090c0}",
        )
        .unwrap();
        let dir = full(&s.root, HANDLER_KEYS[1]);
        write_sz(&dir, DEFAULT_VALUE, r#""C:\other\app.exe" "%1""#).unwrap();
        // a sibling verb that must survive
        let sibling = full(&s.root, r"Directory\shell\print\command");
        write_sz(&sibling, DEFAULT_VALUE, "print").unwrap();

        apply(&s.root, &exe(), &s.backup()).unwrap();
        assert_eq!(status(&s.root, &exe()), Status::Applied);
        revert(&s.root, &s.backup()).unwrap();

        assert_eq!(s.read(HANDLER_KEYS[0], DEFAULT_VALUE).as_deref(), Some(""));
        assert_eq!(
            s.read(HANDLER_KEYS[0], DELEGATE_EXECUTE).as_deref(),
            Some("{11dbb47c-a525-400b-9e80-a54615a090c0}")
        );
        assert_eq!(
            s.read(HANDLER_KEYS[1], DEFAULT_VALUE).as_deref(),
            Some(r#""C:\other\app.exe" "%1""#)
        );
        assert_eq!(s.read(HANDLER_KEYS[1], DELEGATE_EXECUTE), None);
        assert!(!key_exists(&full(&s.root, HANDLER_KEYS[2])));
        assert!(!key_exists(&full(&s.root, HANDLER_KEYS[3])));
        assert!(key_exists(&sibling));
        assert!(!s.backup().exists());
    }

    #[test]
    fn a_second_apply_keeps_the_first_backup() {
        let s = Scratch::new("twice");
        let dir = full(&s.root, HANDLER_KEYS[1]);
        write_sz(&dir, DEFAULT_VALUE, "prior").unwrap();
        apply(&s.root, &exe(), &s.backup()).unwrap();
        let first = read_backup(&s.backup()).unwrap();
        apply(&s.root, Path::new(r"E:\moved\trove.exe"), &s.backup()).unwrap();
        assert_eq!(read_backup(&s.backup()).unwrap(), first);
        revert(&s.root, &s.backup()).unwrap();
        assert_eq!(
            s.read(HANDLER_KEYS[1], DEFAULT_VALUE).as_deref(),
            Some("prior")
        );
    }

    #[test]
    fn revert_without_a_backup_is_a_not_found_error() {
        let s = Scratch::new("nobackup");
        let e = revert(&s.root, &s.backup()).unwrap_err();
        assert_eq!(e.kind(), ErrorKind::NotFound);
        assert!(e.to_string().contains("nothing to revert"));
    }
}

//! The index's settings (plan 21C.5): on or off, which drives, which folders to skip, and
//! "Forget" (delete what the index saved on disk).
//!
//! The frontend owns the values (`state/settings.svelte.ts`, saved in `settings.json`); this
//! file reads them back as `IndexSettings` so `core/index` can honour them. It never touches the
//! running index: Forget removes the saved files only, the table in memory stays until restart.

use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::core::index::{drives, Index};
use crate::core::settings;

/// The folder under the app data folder where the index saves its files. The NSIS uninstaller
/// deletes the same folder (`nsis-hooks.nsh`).
pub const INDEX_DIR: &str = "index";

/// What the person chose, read from `settings.json`. A missing or bad field is the default:
/// on, every fixed local drive, no extra skipped folders.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexSettings {
    /// the whole index; off means no walk, no watcher, no saved file read
    pub on: bool,
    /// drive roots (`D:\`) the person turned off, case-folded; a new drive is on until turned off
    drives_off: Vec<String>,
    /// whole folders added to the built-in skip list (`Skip::defaults`)
    pub skip_folders: Vec<PathBuf>,
}

impl Default for IndexSettings {
    fn default() -> Self {
        IndexSettings {
            on: true,
            drives_off: Vec::new(),
            skip_folders: Vec::new(),
        }
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn fold(root: &str) -> String {
    root.trim_end_matches(['\\', '/']).to_lowercase()
}

impl IndexSettings {
    /// From the parsed `settings.json` (`Null` for a new install).
    pub fn from_value(saved: &Value) -> Self {
        IndexSettings {
            on: saved["indexOn"].as_bool().unwrap_or(true),
            drives_off: strings(&saved["indexDrivesOff"])
                .iter()
                .map(|d| fold(d))
                .collect(),
            skip_folders: strings(&saved["indexSkipFolders"])
                .into_iter()
                .map(PathBuf::from)
                .collect(),
        }
    }

    /// Read from the config folder; anything unreadable is the defaults.
    pub fn load(config_dir: &Path) -> Self {
        settings::read(config_dir)
            .map(|v| Self::from_value(&v))
            .unwrap_or_default()
    }

    /// Whether this drive root (`D:\`) is indexed.
    pub fn drive_wanted(&self, root: &Path) -> bool {
        self.on && !self.drives_off.contains(&fold(&root.to_string_lossy()))
    }

    /// The fixed local drives that are on (`drives::fixed_local` minus the ones turned off).
    pub fn drives(&self) -> Vec<PathBuf> {
        drives::fixed_local()
            .into_iter()
            .filter(|d| self.drive_wanted(d))
            .collect()
    }
}

/// The saved index folder.
pub fn index_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(INDEX_DIR))
        .map_err(|e| e.to_string())
}

/// The settings now, for `core/index` to read when it starts and when the person changes them.
pub fn current(app: &AppHandle) -> IndexSettings {
    app.path()
        .app_config_dir()
        .map(|d| IndexSettings::load(&d))
        .unwrap_or_default()
}

/// Delete every file under `dir` and what it holds; `dir` itself stays. Returns the bytes freed.
/// A missing folder is nothing to forget (`0`).
pub fn forget_files(dir: &Path) -> io::Result<u64> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut freed = 0;
    for entry in entries {
        let path = entry?.path();
        if path.is_dir() {
            freed += size_of(&path);
            std::fs::remove_dir_all(&path)?;
        } else {
            freed += path.metadata().map_or(0, |m| m.len());
            std::fs::remove_file(&path)?;
        }
    }
    Ok(freed)
}

/// Bytes in every file under `dir`; a missing folder is 0.
pub fn size_of(dir: &Path) -> u64 {
    std::fs::read_dir(dir).map_or(0, |entries| {
        entries
            .flatten()
            .map(|e| {
                let p = e.path();
                if p.is_dir() {
                    size_of(&p)
                } else {
                    p.metadata().map_or(0, |m| m.len())
                }
            })
            .sum()
    })
}

/// A drive the person can switch on or off.
#[derive(Serialize)]
pub struct IndexDrive {
    /// `D:\`
    pub root: String,
}

#[tauri::command(async)]
pub fn index_drives() -> Vec<IndexDrive> {
    drives::fixed_local()
        .into_iter()
        .map(|d| IndexDrive {
            root: d.to_string_lossy().into_owned(),
        })
        .collect()
}

/// Bytes the saved index takes on disk.
#[tauri::command(async)]
pub fn index_disk_size(app: AppHandle) -> Result<u64, String> {
    Ok(size_of(&index_dir(&app)?))
}

/// Forget: delete the saved index files. Returns the bytes freed.
#[tauri::command(async)]
pub fn index_forget(app: AppHandle, index: State<Index>) -> Result<u64, String> {
    // empty the running index first: its 10-minute save and its exit save would write it back
    index.forget();
    forget_files(&index_dir(&app)?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "trove-index-settings-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn forget_removes_index_files() {
        let dir = temp("forget");
        std::fs::write(dir.join("home.trvi"), b"12345").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("d.trvi"), b"123").unwrap();
        assert_eq!(size_of(&dir), 8);
        assert_eq!(forget_files(&dir).unwrap(), 8);
        assert!(dir.exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forget_of_a_missing_folder_is_nothing() {
        let dir = temp("missing").join("nope");
        assert_eq!(forget_files(&dir).unwrap(), 0);
    }

    #[test]
    fn a_new_install_is_on_with_every_drive_and_no_extra_skips() {
        let s = IndexSettings::from_value(&Value::Null);
        assert!(s.on);
        assert!(s.skip_folders.is_empty());
        assert!(s.drive_wanted(Path::new("D:\\")));
    }

    #[test]
    fn saved_choices_are_read_back() {
        let s = IndexSettings::from_value(&json!({
            "indexOn": true,
            "indexDrivesOff": ["d:\\", 5, ""],
            "indexSkipFolders": ["C:\\Games", "  ", 7],
        }));
        assert!(!s.drive_wanted(Path::new("D:\\")));
        assert!(s.drive_wanted(Path::new("C:\\")));
        assert_eq!(s.skip_folders, vec![PathBuf::from("C:\\Games")]);
    }

    #[test]
    fn off_means_no_drive_is_wanted() {
        let s = IndexSettings::from_value(&json!({ "indexOn": false }));
        assert!(!s.drive_wanted(Path::new("C:\\")));
        assert!(s.drives().is_empty());
    }

    #[test]
    fn a_wrong_typed_on_flag_falls_back_to_on() {
        assert!(IndexSettings::from_value(&json!({ "indexOn": "no" })).on);
    }
}

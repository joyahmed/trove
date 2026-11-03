//! Settings persisted as one JSON file under %APPDATA%\<identifier>\settings.json. The
//! frontend owns the shape (it is an opaque JSON value here); Rust only reads and writes it
//! atomically so a crash mid-write never leaves a half file.

use std::io::Result;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// One writer at a time. ⚠️ Every window can now save (`merge`), and the temp file is named by
/// process id alone, so two writes overlapping inside this process would share one temp file and
/// could rename a half-written one into place. Held across the read and the write of `merge`
/// too, so two windows' changes are both kept rather than the later one's read missing the
/// earlier one's write.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub const FILE_NAME: &str = "settings.json";
/// The identifier the app had before it was named Trove; its config folder is read once.
pub const OLD_IDENTIFIER: &str = "com.joyahmed.explorer";
/// What moves along with the settings on the rename (the set-as-default backup).
/// Settings go last: its presence in the new folder is what marks the migration as done, so a
/// failure part-way leaves no settings file and the next start tries again.
const MIGRATED_FILES: [&str; 2] = ["default-backup.json", FILE_NAME];

/// Carry the files over from the pre-rename config folder, once: only when `new_dir` has no
/// settings file yet and `old_dir` has one. The old folder is left as it was. Each file is
/// copied to a temp name and renamed, so a failed copy never leaves a partial file behind.
pub fn migrate_from(old_dir: &Path, new_dir: &Path) -> Result<bool> {
    if new_dir.join(FILE_NAME).exists() || !old_dir.join(FILE_NAME).exists() {
        return Ok(false);
    }
    std::fs::create_dir_all(new_dir)?;
    for name in MIGRATED_FILES {
        let from = old_dir.join(name);
        if from.exists() {
            let to = new_dir.join(name);
            let tmp = tmp_path(&to);
            let done = std::fs::copy(&from, &tmp).and_then(|_| std::fs::rename(&tmp, &to));
            if let Err(e) = done {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }
    Ok(true)
}

/// A UTF-8 byte order mark, which old Notepad puts at the start of a saved file.
const BOM: &[u8] = b"\xEF\xBB\xBF";

/// Read the settings. A missing file is `Null` (a new install). A file that exists but is not
/// a JSON object is kept as `settings.json.corrupt-<unix seconds>` and also reads as `Null`, so
/// the app starts but the next save cannot destroy the only copy of what the user had.
pub fn read(dir: &Path) -> Result<serde_json::Value> {
    let path = dir.join(FILE_NAME);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::Value::Null),
        Err(e) => return Err(e),
    };
    let body = bytes.strip_prefix(BOM).unwrap_or(&bytes);
    match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(v) if v.is_object() => Ok(v),
        _ => {
            back_up_corrupt(&path);
            Ok(serde_json::Value::Null)
        }
    }
}

/// Move the unreadable file aside (copy if the rename is refused) and say where it went.
fn back_up_corrupt(path: &Path) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let backup = path.with_extension(format!("json.corrupt-{secs}"));
    match std::fs::rename(path, &backup).or_else(|_| std::fs::copy(path, &backup).map(|_| ())) {
        Ok(()) => {
            log::warn!("settings: the file is not valid settings; kept a .corrupt copy");
            log::debug!(
                "settings: {} is not valid settings; kept as {}",
                path.display(),
                backup.display()
            );
        }
        Err(e) => {
            log::warn!("settings: the file is not valid settings and could not be backed up: {e}");
            log::debug!(
                "settings: {} is not valid settings and could not be backed up to {}: {e}",
                path.display(),
                backup.display()
            );
        }
    }
}

/// Write via a temp file + rename, so readers see the old file or the new one, never a torn one.
pub fn write(dir: &Path, value: &serde_json::Value) -> Result<()> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write_unlocked(dir, value)
}

/// Write only the fields in `patch` (a JSON object), keeping every other field the file has.
/// This is how a window that is not `main` saves: it holds no authority over the rest of the
/// file, which may have changed under it since it loaded. A missing or unreadable file starts
/// from an empty object; a `patch` that is not an object writes nothing.
pub fn merge(dir: &Path, patch: &serde_json::Value) -> Result<()> {
    let Some(fields) = patch.as_object() else {
        return Ok(());
    };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut value = match read(dir)? {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    for (key, field) in fields {
        value.insert(key.clone(), field.clone());
    }
    write_unlocked(dir, &serde_json::Value::Object(value))
}

fn write_unlocked(dir: &Path, value: &serde_json::Value) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let target = dir.join(FILE_NAME);
    let tmp = tmp_path(&target);
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&tmp, &target)
}

fn tmp_path(target: &Path) -> PathBuf {
    target.with_extension(format!("json.{}.tmp", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One dir per test: cargo runs tests in parallel threads of one process, so a dir keyed
    /// only by pid is shared and one test's `remove_dir_all` races the other's write.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("trove-settings-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_file_reads_as_null_and_round_trips() {
        let dir = scratch("round-trip");
        assert_eq!(read(&dir).unwrap(), serde_json::Value::Null);
        let v = json!({ "view": "details", "columns": { "name": 245 } });
        write(&dir, &v).unwrap();
        assert_eq!(read(&dir).unwrap(), v);
        assert!(!tmp_path(&dir.join(FILE_NAME)).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn merge_keeps_the_fields_it_was_not_given() {
        let dir = scratch("merge");
        // no file yet: the patch alone
        merge(&dir, &json!({ "theme": "dark" })).unwrap();
        assert_eq!(read(&dir).unwrap(), json!({ "theme": "dark" }));
        write(
            &dir,
            &json!({ "view": "grid", "pins": ["/a"], "theme": "dark" }),
        )
        .unwrap();
        merge(&dir, &json!({ "theme": "light", "showHidden": true })).unwrap();
        assert_eq!(
            read(&dir).unwrap(),
            json!({ "view": "grid", "pins": ["/a"], "theme": "light", "showHidden": true })
        );
        // not an object: nothing written
        merge(&dir, &json!(["x"])).unwrap();
        assert_eq!(read(&dir).unwrap()["theme"], json!("light"));
        assert!(!tmp_path(&dir.join(FILE_NAME)).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_file_reads_as_null_not_an_error() {
        let dir = scratch("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), b"{ not json").unwrap();
        assert_eq!(read(&dir).unwrap(), serde_json::Value::Null);
        assert_eq!(backups(&dir), vec![b"{ not json".to_vec()]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The bytes of every `settings.json.corrupt-*` file in `dir`.
    fn backups(dir: &Path) -> Vec<Vec<u8>> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("settings.json.corrupt-")
            })
            .map(|e| std::fs::read(e.path()).unwrap())
            .collect()
    }

    #[test]
    fn a_bom_file_loads_its_values() {
        let dir = scratch("bom");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), b"\xEF\xBB\xBF{\"view\":\"grid\"}").unwrap();
        assert_eq!(read(&dir).unwrap(), json!({ "view": "grid" }));
        assert!(backups(&dir).is_empty());
        assert!(dir.join(FILE_NAME).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_non_object_file_is_backed_up() {
        let dir = scratch("non-object");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), b"[]").unwrap();
        assert_eq!(read(&dir).unwrap(), serde_json::Value::Null);
        assert_eq!(backups(&dir), vec![b"[]".to_vec()]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_rename_migrates_settings_and_the_backup_once() {
        let old = scratch("migrate-old");
        let new = scratch("migrate-new");
        // nothing on either side → nothing to do
        assert!(!migrate_from(&old, &new).unwrap());
        write(&old, &json!({ "view": "grid" })).unwrap();
        std::fs::write(old.join("default-backup.json"), b"{}").unwrap();
        assert!(migrate_from(&old, &new).unwrap());
        assert_eq!(read(&new).unwrap(), json!({ "view": "grid" }));
        assert!(new.join("default-backup.json").exists());
        assert!(old.join(FILE_NAME).exists(), "the old folder is left alone");
        // a second run is a no-op even if the old file changed
        write(&old, &json!({ "view": "list" })).unwrap();
        assert!(!migrate_from(&old, &new).unwrap());
        assert_eq!(read(&new).unwrap(), json!({ "view": "grid" }));
        std::fs::remove_dir_all(old).unwrap();
        std::fs::remove_dir_all(new).unwrap();
    }
}

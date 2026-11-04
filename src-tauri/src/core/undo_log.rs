//! The undo history, saved as one JSON file beside settings.json (`undo.json`), so Ctrl+Z
//! still works after Trove restarts (plan 08 F2). The frontend owns the shape and checks every
//! entry when it reads it back (`utils/undo-records.ts`); Rust only reads and writes the file,
//! atomically, so a crash mid-write never leaves half a history.

use std::io::Result;
use std::path::Path;
use std::sync::Mutex;

pub const FILE_NAME: &str = "undo.json";

/// One writer at a time: the temp file is named by process id alone.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The saved history, or `Null` when there is none or it cannot be read as JSON. A lost undo
/// history costs nothing a user can see beyond the history itself, so a bad file is not kept.
pub fn read(dir: &Path) -> serde_json::Value {
    std::fs::read(dir.join(FILE_NAME))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// Written to a temp file and renamed (as `session::write`), so a crash never leaves half a file.
pub fn write(dir: &Path, value: &serde_json::Value) -> Result<()> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(dir)?;
    let target = dir.join(FILE_NAME);
    let tmp = target.with_extension(format!("json.{}.tmp", std::process::id()));
    let written = std::fs::write(&tmp, serde_json::to_vec(value)?)
        .and_then(|()| std::fs::rename(&tmp, &target));
    if written.is_err() {
        // a failed write or rename must not leave a stray temp file behind
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("trove-undo-log-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn what_is_written_reads_back_the_same() {
        let dir = scratch("round");
        let log = json!({
            "version": 1,
            "entries": [{ "label": "Rename", "at": 5, "record": { "kind": "rename", "from": "C:\\a", "to": "C:\\b" } }]
        });
        write(&dir, &log).unwrap();
        assert_eq!(read(&dir), log);
        assert_eq!(files(&dir), vec![FILE_NAME], "no temp file is left over");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_file_is_null() {
        let dir = scratch("missing");
        assert_eq!(read(&dir), serde_json::Value::Null);
    }

    #[test]
    fn a_corrupt_file_is_null() {
        let dir = scratch("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), b"{\"version\": 1, \"entries\": [").unwrap();
        assert_eq!(read(&dir), serde_json::Value::Null);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_write_leaves_no_temp_file() {
        let dir = scratch("tmp");
        std::fs::create_dir_all(dir.join(FILE_NAME)).unwrap(); // a folder where the file goes
        assert!(write(&dir, &json!({ "version": 1, "entries": [] })).is_err());
        assert_eq!(files(&dir), vec![FILE_NAME], "only the blocking folder");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

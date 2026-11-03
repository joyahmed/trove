use std::path::Path;

use super::archive::INNER_SEP;
use crate::core::preview::{self, TextHead, TEXT_HEAD_BYTES};

/// The first 64 KB of a text file for the preview pane.
#[tauri::command(async)]
pub fn read_text_head(path: String, max_bytes: Option<u64>) -> Result<TextHead, String> {
    refuse_archive_row(&path)?;
    preview::read_text_head(Path::new(&path), max_bytes.unwrap_or(TEXT_HEAD_BYTES))
        .map_err(|e| read_failed("read_text_head", &path, &e))
}

/// The name a sentence calls `path` by: its last part, inside an archive or out.
fn name_of(path: &str) -> &str {
    path.rsplit(['/', '\\', INNER_SEP])
        .find(|s| !s.is_empty())
        .unwrap_or(path)
}

/// A row inside an archive (`archive + "\0" + inner`, `read_archive_dir`) has no file on disk.
/// Handed to the OS it fails with `file name contained an unexpected NUL byte` (or Windows'
/// `strings passed to WinAPI cannot contain NULs`), which used to reach the preview pane as
/// is. Refused here, before any OS call, with a sentence.
pub fn refuse_archive_row(path: &str) -> Result<(), String> {
    if !path.contains(INNER_SEP) {
        return Ok(());
    }
    log::warn!("archive row given to a real-path command");
    log::debug!("archive row given to a real-path command: {path:?}");
    Err(format!(
        "\"{}\" is inside an archive, so Trove can't read it as a file.",
        name_of(path)
    ))
}

/// The sentence for a read that failed (`op` names the command for the log). The raw OS
/// text goes to the log only, as `open_failed` in `commands/fs.rs` does for an open.
pub fn read_failed(op: &str, path: &str, err: &std::io::Error) -> String {
    use std::io::ErrorKind;
    log::warn!("{op}: {err}");
    log::debug!("{op} {path}: {err}");
    let name = name_of(path);
    match err.kind() {
        ErrorKind::NotFound => format!("\"{name}\" is no longer there."),
        ErrorKind::PermissionDenied => format!("Trove can't read \"{name}\": access is denied."),
        _ => format!("Couldn't read \"{name}\"."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn an_archive_row_is_refused_with_a_sentence_not_the_os_error() {
        let row = "C:\\x\\a.zip\u{0}docs/notes.txt";
        let said = read_text_head(row.to_string(), None).unwrap_err();
        assert_eq!(
            said,
            "\"notes.txt\" is inside an archive, so Trove can't read it as a file."
        );
        assert!(!said.contains("NUL"), "{said}");
        // the archive's top-level row, `/` form
        let said = refuse_archive_row("/home/j/a.zip\u{0}b.md").unwrap_err();
        assert!(said.starts_with("\"b.md\" is inside an archive"), "{said}");
        assert!(refuse_archive_row("/home/j/a.zip").is_ok());
    }

    #[test]
    fn a_failed_read_says_a_sentence_without_the_os_text() {
        let p = "/home/j/notes.txt";
        let gone = Error::new(ErrorKind::NotFound, "os error 2 raw");
        assert_eq!(
            read_failed("t", p, &gone),
            "\"notes.txt\" is no longer there."
        );
        let denied = Error::new(ErrorKind::PermissionDenied, "os error 13 raw");
        assert_eq!(
            read_failed("t", p, &denied),
            "Trove can't read \"notes.txt\": access is denied."
        );
        let other = Error::other("disk on fire");
        assert_eq!(read_failed("t", p, &other), "Couldn't read \"notes.txt\".");
        assert_eq!(
            read_failed("t", "C:\\x\\y.log", &other),
            "Couldn't read \"y.log\"."
        );
    }

    #[test]
    fn a_missing_file_reads_as_gone_through_the_command() {
        let said = read_text_head("/no/such/dir/zz-trove-missing.txt".into(), None).unwrap_err();
        assert_eq!(said, "\"zz-trove-missing.txt\" is no longer there.");
    }
}

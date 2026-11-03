//! An archive entry's name becomes a path inside the chosen folder, or it is refused — the
//! zip-slip rule (plan 16, "Zip-slip rule"). Every format runs every entry through here before
//! one byte of it is written.
//!
//! 1. `\` counts as `/` (zips made on Windows); `.` parts are dropped; an absolute name
//!    (`/x`, `C:x`, `C:\x`, `\\srv\x`), a `..` part or an empty name is refused.
//! 2. Each part must be a name Windows can hold (`ops::validate_name`: no `:` — so no alternate
//!    data stream —, no `CON`, no trailing dot or space). Off Windows only NUL is refused.
//! 3. No existing folder between the destination and the target may be a link (symlink,
//!    junction): `a` → `/etc` followed by `a/passwd` must not write into `/etc`. The destination
//!    itself may be a link (a Desktop can be); only what is below it is checked.

use std::io::{Error, ErrorKind, Result};
use std::path::Path;

fn unsafe_path(raw: &str) -> Error {
    Error::new(
        ErrorKind::InvalidInput,
        format!("Unsafe path in archive, skipped: {raw}"),
    )
}

/// The entry's parts after rule 1 and 2, e.g. `a\b/./c.txt` → `["a", "b", "c.txt"]`.
pub fn entry_parts(raw: &str) -> Result<Vec<String>> {
    let s = raw.replace('\\', "/");
    let bytes = s.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if s.starts_with('/') || drive {
        return Err(unsafe_path(raw));
    }
    let mut parts = Vec::new();
    for part in s.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(unsafe_path(raw)),
            name => {
                part_allowed(name).map_err(|_| unsafe_path(raw))?;
                parts.push(name.to_string());
            }
        }
    }
    if parts.is_empty() {
        return Err(unsafe_path(raw));
    }
    Ok(parts)
}

#[cfg(windows)]
fn part_allowed(name: &str) -> Result<()> {
    crate::core::ops::validate_name(name)
}

#[cfg(not(windows))]
fn part_allowed(name: &str) -> Result<()> {
    if name.contains('\0') {
        return Err(Error::from(ErrorKind::InvalidInput));
    }
    Ok(())
}

/// Rule 3: every existing path from just below `dest` down to `target` itself must be a real
/// folder or file, never a link. `target` must be inside `dest` (it always is when it came
/// from `entry_target`).
pub fn refuse_link_ancestor(dest: &Path, target: &Path) -> Result<()> {
    let rel = target
        .strip_prefix(dest)
        .map_err(|_| Error::new(ErrorKind::InvalidInput, "Target outside the destination"))?;
    let mut at = dest.to_path_buf();
    for part in rel.components() {
        at.push(part);
        match std::fs::symlink_metadata(&at) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || crate::core::ops::is_dir_link(&meta) {
                    return Err(Error::new(
                        ErrorKind::InvalidInput,
                        format!(
                            "Unsafe path in archive, skipped: {} goes through a link",
                            rel.display()
                        ),
                    ));
                }
            }
            // nothing there yet: nothing below it exists either
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::archive::test_util::scratch;
    use std::fs;
    use std::path::PathBuf;

    /// `dest` joined with the entry's safe parts (rules 1 and 2). Rule 3 needs the disk:
    /// `refuse_link_ancestor`, called right before the write. The extract engine builds its
    /// target from `entry_parts` itself (a Keep-both top name differs from the entry's); this one
    /// is the rule in one call, for the tests here and the Phase 4 copy-out.
    pub fn entry_target(dest: &Path, raw: &str) -> Result<PathBuf> {
        let mut target = dest.to_path_buf();
        target.extend(entry_parts(raw)?);
        Ok(target)
    }

    #[test]
    fn dot_dot_is_refused() {
        let dest = Path::new("dest");
        for raw in ["../x", "a/../../x", "a\\..\\..\\x", "..", "a/.."] {
            let err = entry_target(dest, raw).unwrap_err();
            assert!(err.to_string().starts_with("Unsafe path"), "{raw}: {err}");
        }
    }

    #[test]
    fn absolute_is_refused() {
        let dest = Path::new("dest");
        for raw in [
            "/etc/x",
            "C:\\x",
            "C:x",
            "c:/x",
            "\\\\srv\\s\\x",
            "//srv/s/x",
        ] {
            assert!(entry_target(dest, raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn empty_and_dot_only_are_refused() {
        let dest = Path::new("dest");
        for raw in ["", ".", "./", "./.", "/", "\\"] {
            assert!(entry_target(dest, raw).is_err(), "{raw:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_reserved_names_are_refused() {
        let dest = Path::new("dest");
        for raw in ["CON", "a/con.txt", "a:b", "x.", "dir /y", "a/b?"] {
            assert!(entry_target(dest, raw).is_err(), "{raw}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_allows_colon() {
        let root = scratch("colon");
        let dest = root.join("a").join("b").join("dest");
        assert_eq!(entry_target(&dest, "ab:c").unwrap(), dest.join("ab:c"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normal_nested_path_lands_inside_dest() {
        let root = scratch("nested");
        let dest = root.join("a").join("b").join("dest");
        let t = entry_target(&dest, "docs\\2024/./report.txt").unwrap();
        assert_eq!(t, dest.join("docs").join("2024").join("report.txt"));
        assert!(t.starts_with(&dest));
        fs::create_dir_all(&dest).unwrap();
        refuse_link_ancestor(&dest, &t).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    fn link_folder(link: &Path, target: &Path) {
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "mklink /J {}", link.display());
    }

    #[cfg(unix)]
    fn link_folder(link: &Path, target: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[test]
    fn a_symlink_ancestor_is_refused() {
        let root = scratch("linkanc");
        let dest = root.join("a").join("b").join("dest");
        let outside = root.join("outside");
        fs::create_dir_all(&dest).unwrap();
        fs::create_dir_all(&outside).unwrap();
        link_folder(&dest.join("ln"), &outside);
        let t = entry_target(&dest, "ln/passwd").unwrap();
        assert!(refuse_link_ancestor(&dest, &t).is_err());
        // the link as the target itself is refused too
        assert!(refuse_link_ancestor(&dest, &dest.join("ln")).is_err());
        // a link AS the destination is allowed: only what is below it is checked
        let t2 = entry_target(&dest.join("ln"), "x.txt").unwrap();
        refuse_link_ancestor(&dest.join("ln"), &t2).unwrap();
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        // a junction / symlink is removed as the link alone, never its target
        crate::core::ops::remove_entry(&dest.join("ln")).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

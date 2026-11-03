//! The Recycle Bin / Trash calls that read and change what is already in it: `list`, `restore_all`
//! and `purge_all`. One import point, because the crate does not offer them everywhere.
//!
//! ⛔ `trash 5.2.9` gates its whole `os_limited` module on `windows` or `unix` **except macOS**
//! (`trash-5.2.9/src/lib.rs:350`), so on a Mac `trash::os_limited::list()` is not an error at run
//! time — it does not compile. Found 2026-10-02 by a `cargo check` on the Mac (plan 10 A.2): 8 of
//! the 10 errors there. Moving a file TO the Trash (`trash::delete_all`) works on all three; it is
//! looking inside the Trash that macOS does not get.
//!
//! The Trash *view* on macOS does not come through here: `recycle_mac` reads `~/.Trash` as a
//! folder, and the undo of a Delete (`restore_from_trash`) does not come through here either: it
//! moves back what `trash_mac` recorded when Trove sent it (`trash_mac::put_back`). What is left on
//! this Mac twin is the undo of a Replace (`undo_replace`, `bin_readable`, `transfer::TrashBin`),
//! which still needs to read the Trash — so it answers with a sentence that says so, rather than an
//! empty list: an empty Trash that is really "I cannot look" is exactly the silent shape plan 8
//! Phase C removed from the Windows bin.

#[cfg(not(target_os = "macos"))]
pub use trash::os_limited::{list, purge_all, restore_all};

#[cfg(target_os = "macos")]
mod mac {
    const WHY: &str = "Trove cannot put items back from the Trash on macOS. Drag them out of the Trash in Finder instead.";

    fn unsupported() -> trash::Error {
        trash::Error::Unknown {
            description: WHY.to_string(),
        }
    }

    pub fn list() -> Result<Vec<trash::TrashItem>, trash::Error> {
        Err(unsupported())
    }

    pub fn restore_all(_items: Vec<trash::TrashItem>) -> Result<(), trash::Error> {
        Err(unsupported())
    }
}

// No `purge_all` here: on macOS the Trash view purges through `recycle_mac`, so nothing would
// call it and Mac clippy (`-D warnings`) refuses the unused item.
#[cfg(target_os = "macos")]
pub use mac::{list, restore_all};

/// A `trash::Error` as a sentence for the screen.
///
/// ⛔ Never `e.to_string()`: the crate's `Display` is `"Error during a `trash` operation: {self:?}"`,
/// so it puts Rust `Debug` text — `Unknown { description: "…" }` — in front of the person. That is
/// what the Mac Trash view showed (2026-10-06). The descriptions inside are already words.
pub fn describe(e: &trash::Error) -> String {
    use trash::Error as E;
    match e {
        E::Unknown { description } | E::Os { description, .. } => description.clone(),
        E::TargetedRoot => "The top folder of a drive cannot be moved to the bin.".to_string(),
        E::CouldNotAccess { target } => format!("Could not reach {target}."),
        E::CanonicalizePath { original } => format!("Could not find {}.", original.display()),
        E::ConvertOsString { original } => format!(
            "A name in the bin is not valid text: {}.",
            original.to_string_lossy()
        ),
        E::RestoreCollision { path, .. } => {
            format!("Something new is already there: {}.", path.display())
        }
        E::RestoreTwins { path, .. } => format!(
            "More than one item in the bin came from {}; restore them one at a time.",
            path.display()
        ),
        #[cfg(all(
            unix,
            not(target_os = "macos"),
            not(target_os = "ios"),
            not(target_os = "android")
        ))]
        E::FileSystem { path, source } => format!("{}: {source}.", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No variant may come out as `Debug` text — no `{`, no variant name, no crate prefix.
    #[test]
    fn every_error_is_a_sentence_not_debug_text() {
        let all = [
            trash::Error::Unknown {
                description: "Some operations were aborted".into(),
            },
            trash::Error::Os {
                code: 5,
                description: "windows error: Access is denied.".into(),
            },
            trash::Error::TargetedRoot,
            trash::Error::CouldNotAccess {
                target: "/x/y".into(),
            },
            trash::Error::CanonicalizePath {
                original: "/x/y".into(),
            },
            trash::Error::ConvertOsString {
                original: "y".into(),
            },
            trash::Error::RestoreCollision {
                path: "/x/y".into(),
                remaining_items: Vec::new(),
            },
            trash::Error::RestoreTwins {
                path: "/x/y".into(),
                items: Vec::new(),
            },
        ];
        for e in &all {
            let s = describe(e);
            assert!(!s.is_empty());
            for bad in ["{", "Unknown", "description:", "trash` operation", "Os {"] {
                assert!(!s.contains(bad), "{s:?} contains {bad:?}");
            }
        }
        assert_eq!(
            describe(&all[0]),
            "Some operations were aborted",
            "the crate's own words are kept"
        );
    }
}

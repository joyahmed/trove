//! The Recycle Bin as a place: what is in it, and restoring or purging items by the id the
//! `trash` crate gives each of them (on Windows the shell's desktop-absolute parsing name).
//! Nothing here touches a path outside the bin.
//!
//! On macOS the `trash` crate cannot look inside the Trash, so the same four calls are answered
//! by `recycle_mac` reading `~/.Trash` as a folder (no Restore there). Errors on every OS are
//! sentences: `trash::Error`'s own `Display` is its `{:?}`, and that once reached the screen as
//! `Unknown { description: … }`.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleItem {
    /// the `trash` crate's item id, lossy — the handle for restore / purge
    pub id: String,
    pub name: String,
    /// the folder the item was deleted from; `None` where the OS does not record it (the macOS
    /// Trash), and then Restore and "Open original location" are not offered
    pub original_parent: Option<String>,
    /// Unix milliseconds
    pub deleted_ms: u64,
    /// `trash` 5.2 does not say whether an item is a folder; the frontend guesses from the
    /// name's extension. Kept in the shape so a later crate can fill it in.
    pub is_dir: bool,
    /// bytes, where known: the macOS Trash fills it in for files; the `trash` crate never does
    pub size: Option<u64>,
}

#[cfg(not(target_os = "macos"))]
use crate::core::os_limited::describe;

#[cfg(not(target_os = "macos"))]
fn from_trash(item: &trash::TrashItem) -> RecycleItem {
    RecycleItem {
        id: item.id.to_string_lossy().into_owned(),
        name: item.name.to_string_lossy().into_owned(),
        original_parent: Some(item.original_parent.to_string_lossy().into_owned()),
        deleted_ms: u64::try_from(item.time_deleted).unwrap_or(0) * 1000,
        is_dir: false,
        size: None,
    }
}

/// Newest first, then by name so the order is stable for equal timestamps.
pub fn sort(items: &mut [RecycleItem]) {
    items.sort_by(|a, b| {
        b.deleted_ms
            .cmp(&a.deleted_ms)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

#[cfg(not(target_os = "macos"))]
/// Everything in the bin, newest first.
pub fn list() -> Result<Vec<RecycleItem>, String> {
    let raw = crate::core::os_limited::list().map_err(|e| describe(&e))?;
    let mut items: Vec<RecycleItem> = raw.iter().map(from_trash).collect();
    sort(&mut items);
    Ok(items)
}

#[cfg(not(target_os = "macos"))]
/// The crate's items whose id is one of `ids`; an id no longer in the bin is an error naming it.
fn select(ids: &[String]) -> Result<Vec<trash::TrashItem>, String> {
    let raw = crate::core::os_limited::list().map_err(|e| describe(&e))?;
    let wanted: Vec<trash::TrashItem> = raw
        .into_iter()
        .filter(|item| ids.iter().any(|id| *id == item.id.to_string_lossy()))
        .collect();
    let missing: Vec<&String> = ids
        .iter()
        .filter(|id| !wanted.iter().any(|item| item.id.to_string_lossy() == **id))
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "Not in the Recycle Bin any more: {}",
            missing
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    Ok(wanted)
}

#[cfg(not(target_os = "macos"))]
/// Put the items back where they were deleted from.
pub fn restore(ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    crate::core::os_limited::restore_all(select(ids)?).map_err(|e| describe(&e))
}

#[cfg(not(target_os = "macos"))]
/// Purge, then say what the shell skipped.
///
/// `purge_all` drives `IFileOperation` with `FOF_NO_UI`, which folds in `FOF_NOERRORUI`: an
/// item the shell cannot delete — one a running program still holds open — is passed over in
/// silence and the call still returns `Ok`. Explorer puts a dialog on that; without this check
/// Trove reports success, re-lists, and the person sees the same rows they just asked to be
/// rid of, with nothing said. So the bin is read back and the survivors are named.
fn purge_items(items: Vec<trash::TrashItem>) -> Result<(), String> {
    let ids: Vec<String> = items
        .iter()
        .map(|item| item.id.to_string_lossy().into_owned())
        .collect();
    crate::core::os_limited::purge_all(items).map_err(|e| describe(&e))?;
    let left: Vec<String> = crate::core::os_limited::list()
        .map_err(|e| describe(&e))?
        .iter()
        .filter(|item| ids.iter().any(|id| *id == item.id.to_string_lossy()))
        .map(|item| item.name.to_string_lossy().into_owned())
        .collect();
    // Separates "purged 12" from "purged 0" — the `ok` at the command boundary cannot.
    // ⛔ Counts only: `left` holds names, and a name is personal (A.4 of the log's privacy rule).
    log::info!(
        "recycle purge: {} item(s) asked for, {} still in the bin",
        ids.len(),
        left.len()
    );
    if left.is_empty() {
        return Ok(());
    }
    // a bin full of locked items must not turn into a paragraph
    let shown: Vec<&str> = left.iter().take(3).map(String::as_str).collect();
    let more = left.len() - shown.len();
    Err(format!(
        "Could not delete {} — a running program still has {} open: {}{}",
        if left.len() == 1 {
            "1 item".to_string()
        } else {
            format!("{} items", left.len())
        },
        if left.len() == 1 { "it" } else { "them" },
        shown.join(", "),
        if more > 0 {
            format!(" and {more} more")
        } else {
            String::new()
        }
    ))
}

#[cfg(not(target_os = "macos"))]
/// Delete the items for good.
pub fn purge(ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    purge_items(select(ids)?)
}

#[cfg(not(target_os = "macos"))]
/// Delete everything in the bin for good; returns how many items were purged.
///
/// ⚠️ **The count is the return value, not just a log line.** `Ok(())` used to cover two
/// different things — "I purged everything" and "the shell's enumeration handed me nothing, so
/// I did nothing" — and the caller could not tell them apart, which is the exact shape of the
/// report this whole path exists for ("I emptied it and the rows are still there"). A read that
/// *fails* was always an `Err` (the `?` below), so the missing distinction was never
/// empty-vs-unreadable; it was **empty-vs-did-the-work**, and `Ok(0)` is now that distinction.
pub fn empty() -> Result<usize, String> {
    let raw = crate::core::os_limited::list().map_err(|e| describe(&e))?;
    let count = raw.len();
    // ⭐ The decisive line. A `0` here while rows are on screen would prove the shell's own
    // enumeration came back empty — the one hypothesis for "emptied it, nothing was deleted"
    // that cannot be settled from source. A count says nothing personal (A.4).
    log::info!("recycle empty: the bin lists {count} item(s)");
    if raw.is_empty() {
        return Ok(0);
    }
    // `purge_items` is `Ok` only when nothing was left behind, so on `Ok` all `count` went.
    purge_items(raw).map(|()| count)
}

/// macOS: everything in `~/.Trash` and each volume's Trash, newest modified first.
#[cfg(target_os = "macos")]
pub fn list() -> Result<Vec<RecycleItem>, String> {
    crate::core::recycle_mac::list_in(&crate::core::recycle_mac::trash_dirs()?)
}

/// macOS: the Trash keeps no original location, so there is nothing to restore to.
#[cfg(target_os = "macos")]
pub fn restore(ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    Err(crate::core::recycle_mac::NO_RESTORE.to_string())
}

/// macOS: delete items in the Trash folders for good.
#[cfg(target_os = "macos")]
pub fn purge(ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    crate::core::recycle_mac::purge_in(&crate::core::recycle_mac::trash_dirs()?, ids)
}

/// macOS: empty every Trash folder; returns how many items were purged.
#[cfg(target_os = "macos")]
pub fn empty() -> Result<usize, String> {
    crate::core::recycle_mac::empty_in(&crate::core::recycle_mac::trash_dirs()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, deleted_ms: u64) -> RecycleItem {
        RecycleItem {
            id: format!("id-{name}"),
            name: name.to_string(),
            original_parent: Some(String::from("D:\\scratch")),
            deleted_ms,
            is_dir: false,
            size: None,
        }
    }

    #[test]
    fn sorts_newest_first_then_by_name() {
        let mut items = vec![
            item("b.txt", 10),
            item("a.txt", 10),
            item("old.txt", 5),
            item("new.txt", 20),
        ];
        sort(&mut items);
        let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["new.txt", "a.txt", "b.txt", "old.txt"]);
    }

    /// Lives in the real Recycle Bin for a moment: a uniquely named scratch file is trashed,
    /// found by name, and purged. Nothing else in the bin is touched.
    #[test]
    #[cfg(windows)]
    fn a_trashed_file_is_listed_by_name_and_purged() {
        let name = format!(
            "trove-recycle-test-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        );
        let path = std::env::temp_dir().join(&name);
        std::fs::write(&path, b"bin me").unwrap();
        trash::delete(&path).unwrap();
        assert!(!path.exists());

        let items = list().unwrap();
        let mine: Vec<&RecycleItem> = items.iter().filter(|i| i.name == name).collect();
        assert_eq!(mine.len(), 1, "the scratch file should be in the bin once");
        assert!(mine[0].deleted_ms > 0);

        purge(&[mine[0].id.clone()]).unwrap();
        assert!(list().unwrap().iter().all(|i| i.name != name));
        // an id that is gone is a named error, not a panic
        assert!(purge(&[mine[0].id.clone()]).is_err());
    }

    /// The shell skips what it cannot delete and reports no error (`FOF_NO_UI`). A scratch file
    /// is trashed and then held open with no sharing, so the delete must fail; the item is
    /// named back rather than the purge claiming to have worked.
    #[test]
    #[cfg(windows)]
    fn an_item_the_shell_could_not_delete_is_named_not_swallowed() {
        use std::os::windows::fs::OpenOptionsExt;

        let name = format!(
            "trove-locked-test-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        );
        let path = std::env::temp_dir().join(&name);
        std::fs::write(&path, b"lock me").unwrap();
        trash::delete(&path).unwrap();

        let items = list().unwrap();
        let mine = items.iter().find(|i| i.name == name).unwrap().clone();

        // the id is the `$R…` file in the bin; opened with share mode 0 nothing may delete it
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&mine.id)
            .unwrap();
        let err =
            purge(std::slice::from_ref(&mine.id)).expect_err("a locked item cannot be deleted");
        assert!(err.contains(&name), "the error names the item: {err}");
        assert!(list().unwrap().iter().any(|i| i.name == name));

        drop(lock);
        purge(std::slice::from_ref(&mine.id)).unwrap();
        assert!(list().unwrap().iter().all(|i| i.name != name));
    }
}

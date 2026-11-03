use crate::core::launch::is_recycle_bin_arg;
use crate::core::logging::command_err;
use crate::core::recycle::{self, RecycleItem};
use std::sync::atomic::{AtomicUsize, Ordering};

/// The bin count `recycle_list` last logged. `usize::MAX` = nothing logged yet, so the first call
/// (the user opening the view) always writes a line.
static LAST_LOGGED: AtomicUsize = AtomicUsize::new(usize::MAX);

/// The open bin view re-reads the list every 2 s, so a line per call would fill the log forever.
/// Log when the count differs from the last logged one. Pure, so it is testable.
fn count_changed(last: usize, now: usize) -> bool {
    last != now
}

/// ⚠️ The count is logged, not the names. "emptied the bin, nothing deleted" turned out to be
/// the *list* coming back empty while the files were still there, so how many rows the shell
/// admits to is the number that settles it — and a row count says nothing personal (A.4).
#[tauri::command(async)]
pub fn recycle_list() -> Result<Vec<RecycleItem>, String> {
    let r = command_err("recycle_list", recycle::list());
    if let Ok(items) = &r {
        let n = items.len();
        if count_changed(LAST_LOGGED.swap(n, Ordering::Relaxed), n) {
            log::info!("recycle_list: {n} item(s) in the bin");
        }
    }
    r
}

#[tauri::command(async)]
pub fn recycle_restore(ids: Vec<String>) -> Result<(), String> {
    log::info!("recycle_restore: {} id(s)", ids.len());
    command_err("recycle_restore", recycle::restore(&ids))
}

#[tauri::command(async)]
pub fn recycle_purge(ids: Vec<String>) -> Result<(), String> {
    log::info!("recycle_purge: {} id(s)", ids.len());
    command_err("recycle_purge", recycle::purge(&ids))
}

/// What `recycle_empty` logs for an outcome. Three cases, three lines — a bare `ok` covered the
/// first two and that is what made the log unable to answer "did it delete anything?".
///
/// A pure function of the outcome, so the three lines are testable without emptying the real
/// Recycle Bin. ⛔ A test must never call `recycle::empty()`: it purges the machine's bin.
fn outcome(r: &Result<usize, String>) -> String {
    match r {
        Ok(0) => "ok — the bin listed nothing to delete".to_string(),
        Ok(n) => format!("ok — {n} item(s) purged"),
        Err(_) => "failed".to_string(),
    }
}

/// ⚠️ The bin's own `Ok(())` used to mean either "purged them" or "there was nothing there", and
/// `command_err` only ever logs the failures — so a run that deleted nothing and a run that
/// deleted everything left the same `recycle_empty: ok` behind. A read that failed was already
/// distinct (an `Err`, logged by `command_err`); the count is what separates the other two.
/// The IPC return stays `()` — the frontend's `invoke<void>` is unchanged.
#[tauri::command(async)]
pub fn recycle_empty() -> Result<(), String> {
    log::info!("recycle_empty: asked to empty the bin");
    let r = command_err("recycle_empty", recycle::empty());
    log::info!("recycle_empty: {}", outcome(&r));
    r.map(|_| ())
}

/// Hand a shell folder Trove does not show (`::{CLSID}` other than This PC and the Recycle
/// Bin, or a `shell:` name) to Explorer, which still knows every one of them.
#[cfg(windows)]
#[tauri::command(async)]
pub fn open_in_explorer(arg: String) -> Result<(), String> {
    if is_recycle_bin_arg(&arg) {
        return Err("The Recycle Bin is Trove's own place; nothing to hand to Explorer".into());
    }
    std::process::Command::new("explorer.exe")
        .arg(&arg)
        .spawn()
        .map(drop)
        .map_err(|e| format!("explorer.exe {arg}: {e}"))
}

/// Off Windows there is no Explorer and no shell namespace to hand a `::{CLSID}` or `shell:`
/// name to (the opener plugin cannot start one either), so say so instead of spawning a
/// program that is not there (plan 10, B.2.6).
#[cfg(not(windows))]
#[tauri::command(async)]
pub fn open_in_explorer(arg: String) -> Result<(), String> {
    if is_recycle_bin_arg(&arg) {
        return Err("The Recycle Bin is Trove's own place; nothing to hand to Explorer".into());
    }
    Err(format!(
        "{arg}: Windows shell folders cannot be opened on this system"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unchanged_count_is_not_logged_again() {
        assert!(count_changed(usize::MAX, 0), "first call logs");
        assert!(!count_changed(3, 3));
        assert!(count_changed(3, 4));
    }

    /// ⛔ The regression this guards: `Ok(())` for both an empty bin and a successful purge meant
    /// one `recycle_empty: ok` line covered both, so the log could not say whether anything was
    /// deleted — and "I emptied it and the rows are still there" was unanswerable from the log.
    /// Three outcomes must produce three different lines.
    #[test]
    fn the_three_outcomes_of_emptying_the_bin_each_say_something_different() {
        let nothing_there = outcome(&Ok(0));
        let did_the_work = outcome(&Ok(12));
        let could_not_read = outcome(&Err("the shell would not enumerate the bin".into()));

        assert_ne!(
            nothing_there, did_the_work,
            "an empty bin must not log the same line as a purge"
        );
        assert_ne!(nothing_there, could_not_read);
        assert_ne!(did_the_work, could_not_read);

        // and each says which it was, in words a log reader can grep
        assert!(nothing_there.contains("nothing"), "{nothing_there}");
        assert!(did_the_work.contains("12"), "{did_the_work}");
        assert!(could_not_read.contains("failed"), "{could_not_read}");
        // the success cases still read as success — the frontend's own path is unchanged
        assert!(nothing_there.starts_with("ok"));
        assert!(did_the_work.starts_with("ok"));
    }

    #[test]
    #[cfg(not(windows))]
    fn off_windows_the_explorer_hand_off_is_a_clear_error() {
        let e = open_in_explorer("shell:Downloads".into()).unwrap_err();
        assert!(
            e.contains("shell:Downloads") && e.contains("cannot be opened"),
            "{e}"
        );
    }

    /// A single item is still counted, not special-cased away into the empty line.
    #[test]
    fn one_item_purged_is_not_the_empty_bin_line() {
        assert_ne!(outcome(&Ok(1)), outcome(&Ok(0)));
        assert!(outcome(&Ok(1)).contains('1'));
    }
}

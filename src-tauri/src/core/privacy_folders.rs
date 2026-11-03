//! The folders a Mac guards with a privacy prompt (TCC), and which of them the person has
//! opened in Trove.
//!
//! ⛔ Reading INSIDE one of these — a listing, a size walk, the name index's walk of the home
//! folder — raises "Trove would like to access files in your Downloads folder" (or Documents,
//! Desktop, iCloud Drive, Apple Music, data from other apps). A `stat` of the folder itself
//! does not, so the sidebar may name them freely. On a first launch the name index walked the
//! whole home folder and fired the whole chain of prompts before the person had clicked
//! anything (Mac test, 2026-11-03). So nothing in the background reads inside one until the
//! person has opened it in Trove: their own listing is what asks, once, and from then on the
//! answer is theirs. A folder whose listing worked is remembered (`privacy-opened.json` in the
//! config folder) and the background may read it on every later start.
//!
//! Off a Mac the list is empty and every function here is a no-op answer.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const FILE: &str = "privacy-opened.json";

/// The guarded folders under a Mac home, as paths below `home`. Desktop, Documents, Downloads
/// (their own prompts), Music (Apple Music and the media library), Movies and Pictures (the TV
/// and Photos libraries live there), iCloud Drive (`Mobile Documents`), the cloud providers
/// (`CloudStorage`), other apps' shared data (`Group Containers`), Calendars and Contacts, and
/// `Library/Photos` — the Photos data vault (`Libraries/Syndication.photoslibrary`, "Shared with
/// You"): even a listing of the folder itself raises "Allow Trove to access your photo
/// library?", and the home index walked it on a first launch (Mac test, 2026-11-03).
pub fn protected_under(home: &Path) -> Vec<PathBuf> {
    [
        "Desktop",
        "Documents",
        "Downloads",
        "Music",
        "Movies",
        "Pictures",
        "Library/Mobile Documents",
        "Library/CloudStorage",
        "Library/Group Containers",
        "Library/Calendars",
        "Library/Application Support/AddressBook",
        "Library/Photos",
    ]
    .iter()
    .map(|d| home.join(d))
    .collect()
}

/// The guarded folder `path` is, or is inside.
pub fn root_of<'a>(path: &Path, roots: &'a [PathBuf]) -> Option<&'a PathBuf> {
    roots.iter().find(|r| path.starts_with(r))
}

/// `roots` minus the ones in `opened`.
pub fn unopened_of(roots: &[PathBuf], opened: &[PathBuf]) -> Vec<PathBuf> {
    roots
        .iter()
        .filter(|r| !opened.contains(r))
        .cloned()
        .collect()
}

/// The guarded folder a listing of `path` opens for the first time, if any.
pub fn newly_opened(path: &Path, roots: &[PathBuf], opened: &[PathBuf]) -> Option<PathBuf> {
    root_of(path, roots)
        .filter(|r| !opened.contains(r))
        .cloned()
}

struct State {
    file: Option<PathBuf>,
    opened: Vec<PathBuf>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(State {
            file: None,
            opened: Vec::new(),
        })
    })
}

/// This machine's guarded folders: the Mac list under the home folder, empty elsewhere.
fn roots() -> Vec<PathBuf> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    crate::core::shell::user_profile()
        .map(|h| protected_under(&h))
        .unwrap_or_default()
}

/// Read what was opened before, from `config_dir`. Called once at startup, before the index.
pub fn load(config_dir: &Path) {
    let file = config_dir.join(FILE);
    let opened: Vec<PathBuf> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
    s.file = Some(file);
    s.opened = opened;
}

/// The guarded folders the person has opened in Trove (they may be read in the background).
pub fn opened() -> Vec<PathBuf> {
    let roots = roots();
    let s = state().lock().unwrap_or_else(|e| e.into_inner());
    s.opened
        .iter()
        .filter(|p| roots.contains(p))
        .cloned()
        .collect()
}

/// Every guarded folder on this machine (the home folder's index never walks into them: each
/// opened one is a part of its own, `core::index::start_with`).
pub fn all() -> Vec<PathBuf> {
    roots()
}

/// The guarded folders not opened yet: what no background walk may enter.
pub fn unopened() -> Vec<PathBuf> {
    let roots = roots();
    if roots.is_empty() {
        return roots;
    }
    let s = state().lock().unwrap_or_else(|e| e.into_inner());
    unopened_of(&roots, &s.opened)
}

/// A listing of `path` worked. If that opened a guarded folder for the first time, remember it
/// and return it, so the caller can index it. `None` off a Mac and for every other folder.
pub fn note_listed(path: &Path) -> Option<PathBuf> {
    let roots = roots();
    if roots.is_empty() {
        return None;
    }
    let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
    let root = newly_opened(path, &roots, &s.opened)?;
    s.opened.push(root.clone());
    if let Some(file) = &s.file {
        let text = serde_json::to_string_pretty(&s.opened).unwrap_or_default();
        if let Err(e) = std::fs::write(file, text) {
            log::warn!("privacy folders: could not save the opened list: {e}");
        }
    }
    log::info!("privacy folders: a guarded folder was opened");
    Some(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/Users/x")
    }

    #[test]
    fn the_list_names_the_folders_that_raise_a_prompt() {
        let roots = protected_under(&home());
        for d in [
            "Desktop",
            "Documents",
            "Downloads",
            "Music",
            "Movies",
            "Pictures",
        ] {
            assert!(roots.contains(&home().join(d)), "{d}");
        }
        assert!(roots.contains(&home().join("Library/Mobile Documents")));
        assert!(roots.contains(&home().join("Library/Group Containers")));
        assert!(roots.contains(&home().join("Library/Photos")));
        // the home folder itself and the rest of Library are not guarded
        assert!(!roots.contains(&home()));
        assert!(!roots.contains(&home().join("Library")));
    }

    #[test]
    fn a_listing_inside_a_guarded_folder_opens_that_folder_once() {
        let roots = protected_under(&home());
        let deep = home().join("Downloads/a/b");
        assert_eq!(
            newly_opened(&deep, &roots, &[]),
            Some(home().join("Downloads"))
        );
        assert_eq!(
            newly_opened(&deep, &roots, &[home().join("Downloads")]),
            None
        );
        // a look at the home folder, or a folder merely NAMED like one, opens nothing
        assert_eq!(newly_opened(&home(), &roots, &[]), None);
        assert_eq!(newly_opened(&home().join("Downloads2"), &roots, &[]), None);
        assert_eq!(
            newly_opened(&home().join("Projects/Downloads"), &roots, &[]),
            None
        );
    }

    /// ⭐ the photo library prompt on a first launch: the home index walked `~/Library/Photos`
    /// (the Photos data vault) because only the media packages were skipped, not the folder
    /// that holds them. It is guarded now, so the walk leaves it out until it is opened.
    #[test]
    fn the_photos_vault_is_left_out_until_it_is_opened() {
        let roots = protected_under(&home());
        let vault = home().join("Library/Photos");
        let inside = vault.join("Libraries/Syndication.photoslibrary");
        assert_eq!(root_of(&inside, &roots), Some(&vault));
        assert!(unopened_of(&roots, &[]).contains(&vault));
        assert_eq!(newly_opened(&inside, &roots, &[]), Some(vault.clone()));
        assert!(!unopened_of(&roots, std::slice::from_ref(&vault)).contains(&vault));
        // the rest of Library stays walked
        assert_eq!(root_of(&home().join("Library/Preferences"), &roots), None);
        assert_eq!(root_of(&home().join("Library/PhotosOther"), &roots), None);
    }

    #[test]
    fn unopened_leaves_out_what_was_opened() {
        let roots = protected_under(&home());
        let left = unopened_of(&roots, &[home().join("Music")]);
        assert_eq!(left.len(), roots.len() - 1);
        assert!(!left.contains(&home().join("Music")));
        assert!(left.contains(&home().join("Documents")));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn off_a_mac_nothing_is_guarded() {
        assert!(all().is_empty());
        assert!(unopened().is_empty());
        assert_eq!(note_listed(&home().join("Downloads")), None);
    }
}

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

/// The guarded folders in `found`, each once, in `guarded`'s order (Desktop, Documents,
/// Downloads…), as strings for the frontend.
pub fn in_order(found: &[PathBuf], guarded: &[PathBuf]) -> Vec<String> {
    guarded
        .iter()
        .filter(|g| found.contains(g))
        .map(|g| g.to_string_lossy().into_owned())
        .collect()
}

/// The guarded folders in `guarded` that are, or are inside, one of `roots`: what a search of
/// `roots` that never enters them leaves out.
pub fn under_any(roots: &[PathBuf], guarded: &[PathBuf]) -> Vec<PathBuf> {
    guarded
        .iter()
        .filter(|g| roots.iter().any(|r| g.starts_with(r)))
        .cloned()
        .collect()
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

/// The top folders of `/` that are APFS firmlinks into the data volume (`/usr/share/firmlinks`):
/// `/System/Volumes/Data/Users/x` IS `/Users/x`.
const FIRMLINKED: [&str; 8] = [
    "Users",
    "Applications",
    "Library",
    "Volumes",
    "private",
    "opt",
    "cores",
    "usr",
];

/// `path` in the spelling the guarded and skip lists use: a path on the data volume through a
/// firmlink (`/System/Volumes/Data/Users/x/Documents`) as the firmlink (`/Users/x/Documents`).
pub fn firmlinked(path: &Path) -> PathBuf {
    match path.strip_prefix("/System/Volumes/Data") {
        Ok(rest)
            if rest
                .components()
                .next()
                .is_some_and(|c| FIRMLINKED.iter().any(|f| c.as_os_str() == *f)) =>
        {
            Path::new("/").join(rest)
        }
        _ => path.to_path_buf(),
    }
}

/// Where the symlink `link` points, read off the link (`readlink` asks nothing of the target),
/// relative targets joined to the link's folder and `.`/`..` folded by name.
pub fn link_target(link: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_link(link).ok()?;
    let joined = link.parent().map_or(raw.clone(), |p| p.join(&raw));
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    Some(out)
}

/// Whether `target` lies in an unopened guarded folder or on a skipped mount (a share, an
/// automount, a `nobrowse` volume), under any of its spellings.
pub fn target_fenced(target: &Path, guarded: &[PathBuf], skip: &[PathBuf]) -> bool {
    let t = firmlinked(target);
    guarded.iter().chain(skip).any(|g| t.starts_with(g))
}

/// Mac: whether following the symlink `link` would step into what no walk may enter.
///
/// ⛔ A listing follows each symlink once to learn whether it is a folder (`fs::entry_from`).
/// `/home` is a link to `/System/Volumes/Data/home`, the `auto_home` automount, and following
/// it is macOS's "access files on a network volume" prompt — raised by a ⌘K search and by
/// This Mac's "Search everywhere" with no share mounted (Mac test, 2026-11-04). A link into an
/// unopened `~/Documents` is the Documents prompt the same way. Such a link stays a link.
/// Always false off a Mac (where the follow is what it always was).
pub fn link_is_fenced(link: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let Some(target) = link_target(link) else {
        return false;
    };
    target_fenced(
        &target,
        &unopened(),
        &crate::core::mounts::walk_skip_points(),
    )
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
    fn what_a_search_left_out_is_named_once_in_the_lists_order() {
        let roots = protected_under(&home());
        let found = [
            home().join("Downloads"),
            home().join("Desktop"),
            home().join("Downloads"),
        ];
        // built with join, as the roots are: Windows joins with `\`
        let named = |p: &str| home().join(p).to_string_lossy().into_owned();
        assert_eq!(
            in_order(&found, &roots),
            [named("Desktop"), named("Downloads")]
        );
        // a search of the home folder leaves out every guarded folder; one of Projects, none
        assert_eq!(under_any(&[home()], &roots).len(), roots.len());
        assert!(under_any(&[home().join("Projects")], &roots).is_empty());
        assert_eq!(
            under_any(&[home().join("Library")], &roots),
            [
                home().join("Library/Mobile Documents"),
                home().join("Library/CloudStorage"),
                home().join("Library/Group Containers"),
                home().join("Library/Calendars"),
                home().join("Library/Application Support/AddressBook"),
                home().join("Library/Photos"),
            ]
        );
    }

    /// ⭐ The network-volume prompt from a ⌘K search with no share mounted: `/home` links to the
    /// `auto_home` automount, and the listing followed it. And a link spelled through the data
    /// volume into an unopened `~/Documents` is fenced like `~/Documents` itself.
    #[test]
    fn a_link_into_an_automount_or_an_unopened_folder_is_fenced() {
        let guarded = protected_under(&home());
        let skip = [
            PathBuf::from("/System/Volumes/Data"),
            PathBuf::from("/System/Volumes/Data/home"),
        ];
        let fenced = |t: &str| target_fenced(Path::new(t), &guarded, &skip);
        assert!(fenced("/System/Volumes/Data/home"));
        assert!(fenced("/System/Volumes/Data/Users/x/Documents/a"));
        assert!(fenced("/Users/x/Desktop"));
        // the data volume through a firmlink is an ordinary folder; so is the rest of home
        assert!(!fenced("/System/Volumes/Data/Users/x/Projects"));
        assert!(!fenced("/Users/x/Projects"));
        assert!(!fenced("/"));
        assert_eq!(
            firmlinked(Path::new("/System/Volumes/Data/Users/x")),
            PathBuf::from("/Users/x")
        );
        assert_eq!(
            firmlinked(Path::new("/System/Volumes/Data/home")),
            PathBuf::from("/System/Volumes/Data/home")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_target_is_read_off_the_link_and_folded() {
        let dir = std::env::temp_dir().join(format!("trove-pf-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::os::unix::fs::symlink("../b/./c", dir.join("a/rel")).unwrap();
        std::os::unix::fs::symlink("/System/Volumes/Data/home", dir.join("home")).unwrap();
        assert_eq!(link_target(&dir.join("a/rel")), Some(dir.join("b/c")));
        assert_eq!(
            link_target(&dir.join("home")),
            Some(PathBuf::from("/System/Volumes/Data/home"))
        );
        assert_eq!(link_target(&dir.join("a")), None, "not a link");
        let _ = std::fs::remove_dir_all(&dir);
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

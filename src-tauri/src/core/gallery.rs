//! Gallery: the photos and videos under the Pictures folders, newest first — Explorer's
//! Gallery. No tauri types.
//!
//! ⛔ A Mac holds a read of a privacy-protected folder (the Photos library, the Music library,
//! `~/Library`) until the person answers the permission prompt, and the walk used to wait with
//! it: "Looking through your pictures…" for 30 s+ at 0 % CPU while a "media library / Apple
//! Music" prompt sat on screen (Mac, release build at 16a32d4). So the walk never enters a
//! package (a folder with a bundle extension — where those libraries live) or a protected
//! folder, and every root is walked on a thread of its own: when the budget runs out the
//! listing returns what was found so far, and a thread still stuck in one read is left to
//! notice the cancel and stop on its own.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use crate::core::fs::{self, FileEntry};
use crate::core::search;

/// What the Gallery shows: still images and video, by extension (lower-case, no dot).
pub const GALLERY_EXTS: [&str; 15] = [
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "tif", "tiff", "mp4", "mov", "webm", "mkv",
    "avi", "m4v",
];
/// How deep under a root the walk goes; Pictures trees are shallow, camera dumps are not.
pub const MAX_DEPTH: usize = 6;
/// How many items at most; the newest win.
pub const DEFAULT_MAX: usize = 2000;
/// How long a listing may take before it returns what it has.
pub const BUDGET: Duration = Duration::from_secs(3);

/// Folder extensions that make a folder a package — one thing to the person (Finder shows it
/// as a file) with an app's private store inside. The media libraries are the ones that matter:
/// their contents sit behind a macOS permission prompt, and the pictures inside are the
/// library's own copies and caches, not the person's files. Skipped on every platform: a
/// library copied to a Windows disk is still not a folder of photos.
pub const PACKAGE_EXTS: [&str; 22] = [
    "photoslibrary",
    "photolibrary",
    "migratedphotolibrary",
    "aplibrary",
    "musiclibrary",
    "tvlibrary",
    "imovielibrary",
    "fcpbundle",
    "theater",
    "lrdata",
    "app",
    "bundle",
    "framework",
    "plugin",
    "kext",
    "appex",
    "xpc",
    "rtfd",
    "pages",
    "numbers",
    "key",
    "logicx",
];

pub fn is_gallery_file(entry: &FileEntry) -> bool {
    !entry.is_dir
        && entry
            .ext
            .as_deref()
            .is_some_and(|e| GALLERY_EXTS.contains(&e))
}

/// The lower-case extension of `name` when it has a stem (`.jpg` alone has none).
fn ext_of(name: &str) -> Option<String> {
    name.rsplit_once('.')
        .filter(|(stem, ext)| !stem.is_empty() && !ext.is_empty())
        .map(|(_, ext)| ext.to_ascii_lowercase())
}

/// Whether a folder named `name` is a package (see `PACKAGE_EXTS`), any case.
pub fn is_package_dir(name: &str) -> bool {
    ext_of(name).is_some_and(|e| PACKAGE_EXTS.contains(&e.as_str()))
}

/// Folders under the home the walk never enters, whatever root it starts from. On a Mac:
/// `~/Music` (the Apple Music library — its prompt is the one a tester saw), `~/Movies/TV` (the TV
/// app's library) and `~/Library` (apps' private data, much of it behind prompts). None on
/// Windows or Linux: the roots there are Pictures folders, and the app stores (`AppData`,
/// `~/.cache`) are hidden folders the walk skips anyway.
pub fn protected_dirs(home: &Path, macos: bool) -> Vec<PathBuf> {
    if !macos {
        return Vec::new();
    }
    vec![
        home.join("Music"),
        home.join("Movies").join("TV"),
        home.join("Library"),
    ]
}

/// Whether the walk stays out of the folder at `path` (named `name`).
fn skip_folder(path: &Path, name: &str, protected: &[PathBuf]) -> bool {
    let parent = path
        .parent()
        .and_then(Path::file_name)
        .map(|p| p.to_string_lossy().into_owned());
    is_package_dir(name)
        || search::skip_dir(name, parent.as_deref())
        || protected.iter().any(|p| path.starts_with(p))
}

/// The folders worth walking: the shell's Pictures, `USERPROFILE\Pictures`, and OneDrive's
/// `Pictures` when the client is set up — existing ones only, each once.
pub fn gallery_roots(
    profile: Option<&Path>,
    known_pictures: Option<&Path>,
    one_drive: Option<&Path>,
) -> Vec<PathBuf> {
    let candidates = [
        known_pictures.map(Path::to_path_buf),
        profile.map(|p| p.join("Pictures")),
        one_drive.map(|p| p.join("Pictures")),
    ];
    let mut roots: Vec<PathBuf> = Vec::new();
    for c in candidates.into_iter().flatten() {
        if !c.is_dir() {
            continue;
        }
        let key = c.to_string_lossy().to_lowercase();
        if roots
            .iter()
            .any(|r| r.to_string_lossy().to_lowercase() == key)
        {
            continue;
        }
        roots.push(c);
    }
    roots
}

/// Walk one root: every image and video `max_depth` deep, hidden folders, links, packages and
/// `protected` folders never entered. `found` gets each item as it is seen, so whatever the
/// walk reached before it was cancelled (or got stuck) is already handed over.
fn walk_root(
    root: &Path,
    max_depth: usize,
    protected: &[PathBuf],
    cancel: &AtomicBool,
    found: &mut dyn FnMut(FileEntry),
) {
    let mut types: HashMap<Option<String>, String> = HashMap::new();
    let mut it = walkdir::WalkDir::new(root)
        .follow_links(false)
        .min_depth(1)
        .max_depth(max_depth)
        .into_iter();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let Some(next) = it.next() else { return };
        let Ok(entry) = next else { continue }; // a permission wall or a vanished entry
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().is_dir() {
            let meta = entry.metadata().ok();
            if search::is_reparse_point(meta.as_ref())
                || fs::is_hidden_entry(&name, meta.as_ref())
                || skip_folder(entry.path(), &name, protected)
            {
                it.skip_current_dir();
            }
            continue;
        }
        // the name first: only a picture or a video is worth its metadata
        if !ext_of(&name).is_some_and(|e| GALLERY_EXTS.contains(&e.as_str())) {
            continue;
        }
        let meta = entry.metadata().ok();
        if fs::is_hidden_entry(&name, meta.as_ref()) {
            continue;
        }
        let file = fs::entry_from(entry.into_path(), meta, &mut types);
        if is_gallery_file(&file) {
            found(file);
        }
    }
}

/// Run `walk(root, cancel, found)` for every root at once, each on its own thread, and return
/// everything found when they have all finished or `budget` has run out, whichever is first.
/// On the deadline `cancel` is raised and the stragglers are not waited for: a thread held in
/// one read (a permission prompt, a dead network share) keeps nothing else back.
fn collect_within<W>(roots: &[PathBuf], budget: Duration, walk: W) -> Vec<FileEntry>
where
    W: Fn(&Path, &AtomicBool, &mut dyn FnMut(FileEntry)) + Send + Sync + 'static,
{
    let started = Instant::now();
    let walk = Arc::new(walk);
    let cancel = Arc::new(AtomicBool::new(false));
    let items: Arc<Mutex<Vec<FileEntry>>> = Arc::new(Mutex::new(Vec::new()));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let mut running = 0usize;
    for root in roots {
        let (walk, cancel, items, done) = (
            Arc::clone(&walk),
            Arc::clone(&cancel),
            Arc::clone(&items),
            done_tx.clone(),
        );
        let root = root.clone();
        let spawned = std::thread::Builder::new()
            .name("gallery-walk".into())
            .spawn(move || {
                walk(&root, &cancel, &mut |entry| {
                    if let Ok(mut v) = items.lock() {
                        v.push(entry);
                    }
                });
                let _ = done.send(());
            });
        match spawned {
            Ok(_) => running += 1,
            Err(e) => log::warn!("gallery: could not start a walk: {e}"),
        }
    }
    drop(done_tx);
    while running > 0 {
        let left = budget.saturating_sub(started.elapsed());
        match done_rx.recv_timeout(left) {
            Ok(()) => running -= 1,
            Err(_) => {
                log::warn!(
                    "gallery: {running} folder walk(s) still busy after {}ms; showing what was found",
                    budget.as_millis()
                );
                break;
            }
        }
    }
    cancel.store(true, Ordering::Relaxed);
    let out = items.lock().map(|v| v.clone()).unwrap_or_default();
    out
}

/// Every image and video under `roots` (`max_depth` deep; hidden folders, links, packages and
/// `protected` folders skipped), newest modified first, at most `max`. Returns within about
/// `budget` with whatever was found by then — a huge photo library or a folder held by a
/// permission prompt never freezes the view.
pub fn gallery_items(
    roots: &[PathBuf],
    protected: &[PathBuf],
    max: usize,
    max_depth: usize,
    budget: Duration,
) -> Vec<FileEntry> {
    let roots: Vec<PathBuf> = roots
        .iter()
        .filter(|r| !protected.iter().any(|p| r.starts_with(p)))
        .filter(|r| {
            r.file_name()
                .is_none_or(|n| !is_package_dir(&n.to_string_lossy()))
        })
        .cloned()
        .collect();
    let protected = protected.to_vec();
    let mut items = collect_within(&roots, budget, move |root, cancel, found| {
        walk_root(root, max_depth, &protected, cancel, found)
    });
    items.sort_by_key(|e| std::cmp::Reverse(e.modified_ms));
    items.truncate(max.max(1));
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as stdfs;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = stdfs::remove_dir_all(&self.0);
        }
    }
    fn scratch(tag: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!(
            "trove-gallery-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        stdfs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
    fn touch(path: &Path, when: std::time::SystemTime) {
        stdfs::write(path, b"x").unwrap();
        let f = stdfs::File::options().write(true).open(path).unwrap();
        f.set_modified(when).unwrap();
    }
    fn names(items: &[FileEntry]) -> Vec<&str> {
        items.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn only_images_and_video_newest_first_capped() {
        let s = scratch("filter");
        let now = std::time::SystemTime::now();
        let ago = |secs: u64| now - Duration::from_secs(secs);
        touch(&s.0.join("old.jpg"), ago(300));
        touch(&s.0.join("new.PNG"), ago(10));
        touch(&s.0.join("mid.mp4"), ago(100));
        touch(&s.0.join("notes.txt"), ago(5));
        stdfs::create_dir_all(s.0.join("sub")).unwrap();
        touch(&s.0.join("sub").join("deep.webp"), ago(50));

        let items = gallery_items(std::slice::from_ref(&s.0), &[], 10, MAX_DEPTH, BUDGET);
        assert_eq!(
            names(&items),
            ["new.PNG", "deep.webp", "mid.mp4", "old.jpg"]
        );

        let capped = gallery_items(std::slice::from_ref(&s.0), &[], 2, MAX_DEPTH, BUDGET);
        assert_eq!(capped.len(), 2);
        assert_eq!(capped[0].name, "new.PNG");
    }

    #[test]
    fn depth_limit_hidden_and_missing_roots() {
        let s = scratch("depth");
        let now = std::time::SystemTime::now();
        let deep = s.0.join("a").join("b").join("c");
        stdfs::create_dir_all(&deep).unwrap();
        touch(&deep.join("far.jpg"), now);
        touch(&s.0.join("near.jpg"), now);
        touch(&s.0.join(".hidden.jpg"), now);
        stdfs::create_dir_all(s.0.join(".cache")).unwrap();
        touch(&s.0.join(".cache").join("inside.jpg"), now);

        let shallow = gallery_items(&[s.0.clone(), s.0.join("nope")], &[], 10, 1, BUDGET);
        assert_eq!(names(&shallow), ["near.jpg"]);

        let all = gallery_items(std::slice::from_ref(&s.0), &[], 10, MAX_DEPTH, BUDGET);
        let mut got = names(&all);
        got.sort_unstable();
        assert_eq!(got, ["far.jpg", "near.jpg"]);
    }

    /// ⭐ the stuck Gallery: the walk must never open a media library package (on a Mac its
    /// contents are behind a permission prompt) nor `~/Music`, `~/Movies/TV`, `~/Library`.
    #[test]
    fn packages_and_protected_folders_are_never_entered() {
        let s = scratch("packages");
        let home = s.0.clone();
        let pics = home.join("Pictures");
        let now = std::time::SystemTime::now();
        for pkg in [
            "Photos Library.photoslibrary",
            "Old.PhotoLibrary",
            "Music Library.musiclibrary",
            "TV Library.tvlibrary",
            "Some.app",
        ] {
            let inner = pics.join(pkg).join("originals");
            stdfs::create_dir_all(&inner).unwrap();
            touch(&inner.join("copy.jpg"), now);
        }
        // a folder whose name only looks like it has an extension is still walked
        stdfs::create_dir_all(pics.join("Trip 2024.06")).unwrap();
        touch(&pics.join("Trip 2024.06").join("beach.jpg"), now);
        touch(&pics.join("mine.heic"), now);
        // protected folders, reached here through a root that contains them
        for dir in [
            home.join("Music"),
            home.join("Movies").join("TV"),
            home.join("Library"),
        ] {
            stdfs::create_dir_all(&dir).unwrap();
            touch(&dir.join("cover.jpg"), now);
        }
        touch(&home.join("Movies").join("clip.mov"), now);

        let protected = protected_dirs(&home, true);
        let items = gallery_items(
            &[
                pics.clone(),
                home.clone(),
                pics.join("Photos Library.photoslibrary"),
            ],
            &protected,
            100,
            MAX_DEPTH,
            BUDGET,
        );
        let mut got = names(&items);
        got.sort_unstable();
        // `pics` is walked twice (as a root and under `home`), so its two files come twice
        assert_eq!(
            got,
            [
                "beach.jpg",
                "beach.jpg",
                "clip.mov",
                "mine.heic",
                "mine.heic"
            ]
        );
        assert!(items.iter().all(|e| !e.path.contains("Library")));

        // A root inside a protected folder is dropped before any thread opens it.
        let music_root = gallery_items(&[home.join("Music")], &protected, 100, MAX_DEPTH, BUDGET);
        assert!(music_root.is_empty());
    }

    #[test]
    fn package_names_and_protected_dirs() {
        assert!(is_package_dir("Photos Library.photoslibrary"));
        assert!(is_package_dir("X.MusicLibrary"));
        assert!(is_package_dir("Safari.app"));
        assert!(!is_package_dir("Trip 2024.06"));
        assert!(!is_package_dir(".photoslibrary"));
        assert!(!is_package_dir("Pictures"));
        let home = Path::new("/Users/alex");
        assert_eq!(
            protected_dirs(home, true),
            [
                home.join("Music"),
                home.join("Movies").join("TV"),
                home.join("Library")
            ]
        );
        assert!(protected_dirs(home, false).is_empty());
    }

    /// ⭐ One folder that never answers (a read held by a permission prompt) must not hold the
    /// rest: the listing returns at the budget with what the other roots found.
    #[test]
    fn a_stuck_folder_does_not_hold_the_listing() {
        let s = scratch("stuck");
        let now = std::time::SystemTime::now();
        let good = s.0.join("good");
        stdfs::create_dir_all(&good).unwrap();
        touch(&good.join("seen.jpg"), now);
        let stuck = s.0.join("stuck");
        stdfs::create_dir_all(&stuck).unwrap();
        touch(&stuck.join("first.jpg"), now);

        let stuck_root = stuck.clone();
        let started = Instant::now();
        let items = collect_within(
            &[stuck.clone(), good.clone()],
            Duration::from_millis(300),
            move |root, cancel, found| {
                walk_root(root, MAX_DEPTH, &[], cancel, found);
                if root == stuck_root {
                    // what a prompt does to a read: nothing comes back for a long time
                    std::thread::sleep(Duration::from_secs(20));
                }
            },
        );
        let took = started.elapsed();
        assert!(
            took < Duration::from_secs(5),
            "waited {took:?} for a stuck folder"
        );
        let mut got = names(&items);
        got.sort_unstable();
        // the stuck root's items found before it stuck are kept too
        assert_eq!(got, ["first.jpg", "seen.jpg"]);
    }

    #[test]
    fn roots_are_existing_and_deduped() {
        let s = scratch("roots");
        let pics = s.0.join("Pictures");
        stdfs::create_dir_all(&pics).unwrap();
        let roots = gallery_roots(Some(&s.0), Some(&pics), Some(&s.0.join("OneDrive")));
        assert_eq!(roots, vec![pics]);
        assert!(gallery_roots(None, None, None).is_empty());
    }
}

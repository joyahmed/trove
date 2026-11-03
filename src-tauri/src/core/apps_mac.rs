//! The macOS app list: every `.app` bundle in the `Applications` folders, named the way
//! Finder names it, for the Spotlight palette (and later the Applications place).
//!
//! Every function takes its roots as an argument so the tests can point them at temp dirs on
//! any OS; only `mac_roots` knows where the real folders are. Compiled on macOS and in tests.
//!
//! ⛔ Read-only. Nothing here writes, moves or deletes; `launch_argv` only builds the argument
//! list `launch_app` spawns.
//!
//! ⚠️ A bundle is a **leaf**: the walk never descends into an `.app` (Xcode.app holds dozens of
//! nested helper apps), never follows a symlink, and lists a bundle reached twice
//! (`/Applications/Utilities` is a root and also depth 2 of `/Applications`) once.
//!
//! ⚠️ One kind of symlink IS listed: a `*.app` link whose resolved target is a bundle folder
//! under a system root (`/System`). Safari is exactly that since macOS 13:
//! `/Applications/Safari.app` → `/System/Cryptexes/App/System/Applications/Safari.app`. It is
//! listed under the link's own path (what Finder shows; `open` launches it), and
//! `uninstall_mac::may_trash` refuses it as `System` ("Part of macOS"). Every other symlinked
//! `.app` (`HP Utility.app` → `/Library/Printers/...`) stays hidden.
//!
//! ⚠️ Two bundles can share one `CFBundleIdentifier` (Xcode + Xcode-beta), and `open -b <id>`
//! lets LaunchServices pick either — so the app's id here (`aumid`) is the bundle **path**.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::core::spotlight::{AppEntry, OpenWith};

/// How deep under each root a bundle may sit: `/Applications/X.app` and
/// `/Applications/Utilities/X.app`, nothing deeper.
const MAX_DEPTH: usize = 2;

/// The folders Finder's Applications sidebar entry and Launchpad draw from, plus the person's
/// own `~/Applications` when `home` is known.
pub fn mac_roots(home: Option<&Path>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = [
        "/Applications",
        "/Applications/Utilities",
        "/System/Applications",
        "/System/Applications/Utilities",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if let Some(home) = home {
        roots.push(home.join("Applications"));
    }
    roots
}

/// Every `.app` bundle under `roots`, at most two levels deep, sorted by name
/// case-insensitively. Missing roots are skipped. Links into `/System` are listed (Safari).
pub fn mac_apps(roots: &[PathBuf]) -> Vec<AppEntry> {
    mac_apps_in(roots, &crate::core::uninstall_mac::system_roots())
}

/// A `*.app` symlink whose resolved target is a bundle folder under one of `system`.
fn system_link(path: &Path, system: &[PathBuf]) -> bool {
    std::fs::canonicalize(path)
        .is_ok_and(|real| real.is_dir() && system.iter().any(|r| real.starts_with(r)))
}

/// `mac_apps` with the system roots given, so tests can stand a temp folder in for `/System`.
pub fn mac_apps_in(roots: &[PathBuf], system: &[PathBuf]) -> Vec<AppEntry> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut out: Vec<AppEntry> = Vec::new();
    for root in roots {
        let mut walk = walkdir::WalkDir::new(root)
            .follow_links(false)
            .min_depth(1)
            .max_depth(MAX_DEPTH)
            .into_iter();
        loop {
            let entry = match walk.next() {
                None => break,
                Some(Err(_)) => continue,
                Some(Ok(e)) => e,
            };
            if !is_bundle(entry.path()) {
                continue;
            }
            // a symlink's own file type is "symlink", never "dir": never followed, and listed
            // only when it resolves into a system root (Safari)
            let ty = entry.file_type();
            if ty.is_symlink() {
                if !system_link(entry.path(), system) {
                    continue;
                }
            } else if ty.is_dir() {
                walk.skip_current_dir();
            } else {
                continue;
            }
            let key = std::fs::canonicalize(entry.path()).unwrap_or_else(|_| entry.path().into());
            if !seen.insert(key) {
                continue;
            }
            if let Some(app) = read_bundle(entry.path()) {
                out.push(app);
            }
        }
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

fn is_bundle(path: &Path) -> bool {
    path.extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("app"))
}

/// One bundle as an app row, named by its folder's stem — what Finder shows.
///
/// ⚠️ Not `CFBundleDisplayName`/`CFBundleName`: `Visual Studio Code.app` says `Code` there, so
/// typing "visual" would find nothing. `Info.plist` is not read at all.
fn read_bundle(path: &Path) -> Option<AppEntry> {
    let name = path.file_stem()?.to_string_lossy().into_owned();
    let bundle = path.to_string_lossy().into_owned();
    Some(AppEntry {
        name,
        open_with: Some(OpenWith {
            program: "open".into(),
            // a `"` in the path is legal on macOS; `splitArgs` reads `\"` back as a quote
            args: format!("-a \"{}\" %paths%", bundle.replace('"', "\\\"")),
        }),
        aumid: bundle.clone(),
        path: bundle,
        ..AppEntry::default()
    })
}

/// What `launch_app` spawns for a bundle: `open <bundle path>`. Never `open -b <id>` (it may
/// start the other copy) and never `Contents/MacOS/<exe>` (a second instance of a running app).
pub fn launch_argv(entry: &AppEntry) -> Vec<String> {
    vec!["open".into(), entry.path.clone()]
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn scratch(tag: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("trove-17-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn bundle(at: &Path, plist: Option<&str>) {
        let contents = at.join("Contents");
        std::fs::create_dir_all(&contents).unwrap();
        if let Some(body) = plist {
            std::fs::write(contents.join("Info.plist"), body).unwrap();
        }
    }

    fn info(pairs: &[(&str, &str)]) -> String {
        let mut body = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n",
        );
        for (k, v) in pairs {
            body.push_str(&format!("<key>{k}</key><string>{v}</string>\n"));
        }
        body.push_str("</dict></plist>\n");
        body
    }

    #[test]
    fn bundles_are_listed_by_their_finder_name_and_nested_apps_are_not() {
        let s = scratch("apps-mac");
        let root = s.0.join("Applications");
        let utilities = root.join("Utilities");
        std::fs::create_dir_all(&utilities).unwrap();

        // the file name wins over both plist names (Finder shows the file name)
        bundle(
            &root.join("Fake.app"),
            Some(&info(&[
                ("CFBundleDisplayName", "Fake Display"),
                ("CFBundleName", "FakeName"),
                ("CFBundleIdentifier", "org.trove.fake"),
            ])),
        );
        // nested helper apps: never listed — one sits at depth 2, inside the walk's reach, so
        // only "a bundle is a leaf" keeps it out
        bundle(&root.join("Fake.app/Inner2.app"), None);
        bundle(
            &root.join("Fake.app/Contents/Helpers/Inner.app"),
            Some(&info(&[("CFBundleName", "Inner")])),
        );
        // no plist: name from the stem
        bundle(&root.join("Bare.app"), None);
        // two bundles share one id and one CFBundleName; listed by their own file names
        let same_id = [
            ("CFBundleName", "Twin"),
            ("CFBundleIdentifier", "org.trove.twin"),
        ];
        bundle(&root.join("Twin.app"), Some(&info(&same_id)));
        bundle(&utilities.join("Twin Beta.app"), Some(&info(&same_id)));
        // too deep (depth 3): not listed
        bundle(&root.join("a/b/Deep.app"), None);
        // a plain folder is not an app
        std::fs::create_dir_all(root.join("NotAnApp")).unwrap();

        // a symlink to a bundle is not followed (skip that part where links need privilege)
        let link = root.join("Linked.app");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(root.join("Bare.app"), &link).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(root.join("Bare.app"), &link).is_ok();

        // `Utilities` is both a root and depth 2 of the first root: listed once
        let apps = mac_apps(&[root.clone(), utilities.clone(), s.0.join("missing")]);
        let names: Vec<&str> = apps.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Bare", "Fake", "Twin", "Twin Beta"], "{apps:?}");
        if linked {
            assert!(!apps.iter().any(|a| a.path.ends_with("Linked.app")));
        }

        let fake = &apps[1];
        let fake_path = root.join("Fake.app").to_string_lossy().into_owned();
        assert_eq!(fake.aumid, fake_path, "aumid is the bundle path");
        assert_eq!(fake.path, fake_path);
        assert_eq!(fake.lnk_path, "");
        assert_eq!(fake.target, "");
        assert_eq!(
            fake.open_with,
            Some(OpenWith {
                program: "open".into(),
                args: format!("-a \"{fake_path}\" %paths%"),
            })
        );
        // the twins keep distinct ids even though their bundle id is the same
        assert_ne!(apps[2].aumid, apps[3].aumid);
        assert_eq!(launch_argv(fake), ["open".to_string(), fake_path]);

        // a quote in the bundle path is escaped the way splitArgs reads it back
        let odd = read_bundle(&root.join("Say \"Hi\".app")).unwrap();
        assert_eq!(odd.name, "Say \"Hi\"");
        assert!(odd
            .open_with
            .unwrap()
            .args
            .contains("Say \\\"Hi\\\".app\" %paths%"));
    }

    /// Safari's shape: `Applications/Safari.app` is a link into the system root. Listed under the
    /// link's path; a link anywhere else stays hidden; a link to a non-bundle stays hidden.
    #[cfg(unix)]
    #[test]
    fn a_link_into_the_system_root_is_listed_and_no_other_link_is() {
        let s = scratch("apps-mac-syslink");
        let root = s.0.join("Applications");
        let system = s.0.join("System");
        std::fs::create_dir_all(&root).unwrap();
        bundle(
            &system.join("Cryptexes/App/System/Applications/Safari.app"),
            None,
        );
        bundle(&s.0.join("Library/Printers/HP Utility.app"), None);
        std::fs::create_dir_all(system.join("NotABundle.app.d")).unwrap();
        std::os::unix::fs::symlink(
            "../System/Cryptexes/App/System/Applications/Safari.app",
            root.join("Safari.app"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            s.0.join("Library/Printers/HP Utility.app"),
            root.join("HP Utility.app"),
        )
        .unwrap();
        // a file link named .app into the system root: not a bundle folder
        std::fs::write(system.join("file"), "x").unwrap();
        std::os::unix::fs::symlink(system.join("file"), root.join("File.app")).unwrap();
        // a dangling link into the system root
        std::os::unix::fs::symlink(system.join("Gone.app"), root.join("Gone.app")).unwrap();

        let sys = [std::fs::canonicalize(&system).unwrap()];
        let apps = mac_apps_in(std::slice::from_ref(&root), &sys);
        let paths: Vec<&str> = apps.iter().map(|a| a.path.as_str()).collect();
        let safari = root.join("Safari.app").to_string_lossy().into_owned();
        assert_eq!(paths, [safari.as_str()], "{apps:?}");
        assert_eq!(apps[0].name, "Safari");
        assert_eq!(launch_argv(&apps[0]), ["open".to_string(), safari]);

        // with no system root given, the Safari link is hidden like any other
        assert!(mac_apps_in(std::slice::from_ref(&root), &[]).is_empty());
    }

    /// Live, read-only: when `/Applications/Safari.app` is a link into `/System` (macOS 13+),
    /// Safari is listed under that path. Nothing is launched. Run by hand with `--ignored`.
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn live_safari_link_is_listed() {
        let link = Path::new("/Applications/Safari.app");
        let is_link = link
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink());
        if !is_link {
            eprintln!("/Applications/Safari.app is not a symlink here; nothing to check");
            return;
        }
        assert!(std::fs::canonicalize(link).unwrap().starts_with("/System"));
        let apps = mac_apps(&mac_roots(None));
        assert!(
            apps.iter().any(|a| a.path == "/Applications/Safari.app"),
            "Safari missing among {} bundles",
            apps.len()
        );
    }

    #[test]
    fn roots_are_the_four_system_folders_plus_the_home_one() {
        let roots = mac_roots(Some(Path::new("/Users/alex")));
        assert_eq!(roots.len(), 5);
        assert_eq!(roots[0], PathBuf::from("/Applications"));
        assert_eq!(roots[4], Path::new("/Users/alex").join("Applications"));
        assert_eq!(mac_roots(None).len(), 4);
    }

    /// Live, read-only: the real list on a Mac has Calculator. Nothing is launched.
    #[test]
    #[cfg(target_os = "macos")]
    fn calculator_is_listed() {
        let apps = mac_apps(&mac_roots(None));
        assert!(
            apps.iter()
                .any(|a| a.path == "/System/Applications/Calculator.app"),
            "no Calculator among {} bundles",
            apps.len()
        );
    }
}

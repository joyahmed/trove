//! What the Spotlight palette asks the OS for: the installed apps (Start-menu shortcuts) and
//! a bounded file search over a few roots. No tauri types; the window and hotkey glue is in
//! `commands/spotlight.rs`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::core::fs::FileEntry;
use crate::core::recent::parse_lnk_full;
use crate::core::search::{self, SearchQuery};

/// What a custom command runs to open files with an app: `program` plus an argument line in
/// Trove's own tokens (`%path%`, `%paths%`), split like a shell by `utils/custom-commands.ts`.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenWith {
    pub program: String,
    pub args: String,
}

/// One launchable app: the name a person types, and whatever the OS needs to start it.
///
/// A `.lnk` under the Start menu fills `lnk_path` and `target`; an `AppsFolder` entry fills
/// `aumid`. Most apps have both — the walk resolves the shortcut, the folder supplies the app
/// id — and the ones that have only one are exactly the ones a single source misses.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub name: String,
    pub lnk_path: String,
    pub target: String,
    /// What `shell:AppsFolder\<this>` launches: an AUMID for a packaged app
    /// (`Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`), the publisher's own app id for a
    /// Win32 one (`ZedIndustries.Zed`), sometimes a bare path. Opaque — it is handed back to
    /// the shell and never parsed. Empty when only the `.lnk` walk found this app.
    ///
    /// On macOS it is the `.app` bundle path (unique — two bundles can share one bundle id);
    /// on Linux the desktop id (`org.gnome.Calculator.desktop`). `launch_app` looks it up in
    /// the cached list and never trusts it as a path.
    pub aumid: String,
    /// What a custom command runs to open files with this app; `None` = it cannot take a file
    /// from a command line (a Store app, a shortcut with its own arguments, shell syntax).
    pub open_with: Option<OpenWith>,
    /// Where the app lives on disk: the exe, the `.app` bundle, the `.desktop` file. `''`
    /// when nowhere (a Store app).
    pub path: String,
}

/// Where this OS keeps its app list: the two Start-menu folders on Windows, the
/// `Applications` folders on macOS, the XDG data dirs on Linux.
pub fn app_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        start_menu_roots()
    }
    #[cfg(target_os = "macos")]
    {
        crate::core::apps_mac::mac_roots(std::env::var_os("HOME").map(PathBuf::from).as_deref())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::core::apps_linux::env_data_dirs()
    }
}

/// The two Start-menu folders Windows merges: the person's and the machine's. Empty off
/// Windows (neither variable is set there).
pub fn start_menu_roots() -> Vec<PathBuf> {
    ["APPDATA", "ProgramData"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|base| PathBuf::from(base).join(r"Microsoft\Windows\Start Menu\Programs"))
        .collect()
}

/// Windows: what a custom command may run for a shortcut. Only an `.exe` that exists, and
/// only when the shortcut passes no arguments of its own — `Update.exe --processStart X.exe`
/// would otherwise save a program that starts the updater (or a Chrome profile shortcut, the
/// wrong profile).
pub fn lnk_open_with(target: &str, shortcut_args: Option<&str>) -> Option<OpenWith> {
    let exe = std::path::Path::new(target);
    let is_exe = exe
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("exe"));
    if !is_exe || !exe.is_file() || shortcut_args.is_none_or(|a| !a.trim().is_empty()) {
        return None;
    }
    Some(OpenWith {
        program: target.to_string(),
        args: "%paths%".into(),
    })
}

/// Every `.lnk` under `roots`, recursively: name = the file stem, target resolved through the
/// shortcut's LinkInfo. Uninstallers are left out (nobody launches them from a palette), a
/// name seen twice keeps its first shortcut, a shortcut without a local target is skipped.
/// Sorted by name, case-insensitively.
pub fn apps_in(roots: &[PathBuf]) -> Vec<AppEntry> {
    let mut out: Vec<AppEntry> = Vec::new();
    for root in roots {
        let walker = walkdir::WalkDir::new(root).follow_links(false).min_depth(1);
        for entry in walker.into_iter().filter_map(Result::ok) {
            let path = entry.path();
            if !path
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("lnk"))
            {
                continue;
            }
            let Some(name) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
                continue;
            };
            if name.to_lowercase().contains("uninstall") {
                continue;
            }
            if out.iter().any(|a| a.name.eq_ignore_ascii_case(&name)) {
                continue;
            }
            let Some(lnk) = std::fs::read(path).ok().and_then(|b| parse_lnk_full(&b)) else {
                continue;
            };
            out.push(AppEntry {
                name,
                lnk_path: path.to_string_lossy().into_owned(),
                open_with: lnk_open_with(&lnk.target, lnk.args.as_deref()),
                path: lnk.target.clone(),
                target: lnk.target,
                aumid: String::new(),
            });
        }
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// Every app Start itself lists, from the `AppsFolder` shell namespace.
///
/// ⛔ **The `.lnk` walk cannot see half of Start, and it is structurally blind to Store apps.**
/// Measured on this machine: 139 non-uninstaller shortcuts under the two `Programs` roots, of
/// which 94 carry LinkInfo and 87 reach the palette under a unique name — so **45 are dropped**,
/// *File Explorer*, *Command Prompt*, *Control Panel*, *Run*, *Magnify*, *Narrator*,
/// *On-Screen Keyboard* and *Neovide* among them: ID-list-only shortcuts with nothing for
/// `parse_lnk`'s VolumeID/LocalBasePath to find (`core/recent.rs`). A Store app has no shortcut
/// at all — Calculator is `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App` in `AppsFolder` and
/// nothing else, which is the whole of *"the supersearch can't find anything on the machine, it
/// missed calculator"*. `AppsFolder` holds 178 entries here against the walk's 87, and is the
/// same list Start draws, so it is the authority on what is launchable.
///
/// ⚠️ It is not a superset of what the walk gives: an `AppsFolder` item has an app id but no
/// resolved exe, and `known_apps` needs the exe. Hence `all_apps`, which keeps both.
#[cfg(windows)]
pub fn apps_folder() -> Vec<AppEntry> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::{
        BHID_EnumItems, IEnumShellItems, IShellItem, SHCreateItemFromParsingName,
        SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
    };

    crate::core::icons::ensure_com();
    // SAFETY: a valid NUL-terminated wide string for the call's duration, a null bind context
    // (allowed), and a plain COM pointer we own on the way out.
    let folder: IShellItem =
        match unsafe { SHCreateItemFromParsingName(&HSTRING::from("shell:AppsFolder"), None) } {
            Ok(f) => f,
            Err(e) => {
                log::warn!("spotlight: shell:AppsFolder would not bind: {e}");
                return Vec::new();
            }
        };
    // SAFETY: `folder` is a live IShellItem; BHID_EnumItems is a static handler GUID.
    let items: IEnumShellItems = match unsafe { folder.BindToHandler(None, &BHID_EnumItems) } {
        Ok(e) => e,
        Err(e) => {
            log::warn!("spotlight: AppsFolder has no item enumerator: {e}");
            return Vec::new();
        }
    };

    let mut out: Vec<AppEntry> = Vec::new();
    loop {
        let mut slot: [Option<IShellItem>; 1] = [None];
        // SAFETY: `items` is a live enumerator writing into a slice it may fill or leave alone.
        if unsafe { items.Next(&mut slot, None) }.is_err() {
            break;
        }
        let Some(item) = slot[0].take() else { break };
        let Some(name) = display_name(&item, SIGDN_NORMALDISPLAY) else {
            continue;
        };
        // an uninstaller is never what a palette query meant, exactly as in `apps_in`
        if name.to_lowercase().contains("uninstall") {
            continue;
        }
        let Some(aumid) = display_name(&item, SIGDN_PARENTRELATIVEPARSING) else {
            continue;
        };
        out.push(AppEntry {
            name,
            aumid,
            ..AppEntry::default()
        });
    }
    out
}

/// A shell item's display name or parsing name, whichever was asked for.
///
/// ⚠️ The shell allocates the string with the **task** allocator and hands ownership over, so
/// it is freed here and nowhere else; returning `String` is what keeps that from leaking past
/// this function.
#[cfg(windows)]
fn display_name(
    item: &windows::Win32::UI::Shell::IShellItem,
    which: windows::Win32::UI::Shell::SIGDN,
) -> Option<String> {
    use windows::Win32::System::Com::CoTaskMemFree;
    // SAFETY: `item` is live; GetDisplayName hands back a task-allocated PWSTR we own.
    let raw = unsafe { item.GetDisplayName(which) }.ok()?;
    if raw.is_null() {
        return None;
    }
    // SAFETY: a non-null PWSTR from the shell is NUL-terminated.
    let s = unsafe { raw.to_string() }.ok();
    // SAFETY: the pointer came from the task allocator and is not touched again.
    unsafe { CoTaskMemFree(Some(raw.0 as *const _)) };
    s.filter(|s| !s.is_empty())
}

/// What the palette searches: the `.lnk` walk and `AppsFolder`, merged by name.
///
/// The walk is authoritative about the disk — `target` is a real exe, which `known_apps` needs
/// and which `Reveal in explorer` needs; `AppsFolder` is authoritative about what is
/// *launchable*. Neither contains the other, so an app named by both keeps its shortcut and
/// gains the app id, and an app named by only one appears anyway. Sorted by name,
/// case-insensitively.
///
/// ⚠️ Matched on the display name because it is the only field the two sources share — the
/// walk's file stem and the folder's `SIGDN_NORMALDISPLAY` are both what Start prints. Two
/// genuinely different apps under one name would merge; `apps_in` already keeps only the first
/// of a duplicate name, so that is not a new compromise.
///
/// On macOS it is the `.app` bundles under `roots` (`core/apps_mac.rs`); on Linux the
/// `.desktop` entries under `roots/applications` (`core/apps_linux.rs`).
#[cfg(target_os = "macos")]
pub fn all_apps(roots: &[PathBuf]) -> Vec<AppEntry> {
    crate::core::apps_mac::mac_apps(roots)
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn all_apps(roots: &[PathBuf]) -> Vec<AppEntry> {
    crate::core::apps_linux::env_linux_apps(roots)
}

#[cfg(windows)]
pub fn all_apps(roots: &[PathBuf]) -> Vec<AppEntry> {
    let mut out = apps_in(roots);
    for app in apps_folder() {
        match out
            .iter_mut()
            .find(|a| a.name.eq_ignore_ascii_case(&app.name))
        {
            Some(found) => found.aumid = app.aumid,
            None => out.push(app),
        }
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// The palette's file lookup: `text` as a name substring under each root, `max_depth` deep,
/// at most `max_results` hits **per root**, all roots against one `budget`. Roots that do not
/// exist are skipped. Never more than the budget late, so the palette stays responsive.
///
/// ⛔ Per root, not in total (BUG-S2): one total cap let a recent repo's 20 READMEs fill every
/// slot in milliseconds, and the recent folder after it was never walked. The caller ranks
/// the merged list and keeps its best 20; `node_modules` is never entered (`search::skip_dir`).
pub fn find_files(
    text: &str,
    roots: &[PathBuf],
    max_depth: usize,
    max_results: usize,
    budget: Duration,
) -> Vec<FileEntry> {
    let started = Instant::now();
    let query = SearchQuery {
        text: text.to_string(),
        max_depth: Some(max_depth),
        ..SearchQuery::default()
    };
    let mut hits: Vec<FileEntry> = Vec::new();
    for root in roots {
        // ⛔ `break` on the two "we are done" conditions only. A root that is not a directory is
        // `continue` — the doc comment above promises it is *skipped*, and it used to stop the
        // loop instead, so one stopped WSL distro or unplugged drive silently killed the whole
        // file search: zero rows, zero entries scanned, no error. A remembered folder outliving
        // its volume is ordinary, so that was one unmounted share from a blind palette.
        if started.elapsed() >= budget {
            break;
        }
        // ⚠️ `is_dir` on a dead network mapping can block for a long time — `core/shell.rs`
        // records 21 s and 64 s stalls on this machine. Not solved here: the deadline check
        // above bounds the damage to one hang, which is the behaviour this already had.
        if !root.is_dir() {
            continue;
        }
        let cancel = AtomicBool::new(false);
        let mut mine = 0;
        let mut sink = |batch: Vec<FileEntry>, _scanned: u64| {
            for e in batch {
                if mine < max_results && !hits.iter().any(|h| h.path == e.path) {
                    hits.push(e);
                    mine += 1;
                }
            }
            if mine >= max_results || started.elapsed() >= budget {
                cancel.store(true, Ordering::Relaxed);
            }
        };
        // a small batch so the cancel flag is looked at often
        let _ = search::walk_every(
            std::slice::from_ref(root),
            &query,
            false,
            &cancel,
            8,
            Duration::from_millis(30),
            &mut sink,
        );
    }
    hits
}

/// `budget` for `find_files` as the command uses it.
pub fn budget_ms(ms: u64) -> Duration {
    Duration::from_millis(ms.clamp(20, 2000))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::recent::lnk_fixture::build_lnk;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn scratch(tag: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!(
            "trove-spotlight-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    #[test]
    fn apps_come_from_lnk_files_sorted_deduped_without_uninstallers() {
        let s = scratch("apps");
        let user = s.0.join("user");
        let machine = s.0.join("machine").join("Tools");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&machine).unwrap();
        let target = s.0.join("app.exe");
        std::fs::write(&target, b"x").unwrap();
        let t = target.to_string_lossy().into_owned();
        std::fs::write(user.join("Zed.lnk"), build_lnk(&t, true)).unwrap();
        std::fs::write(user.join("Uninstall Zed.lnk"), build_lnk(&t, true)).unwrap();
        std::fs::write(machine.join("Alpha.lnk"), build_lnk(&t, false)).unwrap();
        std::fs::write(machine.join("zed.lnk"), build_lnk(&t, false)).unwrap(); // dup by name
        std::fs::write(machine.join("notes.txt"), b"not a shortcut").unwrap();

        let apps = apps_in(&[user, s.0.join("machine")]);
        let names: Vec<&str> = apps.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "Zed"]);
        assert!(apps.iter().all(|a| a.target == t));
        assert!(apps[1].lnk_path.ends_with("Zed.lnk"));
    }

    #[test]
    fn missing_roots_and_broken_shortcuts_are_skipped() {
        let s = scratch("broken");
        std::fs::write(s.0.join("Garbage.lnk"), b"nope").unwrap();
        let apps = apps_in(&[s.0.join("does-not-exist"), s.0.clone()]);
        assert!(apps.is_empty());
    }

    #[test]
    fn find_files_matches_within_depth_and_stops_at_the_cap() {
        let s = scratch("files");
        let deep = s.0.join("a").join("b").join("c").join("d");
        std::fs::create_dir_all(&deep).unwrap();
        for i in 0..5 {
            std::fs::write(s.0.join(format!("report-{i}.txt")), b"x").unwrap();
        }
        std::fs::write(s.0.join("a").join("report-deep.txt"), b"x").unwrap();
        std::fs::write(deep.join("report-too-deep.txt"), b"x").unwrap();
        std::fs::write(s.0.join("other.txt"), b"x").unwrap();

        let all = find_files(
            "report",
            std::slice::from_ref(&s.0),
            3,
            50,
            Duration::from_secs(5),
        );
        let names: Vec<&str> = all.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names.len(), 6, "{names:?}");
        assert!(names.contains(&"report-deep.txt"));
        assert!(!names.contains(&"report-too-deep.txt"));
        assert!(!names.contains(&"other.txt"));

        let capped = find_files(
            "report",
            &[s.0.clone(), s.0.join("nope")],
            3,
            2,
            Duration::from_secs(5),
        );
        assert_eq!(capped.len(), 2);
    }

    /// BUG-S2: the cap was one total over every root, so a recent repo holding 30 READMEs
    /// filled all 20 slots and the recent after it (the `s2`) was never walked. Each root
    /// gets its own cap now; `node_modules` is never descended into at all.
    #[test]
    fn every_root_gets_its_own_cap_so_a_busy_root_does_not_starve_the_next() {
        let s = scratch("per-root");
        let a = s.0.join("a");
        let b = s.0.join("b");
        for i in 0..30 {
            let pkg = a.join("pkgs").join(format!("p{i}"));
            std::fs::create_dir_all(&pkg).unwrap();
            std::fs::write(pkg.join("README.md"), b"x").unwrap();
            let nm = a.join("node_modules").join(format!("m{i}"));
            std::fs::create_dir_all(&nm).unwrap();
            std::fs::write(nm.join("README.md"), b"x").unwrap();
        }
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("readme.txt"), b"x").unwrap();

        let hits = find_files(
            "readme",
            &[a.clone(), b.clone()],
            4,
            20,
            Duration::from_secs(5),
        );

        assert!(hits
            .iter()
            .any(|e| e.path == b.join("readme.txt").to_string_lossy()));
        assert!(hits.iter().all(|e| !e.path.contains("node_modules")));
        assert_eq!(
            hits.iter()
                .filter(|e| e.path.starts_with(&*a.to_string_lossy()))
                .count(),
            20
        );
        assert_eq!(hits.len(), 21);
    }

    /// ⛔ One dead root must not kill the roots behind it. `find_files`'s own doc comment says
    /// *"Roots that do not exist are skipped"* — the loop used to `break` on `!is_dir()`, so a
    /// single stopped WSL distro or unplugged drive took the **whole** file search down: zero
    /// entries scanned, zero rows, no error anywhere. The near-root list is recents first, and
    /// a remembered folder outliving its volume is ordinary, so this was one unmounted share
    /// away from "the palette can't find anything on the machine" for every query.
    ///
    /// Both shapes of `!is_dir()` are here: a path that does not exist, and a path that exists
    /// but is a file.
    #[test]
    fn a_dead_root_is_skipped_and_the_roots_after_it_are_still_searched() {
        let s = scratch("dead-root");
        let live = s.0.join("live");
        std::fs::create_dir_all(&live).unwrap();
        std::fs::write(live.join("report-here.txt"), b"x").unwrap();
        let not_a_dir = s.0.join("report-not-a-dir.txt");
        std::fs::write(&not_a_dir, b"x").unwrap();

        let hits = find_files(
            "report",
            &[s.0.join("no-such-folder"), not_a_dir, live],
            3,
            50,
            Duration::from_secs(5),
        );
        let names: Vec<&str> = hits.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            ["report-here.txt"],
            "a dead root ate the whole search"
        );
    }

    /// ⛔ The bug Joy reported, pinned against the real machine: *"the supersearch can't find
    /// anything on the machine. it missed calculator."* Calculator has **no** `.lnk` anywhere
    /// under either Start-menu root, so no walk can ever produce it; `AppsFolder` is the only
    /// place it exists. If this fails, the palette is blind to every Store app again.
    #[test]
    #[cfg(windows)]
    fn appsfolder_finds_the_store_apps_no_shortcut_walk_can_see() {
        let folder = apps_folder();
        assert!(
            folder.len() > 20,
            "AppsFolder gave {} entries — the enumerator is broken, not the machine",
            folder.len()
        );
        let calc = folder
            .iter()
            .find(|a| a.name.eq_ignore_ascii_case("Calculator"))
            .unwrap_or_else(|| panic!("no Calculator among {} AppsFolder entries", folder.len()));
        // the AUMID is the package family plus `!` plus the application id, and it is what
        // `shell:AppsFolder\<aumid>` starts; a bare path here would mean the wrong SIGDN
        assert!(calc.aumid.contains('!'), "aumid was {:?}", calc.aumid);
        assert!(
            calc.aumid.contains("Calculator"),
            "aumid was {:?}",
            calc.aumid
        );
        // and it is genuinely absent from the walk, which is why the merge exists
        assert!(
            !apps_in(&app_roots())
                .iter()
                .any(|a| a.name.eq_ignore_ascii_case("Calculator")),
            "a Calculator .lnk appeared — re-read whether the merge is still needed"
        );
    }

    /// The merge keeps both halves: an app in both sources ends up with the shortcut *and* the
    /// app id, and `AppsFolder` never costs the walk its resolved exe — `known_apps` resolves
    /// detected apps through `target` and breaks if a merge blanks it.
    #[test]
    #[cfg(windows)]
    fn merging_keeps_the_exe_from_the_walk_and_the_id_from_the_folder() {
        let apps = all_apps(&app_roots());
        assert!(
            apps.len() >= apps_in(&app_roots()).len(),
            "the merge lost rows"
        );
        assert!(
            apps.windows(2)
                .all(|w| w[0].name.to_lowercase() <= w[1].name.to_lowercase()),
            "not sorted by name"
        );
        // no row is unusable: every one can be started somehow
        assert!(
            apps.iter()
                .all(|a| !a.lnk_path.is_empty() || !a.aumid.is_empty()),
            "a row has neither a shortcut nor an app id"
        );
        // and the pairing happened at least once — a machine where it never does would mean
        // the two sources disagree about every display name
        assert!(
            apps.iter()
                .any(|a| !a.lnk_path.is_empty() && !a.aumid.is_empty()),
            "no app was found by both sources"
        );
    }

    /// The names the walk drops are exactly the ones the folder supplies: an ID-list-only
    /// shortcut has no LinkInfo for `parse_lnk`, so *File Explorer* and *Command Prompt* are
    /// missing from the walk on every Windows install, not just this one.
    #[test]
    #[cfg(windows)]
    fn the_merge_recovers_shortcuts_parse_lnk_cannot_resolve() {
        let walked = apps_in(&app_roots());
        let merged = all_apps(&app_roots());
        let has = |list: &[AppEntry], n: &str| list.iter().any(|a| a.name.eq_ignore_ascii_case(n));
        let recovered: Vec<&str> = ["File Explorer", "Command Prompt", "Control Panel"]
            .into_iter()
            .filter(|n| !has(&walked, n) && has(&merged, n))
            .collect();
        assert!(
            !recovered.is_empty(),
            "the merge recovered none of the ID-list-only shortcuts"
        );
    }

    /// The walk's own contract is unchanged by the new field: nothing invented an app id.
    #[test]
    fn the_walk_alone_never_invents_an_app_id() {
        let s = scratch("aumid");
        let root = s.0.join("progs");
        std::fs::create_dir_all(&root).unwrap();
        let target = s.0.join("app.exe");
        std::fs::write(&target, b"x").unwrap();
        std::fs::write(
            root.join("Alpha.lnk"),
            build_lnk(&target.to_string_lossy(), true),
        )
        .unwrap();
        let apps = apps_in(&[root]);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].aumid, "");
        assert!(!apps[0].target.is_empty());
    }

    /// ⛔ A shortcut that passes its own arguments (Squirrel's `Update.exe --processStart X`)
    /// must not become "target + %paths%" — that saves a command that starts the updater. And
    /// only a real `.exe` can be a program: a `.pdf`, `.url` or `.chm` target cannot.
    #[test]
    fn windows_rows_carry_open_with_only_for_an_exe_without_shortcut_args() {
        use crate::core::recent::lnk_fixture::build_lnk_with_args;
        let s = scratch("open-with");
        let root = s.0.join("progs");
        std::fs::create_dir_all(&root).unwrap();
        let file = |name: &str| {
            let p = s.0.join(name);
            std::fs::write(&p, b"x").unwrap();
            p.to_string_lossy().into_owned()
        };
        let exe = file("app.exe");
        let updater = file("Update.exe");
        let cases: [(&str, String, Option<&str>); 5] = [
            ("Plain", exe.clone(), None),
            ("Squirrel", updater, Some("--processStart Discord.exe")),
            ("Manual", file("manual.pdf"), None),
            ("Site", file("site.url"), None),
            ("Help", file("help.chm"), None),
        ];
        for (name, target, args) in &cases {
            std::fs::write(
                root.join(format!("{name}.lnk")),
                build_lnk_with_args(target, true, *args),
            )
            .unwrap();
        }
        let apps = apps_in(&[root]);
        assert_eq!(apps.len(), 5);
        for app in &apps {
            assert_eq!(app.path, app.target, "Windows path is the target");
            let want = (app.name == "Plain").then(|| OpenWith {
                program: exe.clone(),
                args: "%paths%".into(),
            });
            assert_eq!(app.open_with, want, "{}", app.name);
        }
        // an exe that is gone is not a program either
        assert_eq!(
            lnk_open_with(&s.0.join("gone.exe").to_string_lossy(), Some("")),
            None
        );
        // unreadable arguments count as "has arguments"
        assert_eq!(lnk_open_with(&exe, None), None);
    }
}

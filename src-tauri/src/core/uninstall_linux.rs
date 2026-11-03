//! Ubuntu: which package owns each app tile, and the OS's own way to remove it (plan 18, 4.1).
//!
//! The owner comes from where the `.desktop` file lives and from `dpkg -S`, never from the
//! file's text: a Flatpak export (its link resolves into `flatpak/app/<app-id>/`) → that app id;
//! snapd's folder → the snap name in the file name; a file in the person's own
//! `~/.local/share/applications` → no package (Trove never deletes it); the rest → the one
//! package `dpkg -S` names for that exact path.
//!
//! The hand-off is never silent. GNOME Software on `PATH` → `gnome-software --details=<id>`,
//! where the person presses Uninstall and polkit asks. Else the removal command is TYPED, not
//! run, into a fresh shell in Trove's terminal (`state/uninstall.svelte.ts`); Enter is the
//! person's, `sudo` asks the password, apt lists what it removes and asks Y/n.
//!
//! ⛔ Every word of a command is allow-listed here (a package, snap or Flatpak name rule), so a
//! crafted `.desktop` file or file name cannot put shell syntax into it, and the full line is
//! what the confirm shows. Never `-y`, `--assume-yes`, `--yes`, `--noninteractive`, `purge`,
//! `autoremove`, `--delete-data`: `no_assume_yes_anywhere` and
//! `no_purge_or_delete_data_anywhere` keep it that way.
//! ⛔ Read-only: the live part runs `dpkg -S`, `dpkg-query -W` and `apt-get -s` (a simulation)
//! and nothing else.
//!
//! ⛔ Apt guard: before a `Deb` row is typed or handed to GNOME Software, `apt_check` simulates
//! `apt-get -s remove <pkg>` and refuses when the removal would take an essential (or
//! required/important) package, a desktop metapackage (`ubuntu-desktop`,
//! `ubuntu-desktop-minimal`, `kubuntu-desktop`, ...) or the graphical session with it.

// The parsers are pure and tested on every OS; only Linux lists with them.
#![cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]

use super::uninstall::{stable_id, Command, Removable, Uninstallable};
use crate::core::spotlight::AppEntry;
use std::collections::HashMap;

/// snapd's `.desktop` folder; a file here is `<snap>[+<instance>]_<app>.desktop`.
pub const SNAP_APPS: &str = "/var/lib/snapd/desktop/applications/";
/// The system Flatpak exports and where their links point.
pub const FLATPAK_EXPORTS: &str = "/var/lib/flatpak/exports/share/applications/";
pub const FLATPAK_APPS: &str = "/var/lib/flatpak/app/";

/// Who owns an app tile, by the rules in the module doc. The names are already allow-listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owner {
    Deb(String),
    Snap(String),
    Flatpak(String),
    /// no package Trove can name: a user's own `.desktop`, an unowned or ambiguous file
    None,
}

/// Where a `.desktop` path sits, before `dpkg -S` is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Snap(Owner),
    Flatpak(Owner),
    /// the person's own entry: no package, never deleted by Trove
    UserLocal,
    /// ask `dpkg -S`
    Deb,
}

/// Debian package name rule (Policy 5.6.1): `^[a-z0-9][a-z0-9+.-]+$`.
pub fn valid_deb(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() >= 2
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"+.-".contains(c))
}

/// snapd's name rule: lower-case letters, digits and single inner hyphens, at least one letter,
/// at most 40; an instance key is 1-10 lower-case letters or digits.
pub fn valid_snap(name: &str) -> bool {
    let (snap, key) = match name.split_once('_') {
        Some((s, k)) => (s, Some(k)),
        None => (name, None),
    };
    let snap_ok = (1..=40).contains(&snap.len())
        && snap
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && snap.bytes().any(|c| c.is_ascii_lowercase())
        && !snap.starts_with('-')
        && !snap.ends_with('-')
        && !snap.contains("--");
    let key_ok = key.is_none_or(|k| {
        (1..=10).contains(&k.len())
            && k.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    });
    snap_ok && key_ok
}

/// Flatpak's app id rule: at least three dot-separated parts, each `[A-Za-z_][A-Za-z0-9_-]*`,
/// 255 bytes at most.
pub fn valid_flatpak(id: &str) -> bool {
    let parts: Vec<&str> = id.split('.').collect();
    id.len() <= 255
        && parts.len() >= 3
        && parts.iter().all(|p| {
            let b = p.as_bytes();
            !b.is_empty()
                && (b[0].is_ascii_alphabetic() || b[0] == b'_')
                && b.iter()
                    .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
        })
}

/// A desktop id GNOME Software may be handed: `[A-Za-z0-9._-]+.desktop`.
pub fn valid_desktop_id(id: &str) -> bool {
    id.len() > ".desktop".len()
        && id.ends_with(".desktop")
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

/// A path `dpkg -S` may be given: no glob characters (it treats `*?[` as a pattern), no spaces,
/// absolute. Anything else is never asked about and has no package.
pub fn dpkg_safe_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains("/../")
        && path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/._+-@".contains(&c))
}

/// Where Flatpak keeps the per-user installation, the way Flatpak itself picks it:
/// `$FLATPAK_USER_DIR` when absolute, else `$XDG_DATA_HOME/flatpak` when `$XDG_DATA_HOME` is
/// absolute, else `~/.local/share/flatpak`. No trailing slash. Pure.
pub fn flatpak_user_base(
    home: Option<&str>,
    data_home: Option<&str>,
    flatpak_user_dir: Option<&str>,
) -> Option<String> {
    let absolute = |s: &&str| s.starts_with('/');
    if let Some(d) = flatpak_user_dir.filter(absolute) {
        return Some(d.trim_end_matches('/').to_string());
    }
    if let Some(d) = data_home.filter(absolute) {
        return Some(format!("{}/flatpak", d.trim_end_matches('/')));
    }
    home.map(|h| format!("{}/.local/share/flatpak", h.trim_end_matches('/')))
}

/// Where `path` sits. `canonical` is the file with every link resolved (a Flatpak export is a
/// link into `flatpak/app/<id>/`); `home` the person's home; `data_home` their
/// `$XDG_DATA_HOME` (`~/.local/share` when unset); `flatpak_user_dir` their
/// `$FLATPAK_USER_DIR`. The user's Flatpak installation is found the way Flatpak finds it.
pub fn source_of(
    path: &str,
    canonical: Option<&str>,
    home: Option<&str>,
    data_home: Option<&str>,
    flatpak_user_dir: Option<&str>,
) -> Source {
    if let Some(file) = path.strip_prefix(SNAP_APPS) {
        let name = file
            .strip_suffix(".desktop")
            .and_then(|stem| stem.split_once('_'))
            .map(|(snap, _app)| snap.replacen('+', "_", 1))
            .filter(|n| !file.contains('/') && valid_snap(n));
        return Source::Snap(name.map_or(Owner::None, Owner::Snap));
    }
    let home = home.map(|h| h.trim_end_matches('/'));
    let flatpak_base = flatpak_user_base(home, data_home, flatpak_user_dir);
    let user_flatpak = flatpak_base
        .as_ref()
        .map(|b| format!("{b}/exports/share/applications/"));
    let user_flatpak_apps = flatpak_base.as_ref().map(|b| format!("{b}/app/"));
    let in_flatpak = path.starts_with(FLATPAK_EXPORTS)
        || user_flatpak.as_deref().is_some_and(|u| path.starts_with(u));
    if in_flatpak {
        let id = canonical.and_then(|c| {
            let rest = c
                .strip_prefix(FLATPAK_APPS)
                .or_else(|| user_flatpak_apps.as_deref().and_then(|u| c.strip_prefix(u)))?;
            rest.split('/').next().map(String::from)
        });
        let id = id.filter(|i| valid_flatpak(i));
        return Source::Flatpak(id.map_or(Owner::None, Owner::Flatpak));
    }
    let user_apps = match data_home.filter(|d| d.starts_with('/')) {
        Some(d) => Some(format!("{}/applications/", d.trim_end_matches('/'))),
        None => home.map(|h| format!("{h}/.local/share/applications/")),
    };
    let default_user_apps = home.map(|h| format!("{h}/.local/share/applications/"));
    if [user_apps, default_user_apps]
        .iter()
        .flatten()
        .any(|u| path.starts_with(u.as_str()))
    {
        return Source::UserLocal;
    }
    Source::Deb
}

/// `dpkg -S` output → path → package. A multi-arch `libfoo:amd64` loses its `:amd64`; a path
/// two packages claim, a diversion line, or a name that breaks the Debian rule is left out (no
/// package — never a guess).
pub fn parse_dpkg_s(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        if line.starts_with("diversion by ") {
            continue;
        }
        let Some((pkgs, rest)) = line.split_once(": /") else {
            continue;
        };
        let names: Vec<&str> = pkgs
            .split(", ")
            .map(|p| p.split_once(':').map_or(p, |(n, _arch)| n).trim())
            .collect();
        let first = names[0];
        if names.iter().any(|n| *n != first) || !valid_deb(first) {
            continue;
        }
        out.insert(format!("/{rest}"), first.to_string());
    }
    out
}

/// What `dpkg-query` says about one package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DebInfo {
    pub version: String,
    /// `Essential: yes` or `Priority: required|important` — Ubuntu needs it
    pub system: bool,
}

/// `dpkg-query -W -f='${Package}\t${Version}\t${Essential}\t${Priority}\n'` output → package → info.
pub fn parse_dpkg_query(text: &str) -> HashMap<String, DebInfo> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() != 4 || !valid_deb(f[0]) {
            continue;
        }
        let system = f[2] == "yes" || matches!(f[3], "required" | "important");
        out.entry(f[0].to_string()).or_insert(DebInfo {
            version: f[1].to_string(),
            system,
        });
    }
    out
}

/// What `apt-get -s remove <pkg>` (under `LC_ALL=C`) says it would do.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AptSim {
    /// every `Remv`/`Purg` line's package, `:arch` dropped, in order
    pub removed: Vec<String>,
    /// apt printed its "essential packages will be removed" warning
    pub essential_warning: bool,
    /// a `Remv` line whose package breaks the Debian name rule: the output cannot be trusted
    pub unreadable: bool,
}

/// Parse a simulation: `Remv nautilus [1:46.4-0ubuntu0.2]`, `Remv libx:amd64 [1]`, apt's
/// essential warning. Everything else (`Inst`, `Conf`, notes) is ignored.
pub fn parse_apt_sim(text: &str) -> AptSim {
    let mut sim = AptSim::default();
    for line in text.lines() {
        if line.starts_with("WARNING: The following essential packages will be removed") {
            sim.essential_warning = true;
            continue;
        }
        let Some(rest) = line
            .strip_prefix("Remv ")
            .or_else(|| line.strip_prefix("Purg "))
        else {
            continue;
        };
        let word = rest.split(' ').next().unwrap_or("");
        let name = word.split_once(':').map_or(word, |(n, _arch)| n);
        if valid_deb(name) {
            sim.removed.push(name.to_string());
        } else {
            sim.unreadable = true;
        }
    }
    sim
}

/// The graphical session itself: without these there is no desktop to log in to.
pub const SESSION_PACKAGES: &[&str] = &["gdm3", "gnome-shell", "ubuntu-session", "xorg"];

/// A desktop metapackage: `<flavour>-desktop` (`ubuntu-desktop`, `kubuntu-desktop`,
/// `ubuntu-mate-desktop`, `task-gnome-desktop`) or an Ubuntu flavour's one-word variant of it
/// (`ubuntu-desktop-minimal`, `ubuntustudio-desktop-core`). An extension that merely has
/// `desktop` in its name (`gnome-shell-extension-desktop-icons-ng`) is not one.
pub fn is_desktop_meta(name: &str) -> bool {
    if name.ends_with("-desktop") {
        return true;
    }
    name.split_once("-desktop-")
        .is_some_and(|(flavour, variant)| {
            !variant.is_empty()
                && !variant.contains('-')
                && (flavour.contains("buntu") || flavour.starts_with("task-"))
        })
}

/// Why a simulated removal is refused, or `Ok` when apt would remove only ordinary packages.
/// `info` is `dpkg-query` over `sim.removed`. ⛔ Anything Trove cannot read is a refusal: an
/// unreadable line, a simulation that does not remove `target`, a removed package `dpkg-query`
/// says nothing about.
pub fn apt_verdict(
    target: &str,
    sim: &AptSim,
    info: &HashMap<String, DebInfo>,
) -> Result<(), String> {
    if sim.unreadable || !sim.removed.iter().any(|p| p == target) {
        return Err(unchecked(target));
    }
    let mut needed = Vec::new();
    let mut desktop = Vec::new();
    for p in &sim.removed {
        let Some(i) = info.get(p) else {
            return Err(unchecked(target));
        };
        if i.system {
            needed.push(p.as_str());
        } else if SESSION_PACKAGES.contains(&p.as_str()) || (p != target && is_desktop_meta(p)) {
            // a `*-desktop` target is an ordinary app (telegram-desktop); only the session
            // packages are refused when picked directly
            desktop.push(p.as_str());
        }
    }
    if needed.is_empty() && desktop.is_empty() && !sim.essential_warning {
        return Ok(());
    }
    let list = |names: &[&str]| {
        let shown = names.iter().take(5).copied().collect::<Vec<_>>().join(", ");
        match names.len() {
            n if n > 5 => format!("{shown} and {} more", n - 5),
            _ => shown,
        }
    };
    let mut why = Vec::new();
    if !needed.is_empty() {
        why.push(format!("{} (Ubuntu needs it)", list(&needed)));
    }
    if !desktop.is_empty() {
        why.push(format!("{} (your desktop)", list(&desktop)));
    }
    if why.is_empty() {
        why.push("packages apt calls essential".into());
    }
    Err(format!(
        "Trove will not remove {target}: apt would also remove {}. Nothing was typed or started.",
        why.join(" and ")
    ))
}

/// The refusal when the simulation cannot be read or did not run.
fn unchecked(target: &str) -> String {
    format!(
        "Trove could not check what removing {target} would also remove, so it will not offer it."
    )
}

/// The live guard: one `apt-get -s remove <pkg>` (a simulation: no root, no lock, nothing
/// removed) and one `dpkg-query -W` over what it lists, both as argument vectors.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn apt_check(pkg: &str) -> Result<(), String> {
    use std::process::{Command as Proc, Stdio};
    if !valid_deb(pkg) {
        return Err("That package name is not one Trove can check.".into());
    }
    // valid_deb: the name starts with a letter or digit, so apt never reads it as an option
    let out = Proc::new("apt-get")
        .args(["-s", "remove", pkg])
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| unchecked(pkg))?;
    if !out.status.success() {
        return Err(unchecked(pkg));
    }
    let sim = parse_apt_sim(&String::from_utf8_lossy(&out.stdout));
    let info = if sim.removed.is_empty() {
        HashMap::new()
    } else {
        let mut q = vec![
            "-W".to_string(),
            "-f=${Package}\t${Version}\t${Essential}\t${Priority}\n".to_string(),
            "--".to_string(),
        ];
        q.extend(sim.removed.iter().cloned());
        let o = Proc::new("dpkg-query")
            .args(&q)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|_| unchecked(pkg))?;
        parse_dpkg_query(&String::from_utf8_lossy(&o.stdout))
    };
    apt_verdict(pkg, &sim, &info)
}

/// The one line that hands the job to the OS, and whether it is typed (true) or started (false).
/// `None` when no allow-listed command exists.
pub fn hand_off(
    owner: &Owner,
    desktop_id: &str,
    has_gnome_software: bool,
) -> Option<(String, bool)> {
    if matches!(owner, Owner::None) {
        return None;
    }
    if has_gnome_software && valid_desktop_id(desktop_id) {
        return Some((format!("gnome-software --details={desktop_id}"), false));
    }
    let line = match owner {
        Owner::Deb(p) if valid_deb(p) => format!("sudo apt remove {p}"),
        Owner::Snap(s) if valid_snap(s) => format!("snap remove {s}"),
        Owner::Flatpak(f) if valid_flatpak(f) => format!("flatpak uninstall {f}"),
        _ => return None,
    };
    Some((line, true))
}

/// Trove's bundle identifier (`identifier` in `tauri.conf.json`; a test keeps the two equal).
/// A Flatpak of Trove carries it as its app id.
pub const TROVE_IDENTIFIER: &str = "com.joyahmed.trove";

/// The snap names and Flatpak ids that are this very Trove: their rows are `Removable::Trove`,
/// so Trove never offers to uninstall itself (the deb case is `Ctx::trove_pkg`).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TroveSelf {
    pub snaps: Vec<String>,
    pub flatpaks: Vec<String>,
}

/// The snap a path runs from: `/snap/<instance>/...` → `<instance>`.
fn snap_of_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/snap/")?;
    rest.split('/').next().map(String::from)
}

/// Who Trove is when packaged. Snap: `SNAP_INSTANCE_NAME`, `SNAP_NAME`, and the snap that
/// `exe` or `$SNAP` sits in under `/snap/<name>/`. Flatpak: `FLATPAK_ID`, and Trove's own
/// identifier (any Flatpak with that id is a Trove). Names that break the snap / Flatpak rules
/// are dropped, never matched.
pub fn trove_self(
    snap_name: Option<&str>,
    snap_instance: Option<&str>,
    snap_env: Option<&str>,
    exe: Option<&str>,
    flatpak_id: Option<&str>,
    identifier: &str,
) -> TroveSelf {
    // ⛔ the env vars are inherited: a deb Trove started from a snap terminal (VS Code) carries
    // that snap's SNAP_NAME. Trust them only when Trove itself runs from /snap/.
    let in_snap = exe.and_then(snap_of_path).is_some();
    let mut snaps: Vec<String> = [snap_instance, snap_name]
        .into_iter()
        .flatten()
        .filter(|_| in_snap)
        .map(String::from)
        .chain(snap_env.filter(|_| in_snap).and_then(snap_of_path))
        .chain(exe.and_then(snap_of_path))
        .filter(|s| valid_snap(s))
        .collect();
    snaps.sort();
    snaps.dedup();
    let mut flatpaks: Vec<String> = flatpak_id
        .into_iter()
        .chain(Some(identifier))
        .filter(|f| valid_flatpak(f))
        .map(String::from)
        .collect();
    flatpaks.sort();
    flatpaks.dedup();
    TroveSelf { snaps, flatpaks }
}

/// What the pure part needs to know about the machine, so tests can fake it.
pub struct Ctx<'a> {
    pub home: Option<&'a str>,
    pub data_home: Option<&'a str>,
    /// `$FLATPAK_USER_DIR`
    pub flatpak_user_dir: Option<&'a str>,
    /// a `.desktop` path with every link resolved
    pub canonical: &'a dyn Fn(&str) -> Option<String>,
    /// the file's bytes, read now: an edited entry gets a new id
    pub contents: &'a dyn Fn(&str) -> Option<Vec<u8>>,
    /// `parse_dpkg_s` of one `dpkg -S` over every Deb-source path (and Trove's own exe)
    pub deb_owner: &'a HashMap<String, String>,
    pub deb_info: &'a HashMap<String, DebInfo>,
    pub has_gnome_software: bool,
    /// the package that owns Trove's own executable, if any
    pub trove_pkg: Option<&'a str>,
    /// the snap names and Flatpak ids that are Trove itself
    pub trove_self: &'a TroveSelf,
}

/// The owner of one tile, `dpkg -S` already asked.
pub fn owner_of(app: &AppEntry, ctx: &Ctx) -> Owner {
    let canonical = (ctx.canonical)(&app.path);
    match source_of(
        &app.path,
        canonical.as_deref(),
        ctx.home,
        ctx.data_home,
        ctx.flatpak_user_dir,
    ) {
        Source::Snap(o) | Source::Flatpak(o) => o,
        Source::UserLocal => Owner::None,
        Source::Deb => ctx
            .deb_owner
            .get(&app.path)
            .filter(|p| valid_deb(p))
            .map_or(Owner::None, |p| Owner::Deb(p.clone())),
    }
}

/// One row per tile (every listed `.desktop` file), joined by its exact `path`.
pub fn rows(apps: &[AppEntry], ctx: &Ctx) -> Vec<Uninstallable> {
    apps.iter()
        .filter_map(|app| {
            // ⛔ the id covers the path AND the file's bytes now: a rewritten entry (another
            // Exec, another package) is a different id, and the old one is refused
            let bytes = (ctx.contents)(&app.path)?;
            let id = stable_id(&["linux", &app.path, &String::from_utf8_lossy(&bytes)]);
            let owner = owner_of(app, ctx);
            let (version, mut removable) = match &owner {
                Owner::Deb(p) => match ctx.deb_info.get(p) {
                    Some(i) if i.system => (i.version.clone(), Removable::System),
                    Some(i) => (i.version.clone(), Removable::Yes),
                    None => (String::new(), Removable::NoUninstaller),
                },
                Owner::Snap(_) | Owner::Flatpak(_) => (String::new(), Removable::Yes),
                Owner::None => (String::new(), Removable::NoUninstaller),
            };
            let is_trove = match &owner {
                Owner::Deb(p) => ctx.trove_pkg == Some(p.as_str()),
                Owner::Snap(s) => ctx.trove_self.snaps.contains(s),
                Owner::Flatpak(f) => ctx.trove_self.flatpaks.contains(f),
                Owner::None => false,
            };
            if is_trove {
                removable = Removable::Trove;
            }
            let line = hand_off(&owner, &app.aumid, ctx.has_gnome_software);
            if line.is_none() && removable == Removable::Yes {
                removable = Removable::NoUninstaller;
            }
            let (program, typed) = match (&line, removable) {
                (Some((l, t)), Removable::Yes) => (l.clone(), *t),
                _ => (String::new(), false),
            };
            Some(Uninstallable {
                id,
                name: app.name.clone(),
                version,
                publisher: String::new(),
                folder: String::new(),
                path: app.path.clone(),
                removable,
                command: (!program.is_empty()).then(|| Command {
                    program: program.clone(),
                    params: String::new(),
                    dir: String::new(),
                }),
                program,
                typed,
                stamp: String::new(),
                deb: match (&owner, removable) {
                    (Owner::Deb(p), Removable::Yes) => Some(p.clone()),
                    _ => None,
                },
            })
        })
        .collect()
}

/// The live list: the same `.desktop` entries the Applications place shows, one `dpkg -S` and
/// one `dpkg-query -W` (both read-only), and a `PATH` lookup for GNOME Software.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn list() -> Result<Vec<Uninstallable>, String> {
    use crate::core::spotlight;
    use std::process::{Command as Proc, Stdio};

    let apps = spotlight::all_apps(&spotlight::app_roots());
    let home = std::env::var("HOME").ok();
    let data_home = std::env::var("XDG_DATA_HOME").ok();
    let flatpak_user_dir = std::env::var("FLATPAK_USER_DIR").ok();
    let canonical = |p: &str| {
        std::fs::canonicalize(p)
            .ok()
            .map(|c| c.to_string_lossy().into_owned())
    };
    let trove_exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|p| dpkg_safe_path(p));

    let mut ask: Vec<String> = apps
        .iter()
        .filter(|a| {
            dpkg_safe_path(&a.path)
                && source_of(
                    &a.path,
                    None,
                    home.as_deref(),
                    data_home.as_deref(),
                    flatpak_user_dir.as_deref(),
                ) == Source::Deb
        })
        .map(|a| a.path.clone())
        .collect();
    ask.extend(trove_exe.clone());
    let read = |args: &[String], cmd: &str| -> String {
        if args.is_empty() {
            return String::new();
        }
        // exit 1 only means some path has no package; what it found is still on stdout
        Proc::new(cmd)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    };
    let mut s_args = vec!["-S".to_string(), "--".to_string()];
    s_args.extend(ask.iter().cloned());
    let deb_owner = if ask.is_empty() {
        HashMap::new()
    } else {
        parse_dpkg_s(&read(&s_args, "dpkg"))
    };
    let mut pkgs: Vec<String> = deb_owner.values().cloned().collect();
    pkgs.sort();
    pkgs.dedup();
    let mut q_args = vec![
        "-W".to_string(),
        "-f=${Package}\t${Version}\t${Essential}\t${Priority}\n".to_string(),
        "--".to_string(),
    ];
    q_args.extend(pkgs.iter().cloned());
    let deb_info = if pkgs.is_empty() {
        HashMap::new()
    } else {
        parse_dpkg_query(&read(&q_args, "dpkg-query"))
    };
    let trove_pkg = trove_exe.and_then(|e| deb_owner.get(&e).cloned());
    let env = |k: &str| std::env::var(k).ok();
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let trove_self = trove_self(
        env("SNAP_NAME").as_deref(),
        env("SNAP_INSTANCE_NAME").as_deref(),
        env("SNAP").as_deref(),
        exe.as_deref(),
        env("FLATPAK_ID").as_deref(),
        TROVE_IDENTIFIER,
    );
    let path_var = std::env::var_os("PATH");
    let has_gnome_software =
        crate::core::apps_linux::find_on_path("gnome-software", path_var.as_deref()).is_some();
    let contents = |p: &str| std::fs::read(p).ok();
    Ok(rows(
        &apps,
        &Ctx {
            home: home.as_deref(),
            data_home: data_home.as_deref(),
            flatpak_user_dir: flatpak_user_dir.as_deref(),
            canonical: &canonical,
            contents: &contents,
            deb_owner: &deb_owner,
            deb_info: &deb_info,
            has_gnome_software,
            trove_pkg: trove_pkg.as_deref(),
            trove_self: &trove_self,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/home/ana";

    fn app(name: &str, id: &str, path: &str) -> AppEntry {
        AppEntry {
            name: name.into(),
            aumid: id.into(),
            path: path.into(),
            ..AppEntry::default()
        }
    }

    fn fixtures() -> (HashMap<String, String>, HashMap<String, DebInfo>) {
        let owners = parse_dpkg_s(
            "gnome-mines: /usr/share/applications/org.gnome.Mines.desktop\n\
             coreutils: /usr/share/applications/coreutils-fake.desktop\n\
             trove: /usr/bin/trove\n\
             trove: /usr/share/applications/trove.desktop\n",
        );
        let info = parse_dpkg_query(
            "gnome-mines\t1:40.1-1\tno\toptional\n\
             coreutils\t9.4-3ubuntu6\tyes\trequired\n\
             trove\t0.9.0\tno\toptional\n",
        );
        (owners, info)
    }

    fn canonical(p: &str) -> Option<String> {
        p.strip_prefix(FLATPAK_EXPORTS)
            .map(|f| {
                let id = f.trim_end_matches(".desktop");
                format!("{FLATPAK_APPS}{id}/x86_64/stable/abc/export/share/applications/{f}")
            })
            .or(Some(p.to_string()))
    }

    fn with_ctx<T>(gs: bool, f: impl FnOnce(&Ctx) -> T) -> T {
        let (owners, info) = fixtures();
        let contents = |p: &str| Some(format!("[Desktop Entry]\nExec={p}\n").into_bytes());
        let me = TroveSelf::default();
        let ctx = Ctx {
            home: Some(HOME),
            data_home: None,
            flatpak_user_dir: None,
            canonical: &canonical,
            contents: &contents,
            deb_owner: &owners,
            deb_info: &info,
            has_gnome_software: gs,
            trove_pkg: Some("trove"),
            trove_self: &me,
        };
        f(&ctx)
    }

    fn mines() -> AppEntry {
        app(
            "Mines",
            "org.gnome.Mines.desktop",
            "/usr/share/applications/org.gnome.Mines.desktop",
        )
    }
    fn hello_snap() -> AppEntry {
        app(
            "Hello",
            "hello-world_hello-world.desktop",
            "/var/lib/snapd/desktop/applications/hello-world_hello-world.desktop",
        )
    }
    fn flat() -> AppEntry {
        app(
            "Deskflow",
            "org.deskflow.deskflow.desktop",
            "/var/lib/flatpak/exports/share/applications/org.deskflow.deskflow.desktop",
        )
    }

    /// Every command any fixture builds, both hand-off kinds.
    fn every_command() -> Vec<String> {
        let apps = [mines(), hello_snap(), flat()];
        let mut out = Vec::new();
        for gs in [false, true] {
            with_ctx(gs, |ctx| {
                out.extend(rows(&apps, ctx).into_iter().map(|r| r.program));
            });
        }
        assert_eq!(out.len(), 6);
        out
    }

    #[test]
    fn flatpak_and_snap_are_told_apart() {
        let rows = with_ctx(false, |c| rows(&[hello_snap(), flat()], c));
        assert_eq!(rows[0].program, "snap remove hello-world");
        assert_eq!(rows[1].program, "flatpak uninstall org.deskflow.deskflow");
        assert!(rows
            .iter()
            .all(|r| r.typed && r.removable == Removable::Yes));
        // a snap instance (`name+key`) is removed as `name_key`
        assert_eq!(
            source_of(
                &format!("{SNAP_APPS}hello-world+beta_hello-world.desktop"),
                None,
                None,
                None,
                None
            ),
            Source::Snap(Owner::Snap("hello-world_beta".into()))
        );
        // the user's own Flatpak exports, resolved into their own flatpak/app
        let user =
            format!("{HOME}/.local/share/flatpak/exports/share/applications/org.a.B.desktop");
        let canon = format!("{HOME}/.local/share/flatpak/app/org.a.B/x86_64/stable/1/export/x");
        assert_eq!(
            source_of(&user, Some(&canon), Some(HOME), None, None),
            Source::Flatpak(Owner::Flatpak("org.a.B".into()))
        );
        // XDG_DATA_HOME moved: the user installation is <data_home>/flatpak
        let moved = "/data/ana/flatpak/exports/share/applications/org.a.B.desktop";
        let moved_canon = "/data/ana/flatpak/app/org.a.B/x86_64/stable/1/export/x";
        assert_eq!(
            source_of(
                moved,
                Some(moved_canon),
                Some(HOME),
                Some("/data/ana"),
                None
            ),
            Source::Flatpak(Owner::Flatpak("org.a.B".into()))
        );
        // FLATPAK_USER_DIR wins over XDG_DATA_HOME
        let fp = "/fp/user/exports/share/applications/org.a.B.desktop";
        let fp_canon = "/fp/user/app/org.a.B/x86_64/stable/1/export/x";
        assert_eq!(
            source_of(
                fp,
                Some(fp_canon),
                Some(HOME),
                Some("/data/ana"),
                Some("/fp/user")
            ),
            Source::Flatpak(Owner::Flatpak("org.a.B".into()))
        );
        // ... and the moved XDG dir is then not a Flatpak dir
        assert_ne!(
            source_of(
                moved,
                Some(moved_canon),
                Some(HOME),
                Some("/data/ana"),
                Some("/fp/user")
            ),
            Source::Flatpak(Owner::Flatpak("org.a.B".into()))
        );
        // the default ~/.local/share/flatpak is not the user installation once it moved
        assert_ne!(
            source_of(&user, Some(&canon), Some(HOME), Some("/data/ana"), None),
            Source::Flatpak(Owner::Flatpak("org.a.B".into()))
        );
        // an export whose link does not resolve into flatpak/app has no owner
        assert_eq!(
            source_of(
                &flat().path,
                Some("/tmp/evil/org.x.Y"),
                Some(HOME),
                None,
                None
            ),
            Source::Flatpak(Owner::None)
        );
    }

    #[test]
    fn flatpak_user_base_follows_flatpak() {
        let h = Some("/home/alex");
        // default
        assert_eq!(
            flatpak_user_base(h, None, None).as_deref(),
            Some("/home/alex/.local/share/flatpak")
        );
        // XDG_DATA_HOME moved
        assert_eq!(
            flatpak_user_base(h, Some("/data/xdg/"), None).as_deref(),
            Some("/data/xdg/flatpak")
        );
        // relative XDG_DATA_HOME is ignored
        assert_eq!(
            flatpak_user_base(h, Some("rel"), None).as_deref(),
            Some("/home/alex/.local/share/flatpak")
        );
        // FLATPAK_USER_DIR wins; relative is ignored
        assert_eq!(
            flatpak_user_base(h, Some("/data/xdg"), Some("/fp/user/")).as_deref(),
            Some("/fp/user")
        );
        assert_eq!(
            flatpak_user_base(h, Some("/data/xdg"), Some("fp")).as_deref(),
            Some("/data/xdg/flatpak")
        );
        assert_eq!(flatpak_user_base(None, None, None), None);
    }

    #[test]
    fn dpkg_s_maps_files_to_packages() {
        let m = parse_dpkg_s(
            "nautilus: /usr/share/applications/org.gnome.Nautilus.desktop\n\
             libfoo:amd64: /usr/share/applications/foo.desktop\n\
             a, b: /usr/share/applications/shared.desktop\n\
             diversion by x from: /usr/share/applications/d.desktop\n\
             Bad_Name: /usr/share/applications/bad.desktop\n\
             dpkg-query: no path found matching pattern /nope.desktop\n",
        );
        assert_eq!(
            m["/usr/share/applications/org.gnome.Nautilus.desktop"],
            "nautilus"
        );
        assert_eq!(m["/usr/share/applications/foo.desktop"], "libfoo");
        assert!(
            !m.contains_key("/usr/share/applications/shared.desktop"),
            "two owners: no guess"
        );
        assert!(!m.contains_key("/usr/share/applications/d.desktop"));
        assert!(!m.contains_key("/usr/share/applications/bad.desktop"));
        assert_eq!(m.len(), 2);
        // a tile dpkg does not own has no uninstaller
        let r = with_ctx(false, |c| {
            rows(
                &[app(
                    "Loose",
                    "loose.desktop",
                    "/usr/local/share/applications/loose.desktop",
                )],
                c,
            )
        });
        assert_eq!(r[0].removable, Removable::NoUninstaller);
        assert!(r[0].command.is_none() && r[0].program.is_empty());
    }

    #[test]
    fn essential_packages_are_system() {
        let core = app(
            "Core",
            "coreutils-fake.desktop",
            "/usr/share/applications/coreutils-fake.desktop",
        );
        let trove = app(
            "Trove",
            "trove.desktop",
            "/usr/share/applications/trove.desktop",
        );
        let r = with_ctx(false, |c| rows(&[core, trove, mines()], c));
        assert_eq!(r[0].removable, Removable::System);
        assert_eq!(r[1].removable, Removable::Trove);
        assert_eq!(r[2].removable, Removable::Yes);
        assert_eq!(r[2].version, "1:40.1-1");
        // only a removable row carries something to run
        assert!(r[0].command.is_none() && r[1].command.is_none());
        let q = parse_dpkg_query("aa\t1\tno\timportant\nbb\t1\tno\textra\n");
        assert!(q["aa"].system && !q["bb"].system);
    }

    #[test]
    fn gnome_software_first() {
        let r = with_ctx(true, |c| rows(&[mines(), hello_snap()], c));
        assert_eq!(
            r[0].program,
            "gnome-software --details=org.gnome.Mines.desktop"
        );
        assert!(
            !r[0].typed,
            "GNOME Software is started; the person presses Uninstall there"
        );
        assert_eq!(
            r[1].program,
            "gnome-software --details=hello-world_hello-world.desktop"
        );
        let r = with_ctx(false, |c| rows(&[mines()], c));
        assert_eq!(r[0].program, "sudo apt remove gnome-mines");
        assert!(r[0].typed);
        // the command Trove would act on is exactly the line the confirm shows
        assert_eq!(
            r[0].command.as_ref().map(|c| c.program.as_str()),
            Some(r[0].program.as_str())
        );
    }

    #[test]
    fn terminal_command_has_no_newline() {
        for c in every_command() {
            assert!(!c.contains('\n') && !c.contains('\r'), "{c:?}");
        }
    }

    #[test]
    fn no_assume_yes_anywhere() {
        for c in every_command() {
            for w in c.split(' ') {
                assert!(
                    !matches!(
                        w,
                        "-y" | "--yes" | "--assume-yes" | "--noninteractive" | "-q"
                    ) && !w.starts_with("-y"),
                    "{c}"
                );
            }
        }
    }

    #[test]
    fn no_purge_or_delete_data_anywhere() {
        for c in every_command() {
            for bad in ["purge", "autoremove", "--delete-data", "--purge"] {
                assert!(!c.contains(bad), "{c}");
            }
        }
    }

    #[test]
    fn bad_package_names_are_refused() {
        for bad in [
            "", "a", "Foo", "foo;rm", "foo bar", "-rf", "foo$(x)", "../x", "foo`x`",
        ] {
            assert!(!valid_deb(bad), "{bad}");
            assert_eq!(hand_off(&Owner::Deb(bad.into()), "x.desktop", false), None);
        }
        assert!(valid_deb("g++-13") && valid_deb("libc6") && valid_deb("0ad"));
        for bad in [
            "",
            "-x",
            "x-",
            "a--b",
            "123",
            "Hello",
            "a;b",
            "hello_",
            "hello_TOOLONGKEY1",
        ] {
            assert!(!valid_snap(bad), "{bad}");
        }
        assert!(valid_snap("hello-world") && valid_snap("hello-world_beta"));
        for bad in ["org.x", "org..x.y", "org.x.y;rm", "1org.x.y", "org.x.y z"] {
            assert!(!valid_flatpak(bad), "{bad}");
        }
        assert!(valid_flatpak("org.gnome.Mines") && valid_flatpak("com.github.a_b.Foo-bar"));
        // a crafted snap file name never reaches a command
        assert_eq!(
            source_of(
                &format!("{SNAP_APPS}evil;rm -rf ~_x.desktop"),
                None,
                None,
                None,
                None
            ),
            Source::Snap(Owner::None)
        );
        // a crafted desktop id is not handed to GNOME Software; the package line is used instead
        assert_eq!(
            hand_off(&Owner::Deb("gnome-mines".into()), "a;b.desktop", true),
            Some(("sudo apt remove gnome-mines".into(), true))
        );
        // dpkg -S is never asked about a glob or a space
        assert!(!dpkg_safe_path("/usr/share/applications/*.desktop"));
        assert!(!dpkg_safe_path("/usr/share/applications/a b.desktop"));
        assert!(!dpkg_safe_path("relative.desktop"));
        assert!(dpkg_safe_path(
            "/usr/share/applications/org.gnome.Mines.desktop"
        ));
    }

    #[test]
    fn user_local_desktop_file_is_no_uninstaller() {
        let own = app(
            "Mine",
            "mine.desktop",
            &format!("{HOME}/.local/share/applications/mine.desktop"),
        );
        assert_eq!(
            source_of(&own.path, None, Some(HOME), None, None),
            Source::UserLocal
        );
        // XDG_DATA_HOME moved: its applications/ is the person's too
        assert_eq!(
            source_of(
                "/data/ana/applications/x.desktop",
                None,
                Some(HOME),
                Some("/data/ana"),
                None
            ),
            Source::UserLocal
        );
        let r = with_ctx(true, |c| rows(&[own], c));
        assert_eq!(r[0].removable, Removable::NoUninstaller);
        assert!(r[0].command.is_none());
    }

    #[test]
    fn trove_self_reads_snap_and_flatpak_identity() {
        // not packaged: only the identifier, which no snap shares
        let plain = trove_self(
            None,
            None,
            None,
            Some("/usr/bin/trove"),
            None,
            TROVE_IDENTIFIER,
        );
        assert!(plain.snaps.is_empty());
        assert_eq!(plain.flatpaks, vec![TROVE_IDENTIFIER.to_string()]);
        // a parallel-installed snap: instance, name and the /snap/<instance>/ paths
        let snap = trove_self(
            Some("trove"),
            Some("trove_beta"),
            Some("/snap/trove_beta/42"),
            Some("/snap/trove_beta/42/usr/bin/trove"),
            None,
            TROVE_IDENTIFIER,
        );
        assert_eq!(
            snap.snaps,
            vec!["trove".to_string(), "trove_beta".to_string()]
        );
        // the exe path alone is enough when the env is gone
        let by_exe = trove_self(None, None, None, Some("/snap/trove/7/bin/trove"), None, "x");
        assert_eq!(by_exe.snaps, vec!["trove".to_string()]);
        assert!(by_exe.flatpaks.is_empty());
        // inherited snap env with a deb exe (started from a VS Code snap terminal): not a snap
        let inherited = trove_self(
            Some("code"),
            Some("code"),
            Some("/snap/code/100"),
            Some("/usr/bin/trove"),
            None,
            TROVE_IDENTIFIER,
        );
        assert!(inherited.snaps.is_empty());
        // a Flatpak under another id still knows itself; junk is dropped, never matched
        let flat = trove_self(
            Some("Bad Name"),
            None,
            None,
            None,
            Some("io.x.Trove"),
            "a;b",
        );
        assert!(flat.snaps.is_empty());
        assert_eq!(flat.flatpaks, vec!["io.x.Trove".to_string()]);
    }

    #[test]
    fn the_identifier_matches_tauri_conf() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], TROVE_IDENTIFIER);
    }

    #[test]
    fn trove_as_a_snap_or_flatpak_refuses_itself() {
        let (owners, info) = fixtures();
        let contents = |p: &str| Some(format!("Exec={p}").into_bytes());
        let me = TroveSelf {
            snaps: vec!["hello-world".into()],
            flatpaks: vec!["org.deskflow.deskflow".into()],
        };
        let ctx = Ctx {
            home: Some(HOME),
            data_home: None,
            flatpak_user_dir: None,
            canonical: &canonical,
            contents: &contents,
            deb_owner: &owners,
            deb_info: &info,
            has_gnome_software: true,
            trove_pkg: None,
            trove_self: &me,
        };
        let r = rows(&[hello_snap(), flat(), mines()], &ctx);
        assert_eq!(r[0].removable, Removable::Trove);
        assert_eq!(r[1].removable, Removable::Trove);
        assert!(r[0].command.is_none() && r[1].command.is_none());
        assert!(r[0].program.is_empty() && r[1].program.is_empty());
        // everything else is untouched
        assert_eq!(r[2].removable, Removable::Yes);
        // and with no self match, the same snap and Flatpak are removable
        let none = TroveSelf::default();
        let r = rows(
            &[hello_snap(), flat()],
            &Ctx {
                trove_self: &none,
                ..ctx
            },
        );
        assert!(r.iter().all(|x| x.removable == Removable::Yes));
    }

    #[test]
    fn an_edited_entry_gets_a_new_id() {
        let (owners, info) = fixtures();
        let make = |exec: &'static str| {
            let contents = move |_: &str| Some(format!("Exec={exec}").into_bytes());
            let me = TroveSelf::default();
            let ctx = Ctx {
                home: Some(HOME),
                data_home: None,
                flatpak_user_dir: None,
                canonical: &canonical,
                contents: &contents,
                deb_owner: &owners,
                deb_info: &info,
                has_gnome_software: false,
                trove_pkg: None,
                trove_self: &me,
            };
            rows(&[mines()], &ctx).remove(0).id
        };
        assert_eq!(make("gnome-mines"), make("gnome-mines"));
        assert_ne!(make("gnome-mines"), make("evil"));
        let id = make("gnome-mines");
        assert!(!id.contains("mines") && id.len() == 16);
    }

    fn info(rows: &str) -> HashMap<String, DebInfo> {
        parse_dpkg_query(rows)
    }

    #[test]
    fn apt_sim_lists_what_would_be_removed() {
        let sim = parse_apt_sim(
            "NOTE: This is only a simulation!\n\
             Reading package lists...\n\
             The following packages will be REMOVED:\n  nautilus nautilus-share\n\
             Remv gnome-shell-extension-desktop-icons-ng [46+really47.0.9-1ubuntu5]\n\
             Remv nautilus-share [0.7.5-0.3build2]\n\
             Remv libfoo:amd64 [1.0] [bar:amd64 ]\n\
             Remv nautilus [1:46.4-0ubuntu0.2]\n\
             Inst linux-image-generic [6.8.0-142.142] (6.8.0-146.146 Ubuntu:24.04 [amd64])\n\
             Conf linux-image-generic (6.8.0-146.146 Ubuntu:24.04/noble-updates [amd64])\n",
        );
        assert_eq!(
            sim.removed,
            [
                "gnome-shell-extension-desktop-icons-ng",
                "nautilus-share",
                "libfoo",
                "nautilus"
            ]
        );
        assert!(!sim.essential_warning && !sim.unreadable);
        let sim = parse_apt_sim(
            "WARNING: The following essential packages will be removed.\n\
             This should NOT be done unless you know exactly what you are doing!\n\
             Remv coreutils [9.4-3ubuntu6.3] [xinit:amd64 ]\n",
        );
        assert!(sim.essential_warning);
        assert_eq!(sim.removed, ["coreutils"]);
        assert!(parse_apt_sim("Remv Bad;Name [1]\n").unreadable);
        assert_eq!(
            parse_apt_sim("Package 'x' is not installed, so not removed\n"),
            AptSim::default()
        );
    }

    #[test]
    fn desktop_metapackages_are_recognised() {
        for meta in [
            "ubuntu-desktop",
            "ubuntu-desktop-minimal",
            "ubuntu-desktop-raspi",
            "kubuntu-desktop",
            "xubuntu-desktop",
            "ubuntu-mate-desktop",
            "ubuntustudio-desktop-core",
            "task-gnome-desktop",
        ] {
            assert!(is_desktop_meta(meta), "{meta}");
        }
        for not in [
            "gnome-shell-extension-desktop-icons-ng",
            "desktop-file-utils",
            "gnome-mines",
            "libgnome-desktop-4-2",
        ] {
            assert!(!is_desktop_meta(not), "{not}");
        }
    }

    #[test]
    fn apt_guard_refuses_essential_and_desktop_removals() {
        let fine = info("gnome-mines\t1\tno\toptional\nlibfoo\t1\tno\toptional\n");
        // only ordinary packages go: allowed
        assert_eq!(
            apt_verdict(
                "gnome-mines",
                &parse_apt_sim("Remv libfoo [1]\nRemv gnome-mines [1]\n"),
                &fine
            ),
            Ok(())
        );
        // an essential package would go with it
        let ess = info("gnome-mines\t1\tno\toptional\ncoreutils\t9\tyes\trequired\n");
        let e = apt_verdict(
            "gnome-mines",
            &parse_apt_sim("Remv coreutils [9]\nRemv gnome-mines [1]\n"),
            &ess,
        )
        .unwrap_err();
        assert!(
            e.contains("coreutils (Ubuntu needs it)") && e.contains("Nothing was typed"),
            "{e}"
        );
        // the desktop metapackages would go with it
        let desk = info(
            "nautilus\t1\tno\toptional\n\
             ubuntu-desktop\t1\tno\toptional\n\
             ubuntu-desktop-minimal\t1\tno\toptional\n",
        );
        let e = apt_verdict(
            "nautilus",
            &parse_apt_sim(
                "Remv ubuntu-desktop [1]\nRemv ubuntu-desktop-minimal [1]\nRemv nautilus [1]\n",
            ),
            &desk,
        )
        .unwrap_err();
        assert_eq!(
            e,
            "Trove will not remove nautilus: apt would also remove ubuntu-desktop, \
             ubuntu-desktop-minimal (your desktop). Nothing was typed or started."
        );
        // the graphical session would go with it
        let sess = info("x\t1\tno\toptional\ngdm3\t1\tno\toptional\n");
        assert!(apt_verdict("x", &parse_apt_sim("Remv gdm3 [1]\nRemv x [1]\n"), &sess).is_err());
        // picking the session package itself is refused too, not only when it rides along
        let shell = info("gnome-shell\t1\tno\toptional\n");
        let e = apt_verdict(
            "gnome-shell",
            &parse_apt_sim("Remv gnome-shell [1]\n"),
            &shell,
        )
        .unwrap_err();
        assert!(e.contains("gnome-shell (your desktop)"), "{e}");
        // apt's own essential warning refuses even if dpkg-query missed the flag
        assert!(apt_verdict(
            "gnome-mines",
            &parse_apt_sim(
                "WARNING: The following essential packages will be removed.\n\
                 Remv gnome-mines [1]\n"
            ),
            &fine
        )
        .is_err());
        // an app whose own name ends in -desktop is not refused for being itself
        let tg = info("telegram-desktop\t1\tno\toptional\n");
        assert_eq!(
            apt_verdict(
                "telegram-desktop",
                &parse_apt_sim("Remv telegram-desktop [1]\n"),
                &tg
            ),
            Ok(())
        );
    }

    #[test]
    fn apt_guard_refuses_what_it_cannot_read() {
        let fine = info("gnome-mines\t1\tno\toptional\n");
        // not installed: apt removes nothing, so nothing was checked
        assert!(apt_verdict("gnome-mines", &AptSim::default(), &fine).is_err());
        // a removed package dpkg-query says nothing about
        assert!(apt_verdict(
            "gnome-mines",
            &parse_apt_sim("Remv mystery [1]\nRemv gnome-mines [1]\n"),
            &fine
        )
        .is_err());
        // an unreadable line
        assert!(apt_verdict(
            "gnome-mines",
            &parse_apt_sim("Remv Bad;Name [1]\nRemv gnome-mines [1]\n"),
            &fine
        )
        .is_err());
        // more than five needed packages are counted, not all listed
        let mut sim: String = (0..7).map(|i| format!("Remv core{i} [1]\n")).collect();
        sim.push_str("Remv xx [1]\n");
        let mut rows: String = (0..7)
            .map(|i| format!("core{i}\t1\tyes\trequired\n"))
            .collect();
        rows.push_str("xx\t1\tno\toptional\n");
        let e = apt_verdict("xx", &parse_apt_sim(&sim), &info(&rows)).unwrap_err();
        assert!(e.contains("core4 and 2 more (Ubuntu needs it)"), "{e}");
    }

    #[test]
    fn only_a_removable_deb_row_carries_its_package_for_the_guard() {
        let core = app(
            "Core",
            "coreutils-fake.desktop",
            "/usr/share/applications/coreutils-fake.desktop",
        );
        for gs in [false, true] {
            let r = with_ctx(gs, |c| {
                rows(&[mines(), hello_snap(), flat(), core.clone()], c)
            });
            // checked whichever way it is handed off: GNOME Software or the terminal
            assert_eq!(r[0].deb.as_deref(), Some("gnome-mines"));
            assert_eq!(r[1].deb, None);
            assert_eq!(r[2].deb, None);
            assert_eq!(
                r[3].deb, None,
                "a System row is refused before any simulation"
            );
        }
    }

    /// A simulation only (`apt-get -s`): nothing removed, no sudo.
    /// `cargo test -- --ignored live_apt_guard_refuses_coreutils`.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    #[ignore = "runs apt-get -s remove (a read-only simulation) on this machine"]
    fn live_apt_guard_refuses_coreutils() {
        let e = apt_check("coreutils").expect_err("coreutils is essential");
        eprintln!("{e}");
        assert!(e.contains("coreutils"));
        assert!(apt_check("Bad;Name").is_err());
    }

    /// Lists only: no removal, no sudo. `cargo test -- --ignored live_list_has_rows`.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    #[ignore = "reads this machine's apps with dpkg -S / dpkg-query (read-only)"]
    fn live_list_has_rows() {
        let rows = list().expect("list");
        assert!(!rows.is_empty());
        for r in rows.iter().filter(|r| r.removable == Removable::Yes) {
            eprintln!("{} -> {}", r.name, r.program);
        }
    }
}

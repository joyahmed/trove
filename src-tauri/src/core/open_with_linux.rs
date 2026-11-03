//! Linux "Open with ▸" (plan 15 G.61): the apps the desktop lists for a file's MIME type, read
//! by hand from the same files GIO reads, and the file opened in one through its `.desktop` file.
//!
//! The type is GIO's answer (`gio info -a standard::content-type`), else `xdg-mime query
//! filetype`. The apps are the freedesktop MIME-apps spec's: `mimeapps.list` files (the
//! desktop's own `<desktop>-mimeapps.list` first, then the plain one; config dirs before data
//! dirs) for the default, added and removed apps, and every `applications/mimeinfo.cache` for
//! the apps that declare the type. Opening is `gio launch <desktop file> <files…>` (what the
//! menu does: terminal apps, D-Bus activation), else the entry's `Exec` with the files — no
//! shell, as `apps_linux.rs` launches an app.
//!
//! Not modelled (GIO does them, Trove's list may be shorter): MIME subclasses (an app for
//! `text/plain` is not offered for `text/x-python`) and aliases.
//!
//! Everything but the `env_*` functions is pure and tested on every OS.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::apps_linux::{map_codes, split_exec, DesktopEntry};
use super::open_with::RawApp;

/// The MIME type in `gio info -a standard::content-type` output, or `xdg-mime query filetype`'s
/// single line. `None` for empty output.
pub fn parse_content_type(output: &str) -> Option<String> {
    let line = output
        .lines()
        .find_map(|l| l.trim().strip_prefix("standard::content-type:"))
        .or_else(|| {
            let mut lines = output.lines().map(str::trim).filter(|l| !l.is_empty());
            let only = lines.next()?;
            (lines.next().is_none() && only.contains('/') && !only.contains(':')).then_some(only)
        })?;
    let mime = line.trim();
    (!mime.is_empty()).then(|| mime.to_string())
}

/// `a.desktop;b.desktop;` as ids, empty pieces dropped.
fn ids(value: &str) -> Vec<String> {
    value
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

/// The value of `mime=` in `[group]` of an ini-style file, as ids.
fn group_value(text: &str, group: &str, mime: &str) -> Vec<String> {
    let mut inside = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            inside = line == format!("[{group}]");
            continue;
        }
        if !inside {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == mime {
                return ids(v);
            }
        }
    }
    Vec::new()
}

/// The apps a `mimeinfo.cache` lists for `mime`.
pub fn parse_mime_cache(text: &str, mime: &str) -> Vec<String> {
    group_value(text, "MIME Cache", mime)
}

/// What one `mimeapps.list` says about `mime`.
#[derive(Debug, Default, PartialEq)]
pub struct MimeApps {
    pub defaults: Vec<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

pub fn parse_mimeapps(text: &str, mime: &str) -> MimeApps {
    MimeApps {
        defaults: group_value(text, "Default Applications", mime),
        added: group_value(text, "Added Associations", mime),
        removed: group_value(text, "Removed Associations", mime),
    }
}

/// The `mimeapps.list` files the spec reads, most important first: in each of the config home,
/// the config dirs, then each data dir's `applications/`, the desktop's own
/// `<desktop>-mimeapps.list` (`gnome-mimeapps.list`) before the plain one. `desktops` is
/// `XDG_CURRENT_DESKTOP` split on `:`, any case. `/`-joined so the paths are Linux paths in tests
/// on Windows.
pub fn mimeapps_paths(
    config_home: Option<&str>,
    config_dirs: &[String],
    data_dirs: &[PathBuf],
    desktops: &[String],
) -> Vec<PathBuf> {
    let mut bases: Vec<String> = config_home.into_iter().map(String::from).collect();
    bases.extend(config_dirs.iter().cloned());
    bases.extend(
        data_dirs
            .iter()
            .map(|d| format!("{}/applications", d.display())),
    );
    let mut names: Vec<String> = desktops
        .iter()
        .filter(|d| !d.is_empty())
        .map(|d| format!("{}-mimeapps.list", d.to_lowercase()))
        .collect();
    names.push("mimeapps.list".into());
    bases
        .iter()
        .flat_map(|b| names.iter().map(move |n| PathBuf::from(format!("{b}/{n}"))))
        .collect()
}

/// The apps for `mime`, default first: `lists` are the `mimeapps.list` texts in `mimeapps_paths`
/// order, `caches` the `mimeinfo.cache` texts in data-dir order; `installed` says whether an id
/// has a `.desktop` file. An app any list removes is never offered, the default included; the
/// default is the first installed one a list names. Returns `(default, every id)`.
pub fn resolve(
    mime: &str,
    lists: &[String],
    caches: &[String],
    installed: impl Fn(&str) -> bool,
) -> (Option<String>, Vec<String>) {
    let parsed: Vec<MimeApps> = lists.iter().map(|t| parse_mimeapps(t, mime)).collect();
    let removed: HashSet<&str> = parsed
        .iter()
        .flat_map(|m| m.removed.iter().map(String::as_str))
        .collect();
    let ok = |id: &str| !removed.contains(id) && installed(id);
    let default = parsed
        .iter()
        .flat_map(|m| m.defaults.iter())
        .find(|id| ok(id))
        .cloned();
    let mut seen = HashSet::new();
    let all: Vec<String> = default
        .iter()
        .cloned()
        .chain(parsed.iter().flat_map(|m| m.added.iter().cloned()))
        .chain(caches.iter().flat_map(|t| parse_mime_cache(t, mime)))
        .filter(|id| ok(id) && seen.insert(id.clone()))
        .collect();
    (default, all)
}

/// Where a desktop id's file is: `<dir>/applications/<id>`, or — the spec's `-` for a subfolder
/// (`kde4-kate.desktop`) — `<dir>/applications/kde4/kate.desktop`. First dir that has it wins.
pub fn desktop_path(
    id: &str,
    data_dirs: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let mut rels = vec![id.to_string()];
    if let Some((dir, rest)) = id.split_once('-') {
        rels.push(format!("{dir}/{rest}"));
    }
    data_dirs.iter().find_map(|d| {
        rels.iter()
            .map(|r| PathBuf::from(format!("{}/applications/{r}", d.display())))
            .find(|p| exists(p))
    })
}

/// Whether `path` is a `.desktop` file under one of `data_dirs`' `applications/` folders — the
/// only files `env_open` will launch, whatever id it is handed.
pub fn is_listed_desktop(path: &str, data_dirs: &[PathBuf]) -> bool {
    path.ends_with(".desktop")
        && !path.split('/').any(|part| part == "..")
        && data_dirs.iter().any(|d| {
            let root = format!("{}/applications/", d.display());
            path.starts_with(&root)
        })
}

/// The entry as the menu's raw app, or `None` when it should not be offered: not an
/// application, `Hidden`, no `Exec`, or a terminal app with no `gio` to give it a terminal.
pub fn raw_app(path: &str, entry: &DesktopEntry, has_gio: bool) -> Option<RawApp> {
    if entry.kind != "Application" || entry.hidden || entry.exec.is_none() {
        return None;
    }
    if entry.terminal && !has_gio {
        return None;
    }
    Some(RawApp {
        id: path.to_string(),
        name: entry.name.clone(),
        icon: None,
    })
}

/// `Exec` with the files filled in, as one argument list per process to start: a `%F`/`%U` word
/// takes every file in one process; `%f`/`%u` takes one, so each file gets its own process; an
/// `Exec` with no file code gets the files appended (it was listed for the type, so it takes
/// files). `None` for shell syntax or an empty program — never approximated.
pub fn exec_with_files(exec: &str, files: &[String]) -> Option<Vec<Vec<String>>> {
    let words = split_exec(exec)?;
    let fill = |file: &str| -> Vec<String> {
        words
            .iter()
            .filter_map(|w| map_codes(w, (file, "")).0)
            .collect()
    };
    let argvs: Vec<Vec<String>> = if words.iter().any(|w| w == "%F" || w == "%U") {
        let mut argv = Vec::new();
        for w in &words {
            if w == "%F" || w == "%U" {
                argv.extend(files.iter().cloned());
            } else {
                argv.extend(map_codes(w, ("", "")).0);
            }
        }
        vec![argv]
    } else if words.iter().any(|w| map_codes(w, ("", "")).1) {
        files.iter().map(|f| fill(f)).collect()
    } else {
        let mut argv = fill("");
        argv.extend(files.iter().cloned());
        vec![argv]
    };
    argvs
        .iter()
        .all(|a| a.first().is_some_and(|p| !p.is_empty()))
        .then_some(argvs)
}

/// What opening `files` with the entry at `path` starts: `gio launch <path> <files…>` when gio is
/// there; else the `Exec` with the files, refused (with the reason) for a terminal app or shell
/// syntax.
pub fn open_argvs(
    path: &str,
    entry: &DesktopEntry,
    files: &[String],
    has_gio: bool,
) -> Result<Vec<Vec<String>>, String> {
    if has_gio {
        let mut argv = vec!["gio".to_string(), "launch".to_string(), path.to_string()];
        argv.extend(files.iter().cloned());
        return Ok(vec![argv]);
    }
    if entry.terminal {
        return Err(format!(
            "{} needs a terminal, and gio is not installed",
            entry.name
        ));
    }
    let exec = entry
        .exec
        .as_deref()
        .ok_or_else(|| format!("{} has no Exec line", entry.name))?;
    exec_with_files(exec, files).ok_or_else(|| {
        format!(
            "{}'s Exec line needs a shell, which Trove never runs",
            entry.name
        )
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn run_text(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn has_gio() -> bool {
    super::apps_linux::find_on_path("gio", std::env::var_os("PATH").as_deref()).is_some()
}

/// The file's MIME type as the desktop sees it (GIO, else xdg-mime). Reads only.
#[cfg(all(unix, not(target_os = "macos")))]
fn env_content_type(path: &Path) -> Option<String> {
    let p = path.to_string_lossy();
    run_text("gio", &["info", "-a", "standard::content-type", "--", &p])
        .and_then(|o| parse_content_type(&o))
        .or_else(|| {
            run_text("xdg-mime", &["query", "filetype", &p]).and_then(|o| parse_content_type(&o))
        })
}

/// The apps for `path`'s type on this desktop, default first.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn env_apps(path: &Path) -> Vec<super::open_with::OpenWithApp> {
    let Some(mime) = env_content_type(path) else {
        log::warn!("open with: no MIME type for the item");
        log::debug!("open with: no MIME type for {}", path.display());
        return Vec::new();
    };
    let data = super::apps_linux::env_data_dirs();
    let home = std::env::var("HOME").ok();
    let config_home = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|v| v.starts_with('/'))
        .or_else(|| home.map(|h| format!("{h}/.config")));
    let config_dirs: Vec<String> = std::env::var("XDG_CONFIG_DIRS")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "/etc/xdg".into())
        .split(':')
        .filter(|d| d.starts_with('/'))
        .map(String::from)
        .collect();
    let desktops: Vec<String> = std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .split(':')
        .map(String::from)
        .collect();
    let read = |p: &Path| {
        std::fs::read(p)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    };
    let lists: Vec<String> = mimeapps_paths(config_home.as_deref(), &config_dirs, &data, &desktops)
        .iter()
        .filter_map(|p| read(p))
        .collect();
    let caches: Vec<String> = data
        .iter()
        .filter_map(|d| read(&d.join("applications/mimeinfo.cache")))
        .collect();
    let find = |id: &str| desktop_path(id, &data, |p| p.is_file());
    let (default, ids) = resolve(&mime, &lists, &caches, |id| find(id).is_some());
    let locale = super::apps_linux::env_locale();
    let gio = has_gio();
    let path_var = std::env::var_os("PATH");
    let mut default_path: Option<String> = None;
    let raw: Vec<RawApp> = ids
        .iter()
        .filter_map(|id| {
            let file = find(id)?;
            let entry = super::apps_linux::parse_desktop(&read(&file)?, &locale)?;
            if let Some(t) = &entry.try_exec {
                super::apps_linux::find_on_path(t, path_var.as_deref())?;
            }
            let file = file.to_string_lossy().into_owned();
            if default.as_deref() == Some(id.as_str()) {
                default_path = Some(file.clone());
            }
            raw_app(&file, &entry, gio)
        })
        .collect();
    super::open_with::shape(raw, |a| default_path.as_deref() == Some(a.id.as_str()))
}

/// Open `files` with the `.desktop` file `id` (a path `env_apps` listed). No shell; each process
/// is reaped on a thread so a finished `gio launch` never lingers.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn env_open(id: &str, files: &[String]) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let data = super::apps_linux::env_data_dirs();
    if !is_listed_desktop(id, &data) {
        return Err(format!("{id} is not an installed app"));
    }
    let text = std::fs::read(id).map_err(|e| format!("{id}: {e}"))?;
    let entry = super::apps_linux::parse_desktop(
        &String::from_utf8_lossy(&text),
        &super::apps_linux::env_locale(),
    )
    .ok_or_else(|| format!("{id} is not a desktop entry any more"))?;
    for argv in open_argvs(id, &entry, files, has_gio())? {
        let (program, args) = argv.split_first().ok_or("nothing to run")?;
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start {program}: {e}"))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(list: &[&str]) -> Vec<String> {
        list.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn the_content_type_is_read_from_gio_or_xdg_mime() {
        let gio = "uri: file:///home/j/a.txt\nattributes:\n  standard::content-type: text/plain\n";
        assert_eq!(parse_content_type(gio).as_deref(), Some("text/plain"));
        assert_eq!(
            parse_content_type("image/png\n").as_deref(),
            Some("image/png")
        );
        assert_eq!(parse_content_type(""), None);
        assert_eq!(parse_content_type("attributes:\n"), None);
    }

    const CACHE: &str = "[MIME Cache]\ntext/plain=org.gnome.TextEditor.desktop;vim.desktop;\nimage/png=eog.desktop;\n";

    #[test]
    fn the_cache_lists_the_apps_for_one_type() {
        assert_eq!(
            parse_mime_cache(CACHE, "text/plain"),
            s(&["org.gnome.TextEditor.desktop", "vim.desktop"])
        );
        assert!(parse_mime_cache(CACHE, "text/html").is_empty());
        assert!(parse_mime_cache("[Other]\ntext/plain=x.desktop;", "text/plain").is_empty());
    }

    const LIST: &str = "[Default Applications]\ntext/plain=code.desktop;org.gnome.TextEditor.desktop\n\n[Added Associations]\ntext/plain=code.desktop;sublime.desktop;\n\n[Removed Associations]\ntext/plain=vim.desktop;\n";

    #[test]
    fn mimeapps_has_its_three_groups() {
        let m = parse_mimeapps(LIST, "text/plain");
        assert_eq!(
            m.defaults,
            s(&["code.desktop", "org.gnome.TextEditor.desktop"])
        );
        assert_eq!(m.added, s(&["code.desktop", "sublime.desktop"]));
        assert_eq!(m.removed, s(&["vim.desktop"]));
    }

    #[test]
    fn resolve_puts_the_default_first_and_drops_removed_and_missing_apps() {
        let installed = |id: &str| id != "sublime.desktop";
        let (default, all) = resolve("text/plain", &s(&[LIST]), &s(&[CACHE]), installed);
        assert_eq!(default.as_deref(), Some("code.desktop"));
        assert_eq!(all, s(&["code.desktop", "org.gnome.TextEditor.desktop"]));
    }

    #[test]
    fn a_default_that_is_not_installed_falls_to_the_next_one_named() {
        let (default, _) = resolve("text/plain", &s(&[LIST]), &s(&[CACHE]), |id| {
            id != "code.desktop"
        });
        assert_eq!(default.as_deref(), Some("org.gnome.TextEditor.desktop"));
    }

    #[test]
    fn a_removed_default_is_not_the_default() {
        let user = "[Removed Associations]\ntext/plain=code.desktop;\n".to_string();
        let (default, all) = resolve(
            "text/plain",
            &[user, LIST.to_string()],
            &s(&[CACHE]),
            |_| true,
        );
        assert_eq!(default.as_deref(), Some("org.gnome.TextEditor.desktop"));
        assert!(!all.contains(&"code.desktop".to_string()));
    }

    #[test]
    fn no_lists_means_the_cache_order_and_no_default() {
        let (default, all) = resolve("image/png", &[], &s(&[CACHE]), |_| true);
        assert_eq!(default, None);
        assert_eq!(all, s(&["eog.desktop"]));
    }

    #[test]
    fn mimeapps_paths_put_the_desktop_file_before_the_plain_one() {
        let paths = mimeapps_paths(
            Some("/home/j/.config"),
            &s(&["/etc/xdg"]),
            &[PathBuf::from("/usr/share")],
            &s(&["ubuntu", "GNOME"]),
        );
        let got: Vec<String> = paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            got[..3],
            s(&[
                "/home/j/.config/ubuntu-mimeapps.list",
                "/home/j/.config/gnome-mimeapps.list",
                "/home/j/.config/mimeapps.list",
            ])
        );
        assert_eq!(
            got.last().map(String::as_str),
            Some("/usr/share/applications/mimeapps.list")
        );
        assert_eq!(got.len(), 9);
    }

    #[test]
    fn a_desktop_id_with_a_dash_may_live_in_a_subfolder() {
        let dirs = [
            PathBuf::from("/home/j/.local/share"),
            PathBuf::from("/usr/share"),
        ];
        let at = |want: &'static str| move |p: &Path| p.to_string_lossy() == want;
        assert_eq!(
            desktop_path(
                "eog.desktop",
                &dirs,
                at("/usr/share/applications/eog.desktop")
            ),
            Some(PathBuf::from("/usr/share/applications/eog.desktop"))
        );
        assert_eq!(
            desktop_path(
                "kde4-kate.desktop",
                &dirs,
                at("/usr/share/applications/kde4/kate.desktop")
            ),
            Some(PathBuf::from("/usr/share/applications/kde4/kate.desktop"))
        );
        assert_eq!(desktop_path("gone.desktop", &dirs, |_| false), None);
    }

    #[test]
    fn only_a_desktop_file_under_an_applications_folder_is_launched() {
        let dirs = [PathBuf::from("/usr/share")];
        assert!(is_listed_desktop(
            "/usr/share/applications/eog.desktop",
            &dirs
        ));
        assert!(!is_listed_desktop("/tmp/evil.desktop", &dirs));
        assert!(!is_listed_desktop(
            "/usr/share/applications/../../tmp/x.desktop",
            &dirs
        ));
        assert!(!is_listed_desktop("/usr/share/applications/eog", &dirs));
    }

    fn entry(exec: &str, terminal: bool) -> DesktopEntry {
        DesktopEntry {
            name: "Editor".into(),
            kind: "Application".into(),
            exec: Some(exec.into()),
            terminal,
            ..DesktopEntry::default()
        }
    }

    #[test]
    fn hidden_and_terminal_entries_are_offered_only_when_they_can_run() {
        assert!(raw_app("/a.desktop", &entry("ed %f", false), false).is_some());
        assert!(raw_app("/a.desktop", &entry("vim %F", true), false).is_none());
        assert!(raw_app("/a.desktop", &entry("vim %F", true), true).is_some());
        let mut hidden = entry("ed", false);
        hidden.hidden = true;
        assert!(raw_app("/a.desktop", &hidden, true).is_none());
        let mut link = entry("ed", false);
        link.kind = "Link".into();
        assert!(raw_app("/a.desktop", &link, true).is_none());
    }

    #[test]
    fn a_list_code_takes_every_file_in_one_process() {
        let files = s(&["/a b.txt", "/c.txt"]);
        assert_eq!(
            exec_with_files("code --new-window %F", &files),
            Some(vec![s(&["code", "--new-window", "/a b.txt", "/c.txt"])])
        );
    }

    #[test]
    fn a_single_code_starts_one_process_per_file() {
        let files = s(&["/a.txt", "/c.txt"]);
        assert_eq!(
            exec_with_files("gedit %u --icon %i", &files),
            Some(vec![
                s(&["gedit", "/a.txt", "--icon"]),
                s(&["gedit", "/c.txt", "--icon"])
            ])
        );
    }

    #[test]
    fn no_code_appends_the_files_and_shell_syntax_is_refused() {
        assert_eq!(
            exec_with_files("viewer", &s(&["/a.png"])),
            Some(vec![s(&["viewer", "/a.png"])])
        );
        assert_eq!(exec_with_files("sh -c 'x' %f", &s(&["/a"])), None);
        assert_eq!(exec_with_files("%f", &s(&[""])), None);
    }

    #[test]
    fn gio_launches_the_desktop_file_with_the_files() {
        let got = open_argvs(
            "/usr/share/applications/e.desktop",
            &entry("e %f", true),
            &s(&["/a"]),
            true,
        );
        assert_eq!(
            got,
            Ok(vec![s(&[
                "gio",
                "launch",
                "/usr/share/applications/e.desktop",
                "/a"
            ])])
        );
    }

    #[test]
    fn without_gio_a_terminal_app_is_refused_with_its_reason() {
        let got = open_argvs("/x.desktop", &entry("vim %F", true), &s(&["/a"]), false);
        assert_eq!(
            got,
            Err("Editor needs a terminal, and gio is not installed".to_string())
        );
        let ok = open_argvs("/x.desktop", &entry("ed %F", false), &s(&["/a"]), false);
        assert_eq!(ok, Ok(vec![s(&["ed", "/a"])]));
    }
}

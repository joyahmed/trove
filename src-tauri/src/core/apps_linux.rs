//! The Linux app list: every `.desktop` entry the desktop's own menu would show, read with a
//! small hand-written parser (the Desktop Entry spec's group header, `Key=Value`,
//! `Key[locale]=`, the `\s \n \t \r \\` escapes, the `Exec` quoting rules and field codes).
//!
//! ⛔ No crate: `freedesktop-desktop-entry` pulls `xdg`, which is an empty crate on Windows and
//! would break the Windows `cargo test` gate (plan 17, bad news). This file compiles everywhere
//! and its tests run on Windows.
//!
//! ⛔ Read-only and shell-free. Nothing here writes or runs anything: `TryExec` is checked by
//! looking the name up on `PATH` and testing the execute bit, never by running it; `Exec` is
//! split into an argument list by the spec's rules and refused outright when it carries shell
//! syntax — it is never handed to `sh -c`. Every function takes its dirs/env as arguments so the
//! tests never touch `~/.local/share/applications` or `set_var`.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::core::spotlight::{AppEntry, OpenWith};

/// The keys of a `[Desktop Entry]` group that decide whether and how an app is listed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DesktopEntry {
    /// `Name`, in the best-matching locale.
    pub name: String,
    pub kind: String,
    pub exec: Option<String>,
    pub try_exec: Option<String>,
    pub no_display: bool,
    pub hidden: bool,
    pub terminal: bool,
    /// a non-empty `MimeType`: the app opens files
    pub has_mime: bool,
    /// `Icon`: a theme icon name (`org.gnome.Calculator`) or an absolute file path
    pub icon: Option<String>,
}

/// `Key` → (rank, value) where a lower rank is a better locale match; the unlocalized value
/// ranks last.
fn locale_rank(locale: &str, wanted: &str) -> Option<usize> {
    // de_DE.UTF-8@euro → lang de, country DE, modifier euro; the encoding is ignored
    let (base, modifier) = match locale.split_once('@') {
        Some((b, m)) => (b, Some(m)),
        None => (locale, None),
    };
    let base = base.split('.').next().unwrap_or(base);
    let (lang, country) = match base.split_once('_') {
        Some((l, c)) => (l, Some(c)),
        None => (base, None),
    };
    if lang.is_empty() || lang == "C" || lang == "POSIX" {
        return None;
    }
    let mut order: Vec<String> = Vec::new();
    if let (Some(c), Some(m)) = (country, modifier) {
        order.push(format!("{lang}_{c}@{m}"));
    }
    if let Some(c) = country {
        order.push(format!("{lang}_{c}"));
    }
    if let Some(m) = modifier {
        order.push(format!("{lang}@{m}"));
    }
    order.push(lang.to_string());
    order.iter().position(|o| o == wanted)
}

/// The spec's string escapes. An unknown escape (`\"`, `\$`) is kept as both characters: the
/// `Exec` quoting rules apply after this pass and need them.
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// The `[Desktop Entry]` group of a `.desktop` file. `None` when there is no such group or it
/// has no `Name`. Keys of every other group (`[Desktop Action x]`) are ignored.
pub fn parse_desktop(text: &str, locale: &str) -> Option<DesktopEntry> {
    let mut in_entry = false;
    let mut seen_entry = false;
    let mut name: Option<String> = None;
    let mut best_local: Option<(usize, String)> = None;
    let mut e = DesktopEntry::default();
    let mut first = HashSet::new();
    for line in text.lines() {
        let line = line.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_entry = line.trim_end() == "[Desktop Entry]" && !seen_entry;
            seen_entry |= in_entry;
            continue;
        }
        if !in_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if let Some(local) = key.strip_prefix("Name[").and_then(|k| k.strip_suffix(']')) {
            if let Some(rank) = locale_rank(locale, local) {
                if best_local.as_ref().is_none_or(|(r, _)| rank < *r) {
                    best_local = Some((rank, unescape(value)));
                }
            }
            continue;
        }
        // a key given twice is invalid; the first one stands
        if !first.insert(key.to_string()) {
            continue;
        }
        let flag = value == "true";
        match key {
            "Name" => name = Some(unescape(value)),
            "Type" => e.kind = unescape(value),
            "Exec" => e.exec = Some(unescape(value)),
            "TryExec" => e.try_exec = Some(unescape(value)),
            "NoDisplay" => e.no_display = flag,
            "Hidden" => e.hidden = flag,
            "Terminal" => e.terminal = flag,
            "Icon" => e.icon = Some(unescape(value)).filter(|v| !v.trim().is_empty()),
            "MimeType" => e.has_mime = value.split(';').any(|m| !m.trim().is_empty()),
            _ => {}
        }
    }
    e.name = best_local
        .map(|(_, v)| v)
        .or(name)
        .filter(|n| !n.trim().is_empty())?;
    Some(e)
}

/// Characters the spec reserves; outside quotes they mean shell syntax, which is refused.
const SHELL_OUTSIDE: &[char] = &['`', '$', '(', ')', ';', '|', '&', '<', '>', '\'', '\\'];

/// `Exec` split into words by the spec's quoting rules: whitespace separates, a `"…"` word
/// may hold spaces, inside it `\"` `` \` `` `\$` `\\` are literal. `None` for shell syntax
/// (a reserved character outside quotes, an unescaped `` ` `` or `$` inside them) or an
/// unterminated quote.
pub(crate) fn split_exec(exec: &str) -> Option<Vec<String>> {
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut has_word = false;
    let mut chars = exec.chars();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' | '\n' | '\r' => {
                if has_word {
                    words.push(std::mem::take(&mut cur));
                    has_word = false;
                }
            }
            '"' => {
                has_word = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => match chars.next()? {
                            q @ ('"' | '`' | '$' | '\\') => cur.push(q),
                            other => {
                                cur.push('\\');
                                cur.push(other);
                            }
                        },
                        '`' | '$' => return None,
                        other => cur.push(other),
                    }
                }
            }
            c if SHELL_OUTSIDE.contains(&c) => return None,
            other => {
                has_word = true;
                cur.push(other);
            }
        }
    }
    if has_word {
        words.push(cur);
    }
    Some(words)
}

/// One `Exec` word with its field codes mapped: `%f %u` → `files.0`, `%F %U` → `files.1`, the
/// rest (`%i %c %k` and the deprecated ones) removed as the spec says, `%%` → `%`. Returns the
/// word (or `None` when it was nothing but removed codes) and whether it held a file code.
pub(crate) fn map_codes(word: &str, files: (&str, &str)) -> (Option<String>, bool) {
    let mut out = String::new();
    let mut file_code = false;
    let mut chars = word.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('%') => out.push('%'),
            Some('f' | 'u') => {
                out.push_str(files.0);
                file_code = true;
            }
            Some('F' | 'U') => {
                out.push_str(files.1);
                file_code = true;
            }
            // %i %c %k, the deprecated %d %D %n %N %v %m, and anything invalid: removed
            Some(_) | None => {}
        }
    }
    let keep = !out.is_empty() || word.is_empty();
    (keep.then_some(out), file_code)
}

/// A word as Trove's `splitArgs` reads it back: quoted when it holds whitespace or a quote.
/// `None` for a quoted word ending in `\`: `splitArgs` would read the closing `\"` as a literal
/// quote and lose the end of the word, and it has no other way to write one.
fn quote(word: &str) -> Option<String> {
    if word.is_empty() || word.chars().any(|c| c.is_whitespace() || c == '"') {
        if word.ends_with('\\') {
            return None;
        }
        Some(format!("\"{}\"", word.replace('"', "\\\"")))
    } else {
        Some(word.to_string())
    }
}

/// What a custom command runs to open files with this entry: the first `Exec` word as the
/// program, the rest as the argument line with field codes mapped to Trove's tokens.
///
/// ⛔ Flatpak's `@@u … @@` markers stay verbatim around the token: `flatpak run
/// --file-forwarding` needs them to pass the file through the document portal. Snap entries
/// keep their `env BAMF_DESKTOP_FILE_HINT=…` prefix (program `env`). An `Exec` with no file
/// code gets `%paths%` appended only when the entry opens files (`MimeType`); with neither, the
/// app cannot take a file and the answer is `None` (saving it would silently drop the file).
/// `None` for shell syntax — never approximated.
pub fn exec_to_open_with(exec: &str, has_mime: bool) -> Option<OpenWith> {
    let words = split_exec(exec)?;
    let (program, rest) = words.split_first()?;
    let program = map_codes(program, ("", "")).0.filter(|p| !p.is_empty())?;
    let mut args: Vec<String> = Vec::new();
    let mut saw_file = false;
    for w in rest {
        let (mapped, file) = map_codes(w, ("%path%", "%paths%"));
        saw_file |= file;
        args.extend(mapped);
    }
    if !saw_file {
        if !has_mime {
            return None;
        }
        args.push("%paths%".into());
    }
    Some(OpenWith {
        program,
        args: args
            .iter()
            .map(|a| quote(a))
            .collect::<Option<Vec<_>>>()?
            .join(" "),
    })
}

/// `Exec` as an argument list with no files: every field code removed. `None` for shell syntax.
pub fn exec_argv(exec: &str) -> Option<Vec<String>> {
    let argv: Vec<String> = split_exec(exec)?
        .iter()
        .filter_map(|w| map_codes(w, ("", "")).0)
        .collect();
    (!argv.is_empty()).then_some(argv)
}

/// What `launch_app` spawns for one entry. With `gio`: `gio launch <file>`, which does what the
/// menu does (terminal apps, D-Bus activation, startup notification). Without it: the `Exec`
/// words, no shell — and a refusal, with the reason, for a terminal app or shell syntax.
pub fn launch_argv(path: &str, entry: &DesktopEntry, has_gio: bool) -> Result<Vec<String>, String> {
    if has_gio {
        return Ok(vec!["gio".into(), "launch".into(), path.to_string()]);
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
    exec_argv(exec).ok_or_else(|| {
        format!(
            "{}'s Exec line needs a shell, which Trove never runs",
            entry.name
        )
    })
}

/// Whether `name` is an executable file: `name` itself when it holds a `/`, else the first
/// match in `path_var`'s directories. Looks only — never runs it.
pub fn find_on_path(name: &str, path_var: Option<&OsStr>) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    if name.contains('/') {
        let p = PathBuf::from(name);
        return is_executable(&p).then_some(p);
    }
    std::env::split_paths(path_var?)
        .map(|dir| dir.join(name))
        .find(|p| is_executable(p))
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// The data dirs whose `applications/` folders the menu reads, in priority order: the XDG
/// spec's `$XDG_DATA_HOME` then `$XDG_DATA_DIRS` (unset, empty or relative → the spec's
/// defaults `~/.local/share` and `/usr/local/share:/usr/share`), plus the Flatpak exports
/// (user before the system dirs, system after) and snapd's dir, which a wrapper-launched
/// process may not have in its `XDG_DATA_DIRS`. Duplicates dropped; dirs that do not exist are
/// skipped by the reader, not here (this stays pure).
pub fn data_dirs(
    home: Option<&Path>,
    data_home: Option<&OsStr>,
    data_dirs: Option<&OsStr>,
    flatpak_user_dir: Option<&OsStr>,
) -> Vec<PathBuf> {
    // `/`-joined by hand so the paths are Linux paths even when the tests run on Windows
    let under_home = |rest: &str| home.map(|h| PathBuf::from(format!("{}/{rest}", h.display())));
    let absolute = |s: &str| s.starts_with('/');

    let mut out: Vec<PathBuf> = Vec::new();
    match data_home.map(|v| v.to_string_lossy().into_owned()) {
        Some(v) if absolute(&v) => out.push(PathBuf::from(v)),
        _ => out.extend(under_home(".local/share")),
    }
    let home_str = home.map(|h| h.to_string_lossy().into_owned());
    let data_home_str = data_home.map(|v| v.to_string_lossy().into_owned());
    let flatpak_dir_str = flatpak_user_dir.map(|v| v.to_string_lossy().into_owned());
    out.extend(
        super::uninstall_linux::flatpak_user_base(
            home_str.as_deref(),
            data_home_str.as_deref(),
            flatpak_dir_str.as_deref(),
        )
        .map(|b| PathBuf::from(format!("{b}/exports/share"))),
    );
    let system: Vec<String> = data_dirs
        .map(|v| v.to_string_lossy().into_owned())
        .map(|v| {
            v.split(':')
                .filter(|s| absolute(s))
                .map(String::from)
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| vec!["/usr/local/share".into(), "/usr/share".into()]);
    out.extend(system.into_iter().map(PathBuf::from));
    out.push(PathBuf::from("/var/lib/flatpak/exports/share"));
    out.push(PathBuf::from("/var/lib/snapd/desktop"));

    let mut seen = HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    out
}

/// Every app under `<dir>/applications` for each of `dirs`, as the menu lists them: the desktop
/// id (path under `applications/`, `/` → `-`) seen first wins — so a `Hidden=true` copy in
/// `~/.local/share` hides the system one — and `NoDisplay`, `Hidden`, `Type` other than
/// `Application` and a failing `TryExec` are left out. A `Terminal=true` app is listed with no
/// `open_with` when `gio` is on `path_var` (`launch_argv` runs it through `gio launch`, which
/// opens a terminal for it) and left out when it is not: nothing else can launch it. Sorted by
/// name case-insensitively.
pub fn linux_apps(dirs: &[PathBuf], locale: &str, path_var: Option<&OsStr>) -> Vec<AppEntry> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<AppEntry> = Vec::new();
    let has_gio = find_on_path("gio", path_var).is_some();
    for dir in dirs {
        let apps_dir = dir.join("applications");
        let walker = walkdir::WalkDir::new(&apps_dir)
            .follow_links(false)
            .min_depth(1)
            .sort_by_file_name();
        for item in walker.into_iter().filter_map(Result::ok) {
            let path = item.path();
            // Flatpak exports are symlinked files: follow a link to a file, never to a folder
            if path.extension().is_none_or(|x| x != "desktop") || !path.is_file() {
                continue;
            }
            let Ok(rel) = path.strip_prefix(&apps_dir) else {
                continue;
            };
            let id = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("-");
            if !seen.insert(id.clone()) {
                continue;
            }
            let Ok(bytes) = std::fs::read(path) else {
                continue;
            };
            let Some(entry) = parse_desktop(&String::from_utf8_lossy(&bytes), locale) else {
                continue;
            };
            if entry.kind != "Application" || entry.no_display || entry.hidden {
                continue;
            }
            if let Some(t) = &entry.try_exec {
                if find_on_path(t, path_var).is_none() {
                    continue;
                }
            }
            // a terminal app with no gio: `launch_argv` would only refuse it, so it is not offered
            if entry.terminal && !has_gio {
                continue;
            }
            // a terminal app (vim, htop) run from a custom command gets no terminal: an
            // invisible process that hangs. `launch_argv` refuses it without gio for the same
            // reason; only `gio launch` can give it one.
            let open_with = if entry.terminal {
                None
            } else {
                entry
                    .exec
                    .as_deref()
                    .and_then(|e| exec_to_open_with(e, entry.has_mime))
            };
            out.push(AppEntry {
                open_with,
                name: entry.name,
                aumid: id,
                path: path.to_string_lossy().into_owned(),
                ..AppEntry::default()
            });
        }
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// The folders icon themes live in, in the spec's order: `~/.icons`, then `<dir>/icons` for each
/// of `dirs` (the `data_dirs` list, so the user's, the Flatpak exports' and the system's), and
/// the plain-file fallbacks: `/usr/share/pixmaps`. Pure, like `data_dirs`.
pub fn icon_dirs(home: Option<&Path>, dirs: &[PathBuf]) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut bases: Vec<PathBuf> = home
        .map(|h| PathBuf::from(format!("{}/.icons", h.display())))
        .into_iter()
        .collect();
    bases.extend(dirs.iter().map(|d| d.join("icons")));
    let mut seen = HashSet::new();
    bases.retain(|p| seen.insert(p.clone()));
    (bases, vec![PathBuf::from("/usr/share/pixmaps")])
}

/// `theme`, the themes it `Inherits=` (read from the first `index.theme` found under `bases`,
/// depth first, each once), then `hicolor`, which the spec says every lookup ends in.
pub fn theme_chain(theme: &str, bases: &[PathBuf]) -> Vec<String> {
    fn walk(theme: &str, bases: &[PathBuf], out: &mut Vec<String>) {
        if theme.is_empty() || out.iter().any(|t| t == theme) || out.len() >= 16 {
            return;
        }
        out.push(theme.to_string());
        let index = bases
            .iter()
            .find_map(|b| std::fs::read_to_string(b.join(theme).join("index.theme")).ok());
        let parents = index
            .as_deref()
            .and_then(|t| {
                t.lines()
                    .find_map(|l| l.trim().strip_prefix("Inherits=").map(String::from))
            })
            .unwrap_or_default();
        for parent in parents.split(',').map(str::trim) {
            walk(parent, bases, out);
        }
    }
    let mut out = Vec::new();
    walk(theme, bases, &mut out);
    out.retain(|t| t != "hicolor");
    out.push("hicolor".into());
    out
}

/// The pixel size a theme folder name stands for: `48x48` → 48, `24x24@2x` → 48, `32` → 32;
/// `None` for `scalable`, `symbolic` and context names (`apps`).
fn folder_px(name: &str) -> Option<u32> {
    let (dims, scale) = match name.split_once('@') {
        Some((d, s)) => (d, s.strip_suffix('x')?.parse::<u32>().ok()?),
        None => (name, 1),
    };
    let side = dims.split_once('x').map_or(dims, |(w, _)| w);
    side.parse::<u32>().ok().map(|px| px * scale)
}

/// The folders directly inside `dir`; none when it cannot be read.
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

/// A path's last component as a string.
fn leaf(p: &Path) -> Option<String> {
    p.file_name().map(|n| n.to_string_lossy().into_owned())
}

/// The PNG file for icon `name` at about `size` px, the way the desktop resolves an `Icon=`
/// line: an absolute path is used as it is; a name is looked up in each theme of `themes` in
/// order (each across all `bases`) under `<size>/<context>/` or `<context>/<size>/`, the
/// smallest at least `size` winning, else the largest; then `<pixmap dir>/<name>.png`. PNG
/// only — an SVG-only icon is a miss here; `find_svg_icon` is the second try. Reads folders,
/// never runs.
pub fn find_icon(
    name: &str,
    themes: &[String],
    bases: &[PathBuf],
    pixmaps: &[PathBuf],
    size: u32,
) -> Option<PathBuf> {
    let is_png =
        |p: &Path| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("png")) && p.is_file();
    if name.starts_with('/') {
        let p = PathBuf::from(name);
        return is_png(&p).then_some(p);
    }
    // a name written with its extension (`foo.png`) is still a name
    let name = name.strip_suffix(".png").unwrap_or(name);
    if name.is_empty() || name.contains('/') {
        return None;
    }
    let file = format!("{name}.png");
    for theme in themes {
        let mut found: Vec<(u32, PathBuf)> = Vec::new();
        for base in bases {
            for a in subdirs(&base.join(theme)) {
                for b in subdirs(&a) {
                    let candidate = b.join(&file);
                    let px = leaf(&a)
                        .and_then(|n| folder_px(&n))
                        .or_else(|| leaf(&b).and_then(|n| folder_px(&n)));
                    if let Some(px) = px.filter(|_| is_png(&candidate)) {
                        found.push((px, candidate));
                    }
                }
            }
        }
        found.sort_by_key(|(px, p)| (*px, p.clone()));
        let fit = found.iter().find(|(px, _)| *px >= size).or(found.last());
        if let Some((_, p)) = fit {
            return Some(p.clone());
        }
    }
    pixmaps.iter().map(|d| d.join(&file)).find(|p| is_png(p))
}

/// The SVG file for icon `name` when it has no PNG anywhere: an absolute `.svg` path as it is;
/// a name in each theme of `themes` in order (a `scalable` folder first, then any other), then
/// `<pixmap dir>/<name>.svg`. The webview draws it — Rust never parses it. Reads folders only.
pub fn find_svg_icon(
    name: &str,
    themes: &[String],
    bases: &[PathBuf],
    pixmaps: &[PathBuf],
) -> Option<PathBuf> {
    let is_svg =
        |p: &Path| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("svg")) && p.is_file();
    if name.starts_with('/') {
        let p = PathBuf::from(name);
        return is_svg(&p).then_some(p);
    }
    let name = name.strip_suffix(".svg").unwrap_or(name);
    if name.is_empty() || name.contains('/') {
        return None;
    }
    let file = format!("{name}.svg");
    for theme in themes {
        // (not scalable, path): `false` sorts first, so a `scalable` folder wins
        let mut found: Vec<(bool, PathBuf)> = Vec::new();
        for base in bases {
            for a in subdirs(&base.join(theme)) {
                for b in subdirs(&a) {
                    let candidate = b.join(&file);
                    if is_svg(&candidate) {
                        let scalable = [&a, &b]
                            .iter()
                            .any(|d| leaf(d).is_some_and(|n| n == "scalable"));
                        found.push((!scalable, candidate));
                    }
                }
            }
        }
        found.sort();
        if let Some((_, p)) = found.into_iter().next() {
            return Some(p);
        }
    }
    pixmaps.iter().map(|d| d.join(&file)).find(|p| is_svg(p))
}

/// The icon file for the `.desktop` file `entry` names: its own PNG; else, when `svg_ok`, its
/// own SVG (for the webview to draw); else the generic `application-x-executable` PNG the
/// desktop itself draws when the app's own icon cannot be found.
pub fn desktop_icon(
    entry: &DesktopEntry,
    themes: &[String],
    bases: &[PathBuf],
    pixmaps: &[PathBuf],
    size: u32,
    svg_ok: bool,
) -> Option<PathBuf> {
    let own = entry.icon.as_deref();
    own.and_then(|n| find_icon(n, themes, bases, pixmaps, size))
        .or_else(|| {
            own.filter(|_| svg_ok)
                .and_then(|n| find_svg_icon(n, themes, bases, pixmaps))
        })
        .or_else(|| find_icon("application-x-executable", themes, bases, pixmaps, size))
}

/// The locale the menu would use for `Name[…]`: `LC_ALL`, then `LC_MESSAGES`, then `LANG`.
#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn env_locale() -> String {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find(|v| !v.is_empty())
        .unwrap_or_default()
}

/// `data_dirs` from this process's environment; the one place the env is read.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn env_data_dirs() -> Vec<PathBuf> {
    data_dirs(
        std::env::var_os("HOME").map(PathBuf::from).as_deref(),
        std::env::var_os("XDG_DATA_HOME").as_deref(),
        std::env::var_os("XDG_DATA_DIRS").as_deref(),
        std::env::var_os("FLATPAK_USER_DIR").as_deref(),
    )
}

/// `linux_apps` with this process's locale and `PATH`.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn env_linux_apps(dirs: &[PathBuf]) -> Vec<AppEntry> {
    linux_apps(dirs, &env_locale(), std::env::var_os("PATH").as_deref())
}

/// `launch_argv` for a listed app: re-reads its `.desktop` file (read-only) and looks `gio` up
/// on `PATH`.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn env_launch_argv(app: &AppEntry) -> Result<Vec<String>, String> {
    let text = std::fs::read(&app.path).map_err(|e| format!("{}: {e}", app.path))?;
    let entry = parse_desktop(&String::from_utf8_lossy(&text), &env_locale())
        .ok_or_else(|| format!("{} is not a desktop entry any more", app.path))?;
    let path_var = std::env::var_os("PATH");
    let has_gio = find_on_path("gio", path_var.as_deref()).is_some();
    launch_argv(&app.path, &entry, has_gio)
}

/// The desktop's icon theme: GNOME's `icon-theme` setting (read with `gsettings get`, a read —
/// nothing is changed), else GTK 3's `settings.ini`, else `hicolor`. Read once per run.
#[cfg(all(unix, not(target_os = "macos")))]
fn env_icon_theme() -> &'static str {
    static THEME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    THEME.get_or_init(|| {
        let from_gsettings = std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "icon-theme"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .trim_matches('\'')
                    .to_string()
            });
        let from_gtk = || {
            let home = std::env::var_os("HOME")?;
            let ini =
                std::fs::read_to_string(PathBuf::from(home).join(".config/gtk-3.0/settings.ini"))
                    .ok()?;
            ini.lines().find_map(|l| {
                let (k, v) = l.split_once('=')?;
                (k.trim() == "gtk-icon-theme-name").then(|| v.trim().to_string())
            })
        };
        from_gsettings
            .filter(|t| !t.is_empty())
            .or_else(from_gtk)
            .unwrap_or_else(|| "hicolor".into())
    })
}

/// The icon to draw for the `.desktop` file at `path` (the palette's app row), looked up in this
/// desktop's icon theme across `env_data_dirs` — a PNG, or with `svg_ok` possibly an SVG (see
/// `desktop_icon`). Read-only.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn env_desktop_icon(path: &Path, size: u32, svg_ok: bool) -> Option<PathBuf> {
    let text = std::fs::read(path).ok()?;
    let entry = parse_desktop(&String::from_utf8_lossy(&text), &env_locale())?;
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let (bases, pixmaps) = icon_dirs(home.as_deref(), &env_data_dirs());
    let themes = theme_chain(env_icon_theme(), &bases);
    desktop_icon(&entry, &themes, &bases, &pixmaps, size, svg_ok)
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

    fn entry(name: &str, extra: &str) -> String {
        format!("[Desktop Entry]\nType=Application\nName={name}\nExec=app %F\n{extra}")
    }

    #[test]
    fn the_list_follows_the_menus_rules() {
        let s = scratch("apps-linux");
        let user = s.0.join("user");
        let system = s.0.join("system");
        let ua = user.join("applications");
        let sa = system.join("applications");
        std::fs::create_dir_all(&ua).unwrap();
        std::fs::create_dir_all(sa.join("kde")).unwrap();
        let w = |dir: &Path, file: &str, body: &str| std::fs::write(dir.join(file), body).unwrap();

        w(
            &ua,
            "org.normal.desktop",
            &entry("Normal", "MimeType=text/plain;\n"),
        );
        w(
            &ua,
            "hidden-dup.desktop",
            &entry("Hidden Copy", "Hidden=true\n"),
        );
        w(&sa, "hidden-dup.desktop", &entry("System Copy", ""));
        w(&sa, "org.normal.desktop", &entry("Normal Later", ""));
        w(
            &sa,
            "nodisplay.desktop",
            &entry("No Display", "NoDisplay=true\n"),
        );
        w(
            &sa,
            "link.desktop",
            "[Desktop Entry]\nType=Link\nName=A Link\nURL=https://x\n",
        );
        w(
            &sa,
            "tryexec.desktop",
            &entry("Try Missing", "TryExec=/nope\n"),
        );
        w(
            &sa,
            "noname.desktop",
            "[Desktop Entry]\nType=Application\nExec=x\n",
        );
        w(&sa, "notes.txt", &entry("Not A Desktop File", ""));
        w(&sa.join("kde"), "konsole.desktop", &entry("Konsole", ""));
        // a TryExec found on PATH keeps the entry (only the missing one is left out)
        w(
            &sa,
            "tryexec-ok.desktop",
            &entry("Try Present", "TryExec=present-tool\n"),
        );
        // a terminal app is listed, but gets no open-with
        w(
            &sa,
            "vim.desktop",
            &entry("Vim", "Terminal=true\nMimeType=text/plain;\n"),
        );
        let bin = s.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let tool = bin.join("present-tool");
        std::fs::write(&tool, b"#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // gio on PATH: what lets the terminal app stay listed (`terminal_apps_need_gio`)
        let gio = bin.join("gio");
        std::fs::write(&gio, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&gio, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path_var = std::env::join_paths([&bin]).unwrap();

        let apps = linux_apps(&[user, system, s.0.join("missing")], "C", Some(&path_var));
        let names: Vec<&str> = apps.iter().map(|a| a.name.as_str()).collect();
        // the user's Hidden copy hides the system one; the later "Normal" is a duplicate id
        assert_eq!(
            names,
            ["Konsole", "Normal", "Try Present", "Vim"],
            "{apps:?}"
        );
        assert_eq!(apps[3].open_with, None, "Terminal=true → no open-with");
        assert!(apps[2].open_with.is_some());
        assert_eq!(
            apps[0].aumid, "kde-konsole.desktop",
            "subfolder → dash in the id"
        );
        let normal = &apps[1];
        assert_eq!(normal.aumid, "org.normal.desktop");
        assert!(normal.path.ends_with("org.normal.desktop"));
        assert!(normal.path.starts_with(&*ua.to_string_lossy()));
        assert_eq!(normal.lnk_path, "");
        assert_eq!(
            normal.open_with,
            Some(OpenWith {
                program: "app".into(),
                args: "%paths%".into()
            })
        );
    }

    #[test]
    fn try_exec_is_looked_up_never_run() {
        let s = scratch("tryexec");
        let bin = s.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let tool = bin.join("present-tool");
        std::fs::write(&tool, b"#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path_var = std::env::join_paths([&bin]).unwrap();
        assert_eq!(find_on_path("present-tool", Some(&path_var)), Some(tool));
        assert_eq!(find_on_path("absent-tool", Some(&path_var)), None);
        assert_eq!(find_on_path("/nope", Some(&path_var)), None);
        assert_eq!(find_on_path("present-tool", None), None);
    }

    #[test]
    fn parse_desktop_reads_the_entry_group_only_with_locale_and_escapes() {
        let text = "\
# comment
[Desktop Entry]
Type=Application
Name=Calculator
Name[de]=Rechner
Name[de_AT]=Rechner AT
Name[fr]=Calculatrice
Exec=calc\\sx --title \"A\\tB\" %U
Terminal = true
MimeType=
Name=Second Name Ignored

[Desktop Action new]
Name=New Window
Exec=evil
NoDisplay=true
";
        let de = parse_desktop(text, "de_DE.UTF-8").unwrap();
        assert_eq!(de.name, "Rechner");
        assert_eq!(
            parse_desktop(text, "de_AT@euro").unwrap().name,
            "Rechner AT"
        );
        assert_eq!(parse_desktop(text, "fr").unwrap().name, "Calculatrice");
        let c = parse_desktop(text, "C").unwrap();
        assert_eq!(c.name, "Calculator");
        assert_eq!(c.kind, "Application");
        assert_eq!(c.exec.as_deref(), Some("calc x --title \"A\tB\" %U"));
        assert!(c.terminal, "spaces around = are allowed");
        assert!(!c.has_mime, "an empty MimeType opens nothing");
        assert!(!c.no_display, "the action group's keys are ignored");
        assert_eq!(parse_desktop("[Other]\nName=x\n", "C"), None);
        assert_eq!(
            parse_desktop("[Desktop Entry]\nType=Application\n", "C"),
            None
        );
    }

    #[test]
    fn data_dirs_default_to_the_spec_when_unset() {
        let home = Path::new("/home/alex");
        let got = data_dirs(Some(home), None, None, None);
        let want: Vec<PathBuf> = [
            "/home/alex/.local/share",
            "/home/alex/.local/share/flatpak/exports/share",
            "/usr/local/share",
            "/usr/share",
            "/var/lib/flatpak/exports/share",
            "/var/lib/snapd/desktop",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        assert_eq!(got, want);

        // set vars win, a relative entry is invalid, a repeat is dropped
        let got = data_dirs(
            Some(home),
            Some(OsStr::new("/data/home")),
            Some(OsStr::new("relative:/opt/share:/usr/share:/opt/share")),
            None,
        );
        assert_eq!(got[0], PathBuf::from("/data/home"));
        assert_eq!(got[2], PathBuf::from("/opt/share"));
        assert_eq!(got[3], PathBuf::from("/usr/share"));
        assert_eq!(
            got.iter()
                .filter(|p| p.ends_with("share") && p.starts_with("/opt"))
                .count(),
            1
        );
        // empty XDG_DATA_DIRS counts as unset
        assert_eq!(
            data_dirs(None, Some(OsStr::new("")), Some(OsStr::new("")), None)[0],
            PathBuf::from("/usr/local/share")
        );
    }

    #[test]
    fn data_dirs_list_the_moved_flatpak_exports() {
        let home = Path::new("/home/alex");
        let got = data_dirs(Some(home), Some(OsStr::new("/data/xdg")), None, None);
        assert!(got.contains(&PathBuf::from("/data/xdg/flatpak/exports/share")));
        assert!(!got
            .iter()
            .any(|p| p.starts_with("/home/alex/.local/share/flatpak")));
        let got = data_dirs(
            Some(home),
            Some(OsStr::new("/data/xdg")),
            None,
            Some(OsStr::new("/fp/user")),
        );
        assert!(got.contains(&PathBuf::from("/fp/user/exports/share")));
    }

    #[test]
    fn exec_lines_map_to_trove_commands() {
        let ow = |p: &str, a: &str| {
            Some(OpenWith {
                program: p.into(),
                args: a.into(),
            })
        };
        let cases: &[(&str, bool, Option<OpenWith>)] = &[
            ("code %F", true, ow("code", "%paths%")),
            ("vlc --started-from-file %U", true, ow("vlc", "--started-from-file %paths%")),
            ("gimp-2.10 %U", true, ow("gimp-2.10", "%paths%")),
            ("\"/opt/My App/app\" %f", true, ow("/opt/My App/app", "%path%")),
            ("echo 100%%", true, ow("echo", "100% %paths%")),
            // no file code and no MimeType: the app cannot take a file
            ("echo 100%%", false, None),
            (
                "env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop /snap/bin/firefox %u",
                true,
                ow(
                    "env",
                    "BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop /snap/bin/firefox %path%",
                ),
            ),
            (
                "/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=y --file-forwarding org.x.Y @@u %U @@",
                true,
                ow(
                    "/usr/bin/flatpak",
                    "run --branch=stable --arch=x86_64 --command=y --file-forwarding org.x.Y @@u %paths% @@",
                ),
            ),
            ("sh -c \"foo $1\"", true, None),
            ("foo; rm -rf x", true, None),
            ("foo | bar", false, None),
            ("gnome-calculator", false, None),
            // a quoted word ending in `\` cannot be written for splitArgs
            ("app \"a b\\\\\" %f", true, None),
            ("gedit", true, ow("gedit", "%paths%")),
            ("app --icon %i --name %c %k %F", true, ow("app", "--icon --name %paths%")),
            ("app --title \"a \\\"b\\\" c\" %f", true, ow("app", "--title \"a \\\"b\\\" c\" %path%")),
            ("\"unterminated %f", true, None),
            ("", true, None),
        ];
        for (exec, mime, want) in cases {
            assert_eq!(&exec_to_open_with(exec, *mime), want, "Exec={exec}");
        }
    }

    #[test]
    fn launch_uses_gio_and_falls_back_to_exec_without_a_shell() {
        let e = DesktopEntry {
            name: "Calc".into(),
            kind: "Application".into(),
            exec: Some("gnome-calculator --mode %U".into()),
            ..DesktopEntry::default()
        };
        let path = "/usr/share/applications/org.gnome.Calculator.desktop";
        assert_eq!(
            launch_argv(path, &e, true).unwrap(),
            ["gio", "launch", path]
        );
        assert_eq!(
            launch_argv(path, &e, false).unwrap(),
            ["gnome-calculator", "--mode"]
        );
        let term = DesktopEntry {
            terminal: true,
            ..e.clone()
        };
        assert!(launch_argv(path, &term, false)
            .unwrap_err()
            .contains("terminal"));
        assert_eq!(launch_argv(path, &term, true).unwrap()[0], "gio");
        let shell = DesktopEntry {
            exec: Some("sh -c 'x'".into()),
            ..e.clone()
        };
        assert!(launch_argv(path, &shell, false)
            .unwrap_err()
            .contains("shell"));
        let none = DesktopEntry { exec: None, ..e };
        assert!(launch_argv(path, &none, false).is_err());
    }

    #[test]
    fn theme_folder_names_give_their_pixel_size() {
        assert_eq!(folder_px("48x48"), Some(48));
        assert_eq!(folder_px("24x24@2x"), Some(48));
        assert_eq!(folder_px("32"), Some(32));
        assert_eq!(folder_px("scalable"), None);
        assert_eq!(folder_px("symbolic"), None);
        assert_eq!(folder_px("apps"), None);
        assert_eq!(folder_px("16x16@x"), None);
    }

    /// The theme dirs of an Ubuntu box in miniature: Yaru (inherits Humanity, hicolor) under
    /// `/usr/share/icons`, a Flatpak export's hicolor, the user's own icons, a pixmap.
    #[test]
    fn icon_names_resolve_through_the_theme_chain() {
        let s = scratch("icon-themes");
        let user = s.0.join("home/.local/share/icons");
        let flatpak = s.0.join("flatpak/exports/share/icons");
        let system = s.0.join("usr/share/icons");
        let pixmaps = s.0.join("pixmaps");
        let png = |p: PathBuf| {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"png").unwrap();
            p
        };
        std::fs::create_dir_all(system.join("Yaru")).unwrap();
        std::fs::write(
            system.join("Yaru/index.theme"),
            "[Icon Theme]\nName=Yaru\nInherits=Humanity,hicolor\n",
        )
        .unwrap();
        let calc16 = png(system.join("Yaru/16x16/apps/org.gnome.Calculator.png"));
        let calc32 = png(system.join("Yaru/16x16@2x/apps/org.gnome.Calculator.png"));
        let calc48 = png(system.join("Yaru/48x48/apps/org.gnome.Calculator.png"));
        // hicolor has the same name too, but the current theme wins
        png(system.join("hicolor/16x16/apps/org.gnome.Calculator.png"));
        // only scalable (SVG) in hicolor: not a PNG, a miss
        std::fs::create_dir_all(system.join("hicolor/scalable/apps")).unwrap();
        std::fs::write(system.join("hicolor/scalable/apps/svg-only.svg"), b"<svg/>").unwrap();
        // a Flatpak export, found through hicolor in another base
        let deskflow = png(flatpak.join("hicolor/512x512/apps/org.deskflow.deskflow.png"));
        // a theme laid out <context>/<size>
        let humanity = png(system.join("Humanity/apps/48/gvim.png"));
        let user_icon = png(user.join("hicolor/48x48/apps/mine.png"));
        let pixmap = png(pixmaps.join("old-app.png"));
        let generic = png(system.join("Yaru/32x32/mimetypes/application-x-executable.png"));

        let bases = vec![user.clone(), flatpak.clone(), system.clone()];
        let themes = theme_chain("Yaru", &bases);
        assert_eq!(themes, ["Yaru", "Humanity", "hicolor"]);
        assert_eq!(
            theme_chain("NoSuchTheme", &bases),
            ["NoSuchTheme", "hicolor"]
        );
        let px = [pixmaps.clone()];
        let find = |name: &str, size| find_icon(name, &themes, &bases, &px, size);

        assert_eq!(find("org.gnome.Calculator", 16), Some(calc16));
        assert_eq!(
            find("org.gnome.Calculator", 32),
            Some(calc32),
            "@2x counts double"
        );
        assert_eq!(find("org.gnome.Calculator", 40), Some(calc48.clone()));
        assert_eq!(
            find("org.gnome.Calculator", 256),
            Some(calc48),
            "else the largest"
        );
        assert_eq!(find("org.deskflow.deskflow", 16), Some(deskflow));
        assert_eq!(find("gvim", 16), Some(humanity));
        assert_eq!(find("mine", 16), Some(user_icon));
        assert_eq!(find("old-app", 16), Some(pixmap.clone()));
        assert_eq!(find("old-app.png", 16), Some(pixmap.clone()));
        assert_eq!(
            find(&pixmap.to_string_lossy(), 16),
            Some(pixmap),
            "absolute path"
        );
        assert_eq!(find("svg-only", 16), None);
        assert_eq!(find("../escape", 16), None);
        assert_eq!(find("", 16), None);

        let e = |icon: Option<&str>| DesktopEntry {
            icon: icon.map(String::from),
            ..DesktopEntry::default()
        };
        assert_eq!(
            desktop_icon(&e(Some("svg-only")), &themes, &bases, &px, 16, false),
            Some(generic.clone()),
            "an icon that cannot be drawn falls back to the generic app icon"
        );
        assert_eq!(
            desktop_icon(&e(None), &themes, &bases, &px, 16, true),
            Some(generic)
        );

        let text = "[Desktop Entry]\nType=Application\nName=Calc\nIcon=org.gnome.Calculator\n";
        assert_eq!(
            parse_desktop(text, "C").unwrap().icon.as_deref(),
            Some("org.gnome.Calculator")
        );
        let home = PathBuf::from("/home/u");
        let (b, p) = icon_dirs(Some(&home), &[PathBuf::from("/usr/share")]);
        assert_eq!(
            b,
            [
                PathBuf::from("/home/u/.icons"),
                PathBuf::from("/usr/share/icons")
            ]
        );
        assert_eq!(p, [PathBuf::from("/usr/share/pixmaps")]);
    }

    /// A terminal app (vim) is offered only when `gio launch` can give it a terminal, and it is
    /// never an open-with pick.
    #[test]
    fn terminal_apps_need_gio() {
        let s = scratch("terminal-gio");
        let apps_dir = s.0.join("data/applications");
        std::fs::create_dir_all(&apps_dir).unwrap();
        std::fs::write(
            apps_dir.join("vim.desktop"),
            entry("Vim", "Terminal=true\nMimeType=text/plain;\n"),
        )
        .unwrap();
        std::fs::write(apps_dir.join("gui.desktop"), entry("Gui", "")).unwrap();
        let bin = s.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let dirs = [s.0.join("data")];
        let path_var = std::env::join_paths([&bin]).unwrap();

        let names = |apps: &[AppEntry]| apps.iter().map(|a| a.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&linux_apps(&dirs, "C", Some(&path_var))), ["Gui"]);

        let gio = bin.join("gio");
        std::fs::write(&gio, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&gio, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let apps = linux_apps(&dirs, "C", Some(&path_var));
        assert_eq!(names(&apps), ["Gui", "Vim"]);
        assert_eq!(apps[1].open_with, None, "never an open-with pick");
        let vim = parse_desktop(&entry("Vim", "Terminal=true\n"), "C").unwrap();
        assert_eq!(
            launch_argv(&apps[1].path, &vim, true).unwrap(),
            ["gio", "launch", apps[1].path.as_str()]
        );
    }

    /// An icon with only an SVG is served as that SVG (when the caller can draw one); an icon
    /// with both keeps its PNG.
    #[test]
    fn svg_only_icons_resolve_to_the_svg_and_png_still_wins() {
        let s = scratch("svg-icons");
        let system = s.0.join("usr/share/icons");
        let pixmaps = s.0.join("pixmaps");
        let put = |p: PathBuf, body: &[u8]| {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, body).unwrap();
            p
        };
        let svg_only = put(system.join("hicolor/scalable/apps/svg-only.svg"), b"<svg/>");
        // a sized folder holding an SVG loses to the scalable one
        put(system.join("hicolor/48x48/apps/svg-only.svg"), b"<svg/>");
        let both_png = put(system.join("hicolor/48x48/apps/both.png"), b"png");
        put(system.join("hicolor/scalable/apps/both.svg"), b"<svg/>");
        let pixmap_svg = put(pixmaps.join("old-svg.svg"), b"<svg/>");
        let generic = put(
            system.join("hicolor/32x32/mimetypes/application-x-executable.png"),
            b"png",
        );
        let bases = vec![system.clone()];
        let themes = theme_chain("hicolor", &bases);
        let px = [pixmaps.clone()];
        let e = |icon: &str| DesktopEntry {
            icon: Some(icon.into()),
            ..DesktopEntry::default()
        };
        let pick = |icon: &str, svg_ok| desktop_icon(&e(icon), &themes, &bases, &px, 16, svg_ok);

        assert_eq!(pick("svg-only", true), Some(svg_only.clone()));
        assert_eq!(pick("svg-only.svg", true), Some(svg_only.clone()));
        // an absolute Icon= path is a Unix path; on Windows the scratch path is not one
        #[cfg(unix)]
        assert_eq!(pick(&svg_only.to_string_lossy(), true), Some(svg_only));
        assert_eq!(
            pick("svg-only", false),
            Some(generic.clone()),
            "PNG-only callers"
        );
        assert_eq!(pick("both", true), Some(both_png), "a PNG beats an SVG");
        assert_eq!(pick("old-svg", true), Some(pixmap_svg));
        assert_eq!(pick("missing", true), Some(generic));
        assert_eq!(find_svg_icon("../escape", &themes, &bases, &px), None);
        assert_eq!(find_svg_icon("", &themes, &bases, &px), None);
    }

    /// Live, read-only, Ubuntu with GNOME: the real list has the calculator. Nothing launched.
    #[test]
    #[cfg(all(unix, not(target_os = "macos")))]
    #[ignore = "needs a GNOME desktop; run with --ignored on the Ubuntu box"]
    fn gnome_calculator_is_listed() {
        let apps = env_linux_apps(&env_data_dirs());
        assert!(
            apps.iter()
                .any(|a| a.aumid == "org.gnome.Calculator.desktop"
                    || a.open_with
                        .as_ref()
                        .is_some_and(|o| o.program == "gnome-calculator")),
            "no calculator among {} entries",
            apps.len()
        );
    }

    /// Live, read-only, Ubuntu with GNOME: the calculator's row draws its own icon, not the
    /// generic one.
    #[test]
    #[cfg(all(unix, not(target_os = "macos")))]
    #[ignore = "needs a GNOME desktop; run with --ignored on the Ubuntu box"]
    fn gnome_calculator_has_its_own_icon() {
        let icon = env_desktop_icon(
            Path::new("/usr/share/applications/org.gnome.Calculator.desktop"),
            16,
            false,
        )
        .expect("an icon");
        assert!(
            icon.to_string_lossy().contains("org.gnome.Calculator"),
            "{icon:?}"
        );
    }

    /// Live, read-only: lists this box's apps whose icon is SVG-only (served as SVG now), for
    /// a visual check. Prints; asserts nothing about the count.
    #[test]
    #[cfg(all(unix, not(target_os = "macos")))]
    #[ignore = "lists this desktop's SVG-only app icons; run with --ignored --nocapture"]
    fn list_svg_only_app_icons() {
        for app in env_linux_apps(&env_data_dirs()) {
            let path = [&app.lnk_path, &app.path]
                .into_iter()
                .find(|p| p.ends_with(".desktop"))
                .cloned()
                .unwrap_or_default();
            if let Some(icon) = env_desktop_icon(Path::new(&path), 32, true)
                .filter(|p| p.extension().is_some_and(|x| x == "svg"))
            {
                println!("SVG-ONLY {path} -> {}", icon.display());
            }
        }
    }
}

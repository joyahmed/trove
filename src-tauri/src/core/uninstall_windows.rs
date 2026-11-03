//! Windows: what Settings → Installed apps would list, read from the three Uninstall keys, and
//! the `UninstallString` split into a program Trove can start safely (plan 18, 1.2-1.3).
//!
//! The parsers are pure and tested on every OS; only `list()` touches the registry.
//!
//! ⛔ QuietUninstallString is never read, stored or sent: the uninstaller the person sees is the
//! one that asks them. `quiet_uninstall_string_is_never_read` keeps it that way.
//! ⛔ Nothing is appended to or stripped from the `UninstallString`: no silent flag, ever.

#![cfg_attr(not(windows), allow(dead_code))]

use super::uninstall::{stable_id, Command, Removable, Uninstallable};

/// The values the reader names — and the only ones (plan 18, 1.2).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RegRow {
    pub display_name: Option<String>,
    pub display_version: Option<String>,
    pub publisher: Option<String>,
    pub install_location: Option<String>,
    pub display_icon: Option<String>,
    pub uninstall_string: Option<String>,
    pub no_remove: Option<u32>,
    pub system_component: Option<u32>,
    pub parent_key_name: Option<String>,
    pub release_type: Option<String>,
}

/// What the pure parts need to know about the machine, so tests can fake it.
pub struct Ctx<'a> {
    /// does this file exist (a fake set in tests)
    pub exists: &'a dyn Fn(&str) -> bool,
    /// `%SystemRoot%`, e.g. `C:\Windows`
    pub system_root: String,
    /// lower-cased folders that are never an app's own folder: `%ProgramFiles%`,
    /// `%ProgramFiles(x86)%`, `%LOCALAPPDATA%\Programs`, `%SystemRoot%`, the user profile
    pub shared_roots: Vec<String>,
    /// lower-cased folder of Trove's own exe
    pub trove_dir: String,
}

/// `C:\X\` / `"C:\X"` → `c:\x`: lower-cased, unquoted, no trailing slash, `/` read as `\`.
pub fn norm_dir(s: &str) -> String {
    let t = s.trim().trim_matches('"').trim().replace('/', "\\");
    t.trim_end_matches('\\').to_lowercase()
}

/// The folder part of a Windows path (`C:\a\b.exe` → `C:\a`); `''` when there is none.
pub fn parent_dir(path: &str) -> &str {
    match path.rfind('\\') {
        Some(0) | None => "",
        // keep `C:\` for a file at a drive root
        Some(i) if i == 2 && path.as_bytes().get(1) == Some(&b':') => &path[..3],
        Some(i) => &path[..i],
    }
}

/// `C:\…` — a drive-absolute path. A relative or UNC program is never started.
fn is_drive_absolute(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\'
}

/// A folder no installer may claim as its own: a drive root or a shared root. As a join folder
/// it would match every tile (plan 18, 1.2).
fn is_shared_root(dir: &str, ctx: &Ctx) -> bool {
    let d = norm_dir(dir);
    let b = d.as_bytes();
    (b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || ctx.shared_roots.contains(&d)
}

/// `"C:\x\app.exe",0` → `C:\x\app.exe`.
fn icon_file(icon: &str) -> &str {
    let t = icon.trim();
    let t = match t.rfind(',') {
        Some(i)
            if t[i + 1..]
                .trim()
                .trim_start_matches('-')
                .chars()
                .all(|c| c.is_ascii_digit()) =>
        {
            &t[..i]
        }
        _ => t,
    };
    t.trim().trim_matches('"')
}

/// Split an `UninstallString` into an absolute program and its arguments, exactly as written.
///
/// - `"C:\…\x.exe" args` — the quoted program.
/// - `C:\Program Files\X\unins000.exe args` — unquoted: every space is a place the program
///   might end, as `CreateProcess` reads it (`C:\Program` + `.exe` first). ⛔ If more than one
///   of those programs exists (a planted `C:\Program.exe`), that is refused, never a guess.
/// - `MsiExec.exe /X{…}`, `rundll32.exe …` — a bare name resolves to `%SystemRoot%\System32\`
///   only, never the current folder or `PATH`.
///
/// `None` = no uninstaller Trove will start. The program must exist, be drive-absolute and be an
/// `.exe` (a quoted script or shortcut would run through its file association).
pub fn split_command(s: &str, exists: &dyn Fn(&str) -> bool, system_root: &str) -> Option<Command> {
    let s = s.trim_start();
    if s.is_empty() {
        return None;
    }
    let (program, params) = if let Some(quoted) = s.strip_prefix('"') {
        let end = quoted.find('"')?;
        let program = &quoted[..end];
        let params = quoted[end + 1..].trim_start();
        if program.contains('\\') || program.contains('/') {
            (program.to_string(), params.to_string())
        } else {
            (in_system32(program, system_root)?, params.to_string())
        }
    } else {
        let first_end = s.find(char::is_whitespace).unwrap_or(s.len());
        let first = &s[..first_end];
        if !first.contains('\\') && !first.contains('/') {
            (
                in_system32(first, system_root)?,
                s[first_end..].trim_start().to_string(),
            )
        } else {
            // every place the program could end: before each space, and the whole string
            let mut ends: Vec<usize> = s
                .char_indices()
                .filter(|(_, c)| *c == ' ' || *c == '\t')
                .map(|(i, _)| i)
                .collect();
            ends.push(s.len());
            ends.dedup();
            let found: Vec<(String, usize)> = ends
                .into_iter()
                .map(|i| (&s[..i], i))
                .filter(|(p, _)| !p.ends_with(' ') && !p.is_empty())
                .map(|(p, i)| {
                    if p.to_ascii_lowercase().ends_with(".exe") {
                        (p.to_string(), i)
                    } else {
                        (format!("{p}.exe"), i)
                    }
                })
                .filter(|(p, _)| exists(p))
                .collect();
            if found.len() != 1 {
                return None;
            }
            let (program, i) = found.into_iter().next()?;
            (program, s[i..].trim_start().to_string())
        }
    };
    // ⛔ `ShellExecuteExW` "open" follows file associations: a `.vbs`, `.lnk` or `.bat` would run
    // its handler, not an uninstaller. Only an `.exe` is started.
    if !is_drive_absolute(&program)
        || !program.to_ascii_lowercase().ends_with(".exe")
        || !exists(&program)
    {
        return None;
    }
    let dir = parent_dir(&program).to_string();
    Some(Command {
        program,
        params,
        dir,
    })
}

/// A bare program name, only from `%SystemRoot%\System32` (`.exe` added when it has none).
fn in_system32(name: &str, system_root: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() || system_root.is_empty() || name.contains(':') {
        return None;
    }
    let file = if name.to_ascii_lowercase().ends_with(".exe") {
        name.to_string()
    } else {
        format!("{name}.exe")
    };
    Some(format!(
        "{}\\System32\\{file}",
        system_root.trim_end_matches('\\')
    ))
}

/// Which of the three keys a row came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Machine,
    Machine32,
    User,
}

impl View {
    fn tag(self) -> &'static str {
        match self {
            View::Machine => "hklm",
            View::Machine32 => "hklm32",
            View::User => "hkcu",
        }
    }
}

fn nonempty(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// One Uninstall subkey → a row, shown the way Settings shows it. `None` = hidden.
pub fn row_to_app(view: View, key: &str, row: &RegRow, ctx: &Ctx) -> Option<Uninstallable> {
    let name = nonempty(&row.display_name)?;
    if nonempty(&row.parent_key_name).is_some() {
        return None;
    }
    if let Some(t) = nonempty(&row.release_type) {
        let t = t.to_ascii_lowercase();
        if t == "update" || t == "hotfix" || t == "security update" {
            return None;
        }
    }
    if row.system_component == Some(1) {
        return None;
    }

    let command = nonempty(&row.uninstall_string)
        .and_then(|s| split_command(s, ctx.exists, &ctx.system_root));

    let location = nonempty(&row.install_location)
        .map(norm_dir)
        .filter(|d| !d.is_empty() && !is_shared_root(d, ctx))
        .unwrap_or_default();
    let folder = if location.is_empty() {
        nonempty(&row.display_icon)
            .map(|i| norm_dir(parent_dir(icon_file(i))))
            .filter(|d| !d.is_empty() && !is_shared_root(d, ctx))
            .unwrap_or_default()
    } else {
        location.clone()
    };

    let own_dir = if location.is_empty() {
        command
            .as_ref()
            .map(|c| norm_dir(&c.dir))
            .unwrap_or_default()
    } else {
        location
    };
    let removable = if !ctx.trove_dir.is_empty() && own_dir == ctx.trove_dir {
        Removable::Trove
    } else if row.no_remove == Some(1) {
        Removable::System
    } else if command.is_none() {
        Removable::NoUninstaller
    } else {
        Removable::Yes
    };

    let command = if removable == Removable::Yes {
        command
    } else {
        None
    };
    Some(Uninstallable {
        id: stable_id(&["windows", view.tag(), &key.to_lowercase()]),
        name: name.to_string(),
        version: nonempty(&row.display_version).unwrap_or("").to_string(),
        publisher: nonempty(&row.publisher).unwrap_or("").to_string(),
        folder,
        path: String::new(),
        removable,
        typed: false,
        program: command
            .as_ref()
            .map(|c| c.program.clone())
            .unwrap_or_default(),
        stamp: String::new(),
        command,
        deb: None,
    })
}

/// The same `DisplayName` + `DisplayVersion` in two views is one program: the first view wins
/// (machine 64-bit, then 32-bit, then the user's).
pub fn merge(rows: Vec<Uninstallable>) -> Vec<Uninstallable> {
    let mut seen = std::collections::HashSet::new();
    rows.into_iter()
        .filter(|r| seen.insert((r.name.to_lowercase(), r.version.to_lowercase())))
        .collect()
}

#[cfg(windows)]
const VIEWS: [(View, crate::core::registry::Hive, &str); 3] = {
    use crate::core::registry::Hive;
    [
        (
            View::Machine,
            Hive::LocalMachine,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            View::Machine32,
            Hive::LocalMachine,
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            View::User,
            Hive::CurrentUser,
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
    ]
};

/// The machine's context: env roots and Trove's folder.
#[cfg(windows)]
fn live_roots() -> (String, Vec<String>, String) {
    let env = |n: &str| std::env::var(n).unwrap_or_default();
    let system_root = {
        let r = env("SystemRoot");
        if r.is_empty() {
            r"C:\Windows".to_string()
        } else {
            r
        }
    };
    let local = env("LOCALAPPDATA");
    let roots = [
        env("ProgramFiles"),
        env("ProgramFiles(x86)"),
        env("ProgramW6432"),
        if local.is_empty() {
            String::new()
        } else {
            format!(r"{local}\Programs")
        },
        system_root.clone(),
        env("USERPROFILE"),
    ]
    .iter()
    .filter(|r| !r.is_empty())
    .map(|r| norm_dir(r))
    .collect();
    let trove_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| norm_dir(&d.to_string_lossy())))
        .unwrap_or_default();
    (system_root, roots, trove_dir)
}

/// Every program the three Uninstall keys list, as Settings would show it. Reads only.
#[cfg(windows)]
pub fn list() -> Result<Vec<Uninstallable>, String> {
    use crate::core::registry::{read_dword_in, read_expand_sz_in, read_sz_in, subkeys_in};
    let (system_root, shared_roots, trove_dir) = live_roots();
    let exists = |p: &str| std::path::Path::new(p).is_file();
    let ctx = Ctx {
        exists: &exists,
        system_root,
        shared_roots,
        trove_dir,
    };
    let mut rows = Vec::new();
    for (view, hive, base) in VIEWS {
        // a missing key is an empty list; a key we may not read is skipped, not an error
        let Ok(keys) = subkeys_in(hive, base) else {
            continue;
        };
        for key in keys {
            let path = format!(r"{base}\{key}");
            let sz = |n: &str| read_sz_in(hive, &path, n).ok().flatten();
            let ex = |n: &str| read_expand_sz_in(hive, &path, n).ok().flatten();
            let dw = |n: &str| read_dword_in(hive, &path, n).ok().flatten();
            let reg = RegRow {
                display_name: sz("DisplayName"),
                display_version: sz("DisplayVersion"),
                publisher: sz("Publisher"),
                install_location: ex("InstallLocation"),
                display_icon: ex("DisplayIcon"),
                uninstall_string: ex("UninstallString"),
                no_remove: dw("NoRemove"),
                system_component: dw("SystemComponent"),
                parent_key_name: sz("ParentKeyName"),
                release_type: sz("ReleaseType"),
            };
            if let Some(app) = row_to_app(view, &key, &reg, &ctx) {
                rows.push(app);
            }
        }
    }
    let mut rows = merge(rows);
    rows.sort_by_key(|r| r.name.to_lowercase());
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn ctx_with<'a>(exists: &'a dyn Fn(&str) -> bool) -> Ctx<'a> {
        Ctx {
            exists,
            system_root: r"C:\Windows".into(),
            shared_roots: vec![
                r"c:\program files".into(),
                r"c:\program files (x86)".into(),
                r"c:\users\alex\appdata\local\programs".into(),
                r"c:\windows".into(),
                r"c:\users\alex".into(),
            ],
            trove_dir: r"c:\program files\trove".into(),
        }
    }

    fn files(list: &[&str]) -> impl Fn(&str) -> bool {
        let set: HashSet<String> = list.iter().map(|s| s.to_lowercase()).collect();
        move |p: &str| set.contains(&p.to_lowercase())
    }

    const SEVEN: &str = r"C:\Program Files\7-Zip\Uninstall.exe";

    fn seven_zip() -> RegRow {
        RegRow {
            display_name: Some("7-Zip 24.08 (x64)".into()),
            display_version: Some("24.08".into()),
            publisher: Some("Igor Pavlov".into()),
            install_location: Some(r"C:\Program Files\7-Zip\".into()),
            uninstall_string: Some(format!("\"{SEVEN}\"")),
            ..RegRow::default()
        }
    }

    #[test]
    fn system_components_are_hidden() {
        let e = files(&[SEVEN]);
        let ctx = ctx_with(&e);
        let mut r = seven_zip();
        r.system_component = Some(1);
        assert_eq!(row_to_app(View::Machine, "7-Zip", &r, &ctx), None);
        let nameless = RegRow {
            display_name: Some("  ".into()),
            ..seven_zip()
        };
        assert_eq!(row_to_app(View::Machine, "x", &nameless, &ctx), None);
    }

    #[test]
    fn updates_are_hidden() {
        let e = files(&[SEVEN]);
        let ctx = ctx_with(&e);
        for t in ["Update", "Hotfix", "security update"] {
            let r = RegRow {
                release_type: Some(t.into()),
                ..seven_zip()
            };
            assert_eq!(row_to_app(View::Machine, "k", &r, &ctx), None, "{t}");
        }
        let child = RegRow {
            parent_key_name: Some("Office".into()),
            ..seven_zip()
        };
        assert_eq!(row_to_app(View::Machine, "k", &child, &ctx), None);
    }

    #[test]
    fn no_remove_has_no_button() {
        let e = files(&[SEVEN]);
        let ctx = ctx_with(&e);
        let r = RegRow {
            no_remove: Some(1),
            ..seven_zip()
        };
        let app = row_to_app(View::Machine, "k", &r, &ctx).unwrap();
        assert_eq!(app.removable, Removable::System);
        assert_eq!(app.command, None);
        assert_eq!(app.program, "");
        let ok = row_to_app(View::Machine, "k", &seven_zip(), &ctx).unwrap();
        assert_eq!(ok.removable, Removable::Yes);
        // the confirm shows the resolved program
        assert_eq!(ok.program, SEVEN);
        assert_eq!(ok.publisher, "Igor Pavlov");
    }

    #[test]
    fn two_views_merge() {
        let e = files(&[SEVEN]);
        let ctx = ctx_with(&e);
        let a = row_to_app(View::Machine, "7-Zip", &seven_zip(), &ctx).unwrap();
        let b = row_to_app(View::Machine32, "7-Zip", &seven_zip(), &ctx).unwrap();
        assert_ne!(a.id, b.id);
        let other_version = row_to_app(
            View::User,
            "7-Zip",
            &RegRow {
                display_version: Some("23.01".into()),
                ..seven_zip()
            },
            &ctx,
        )
        .unwrap();
        let merged = merge(vec![a.clone(), b, other_version]);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0], a);
    }

    #[test]
    fn trove_is_refused() {
        let unins = r"C:\Program Files\Trove\uninstall.exe";
        let e = files(&[unins]);
        let ctx = ctx_with(&e);
        let by_location = RegRow {
            display_name: Some("Trove".into()),
            install_location: Some(r"C:\Program Files\Trove".into()),
            uninstall_string: Some(format!("\"{unins}\"")),
            ..RegRow::default()
        };
        let app = row_to_app(View::User, "Trove", &by_location, &ctx).unwrap();
        assert_eq!(app.removable, Removable::Trove);
        assert_eq!(app.command, None);
        // no InstallLocation: the uninstaller's own folder tells
        let by_program = RegRow {
            install_location: None,
            ..by_location
        };
        let app = row_to_app(View::User, "Trove", &by_program, &ctx).unwrap();
        assert_eq!(app.removable, Removable::Trove);
    }

    #[test]
    fn match_key_from_install_location_or_icon() {
        let e = files(&[SEVEN]);
        let ctx = ctx_with(&e);
        let app = row_to_app(View::Machine, "k", &seven_zip(), &ctx).unwrap();
        assert_eq!(app.folder, r"c:\program files\7-zip");
        let by_icon = RegRow {
            install_location: None,
            display_icon: Some(r#""C:\Program Files\Foo App\foo.exe",0"#.into()),
            ..seven_zip()
        };
        let app = row_to_app(View::Machine, "k", &by_icon, &ctx).unwrap();
        assert_eq!(app.folder, r"c:\program files\foo app");
        let none = RegRow {
            install_location: None,
            display_icon: None,
            ..seven_zip()
        };
        assert_eq!(
            row_to_app(View::Machine, "k", &none, &ctx).unwrap().folder,
            ""
        );
    }

    #[test]
    fn expand_sz_uninstall_string_is_read() {
        // `list()` reads UninstallString with `read_expand_sz_in`, which expands `%VAR%`; the
        // expanded text is what reaches the parser
        let raw = r#""%ProgramFiles%\7-Zip\Uninstall.exe""#;
        let expanded = crate::core::registry::expand_env(raw, &|v| {
            (v.eq_ignore_ascii_case("programfiles")).then(|| r"C:\Program Files".to_string())
        });
        let e = files(&[SEVEN]);
        let ctx = ctx_with(&e);
        let r = RegRow {
            uninstall_string: Some(expanded),
            ..seven_zip()
        };
        let app = row_to_app(View::Machine, "k", &r, &ctx).unwrap();
        assert_eq!(app.removable, Removable::Yes);
        assert_eq!(app.command.unwrap().program, SEVEN);
        let src = include_str!("uninstall_windows.rs");
        assert!(src.contains(r#"uninstall_string: ex("UninstallString")"#));
        assert!(src.contains(r#"install_location: ex("InstallLocation")"#));
        assert!(src.contains(r#"display_icon: ex("DisplayIcon")"#));
    }

    #[test]
    fn root_install_location_is_ignored() {
        let e = files(&[SEVEN]);
        let ctx = ctx_with(&e);
        for root in [
            r"C:\",
            "D:",
            r"C:\Program Files",
            r"C:\Program Files (x86)\",
            r"C:\Users\alex\AppData\Local\Programs",
            r"C:\Windows",
            r"C:\Users\alex",
        ] {
            let r = RegRow {
                install_location: Some(root.into()),
                display_icon: Some(r"C:\Program Files\7-Zip\7zFM.exe".into()),
                ..seven_zip()
            };
            let app = row_to_app(View::Machine, "k", &r, &ctx).unwrap();
            assert_eq!(app.folder, r"c:\program files\7-zip", "{root}");
        }
        // an icon at a shared root is no folder either
        let r = RegRow {
            install_location: None,
            display_icon: Some(r"C:\Windows\foo.exe".into()),
            ..seven_zip()
        };
        assert_eq!(row_to_app(View::Machine, "k", &r, &ctx).unwrap().folder, "");
    }

    #[test]
    fn quoted_program() {
        let e = files(&[SEVEN]);
        let c = split_command(&format!("\"{SEVEN}\" /S-not-added"), &e, r"C:\Windows").unwrap();
        assert_eq!(c.program, SEVEN);
        assert_eq!(c.params, "/S-not-added");
        assert_eq!(c.dir, r"C:\Program Files\7-Zip");
    }

    #[test]
    fn unquoted_path_with_spaces() {
        let unins = r"C:\Program Files\Some App\unins000.exe";
        let e = files(&[unins]);
        let c = split_command(&format!("{unins} /LOG"), &e, r"C:\Windows").unwrap();
        assert_eq!(c.program, unins);
        assert_eq!(c.params, "/LOG");
        let c = split_command(unins, &e, r"C:\Windows").unwrap();
        assert_eq!(c.params, "");
    }

    #[test]
    fn two_existing_prefixes_are_refused() {
        let unins = r"C:\Program Files\Some App\unins000.exe";
        let e = files(&[r"C:\Program.exe", unins]);
        assert_eq!(split_command(unins, &e, r"C:\Windows"), None);
        let e = files(&[r"C:\Program Files\Some.exe", unins]);
        assert_eq!(split_command(unins, &e, r"C:\Windows"), None);
    }

    #[test]
    fn bare_msiexec_resolves_to_system32_only() {
        let msi = r"C:\Windows\System32\MsiExec.exe";
        let e = files(&[msi, r"C:\cwd\MsiExec.exe"]);
        let c = split_command("MsiExec.exe /X{1234-ABCD}", &e, r"C:\Windows").unwrap();
        assert_eq!(c.program, msi);
        assert_eq!(c.dir, r"C:\Windows\System32");
        // no extension: still System32, `.exe` added
        let c = split_command("msiexec /I{1234}", &e, r"C:\Windows\").unwrap();
        assert_eq!(c.program.to_lowercase(), msi.to_lowercase());
        // not in System32 → nothing, even if it sits in the current folder
        let only_cwd = files(&[r"C:\cwd\MsiExec.exe"]);
        assert_eq!(
            split_command("MsiExec.exe /X{1}", &only_cwd, r"C:\Windows"),
            None
        );
    }

    #[test]
    fn msiexec_kept_as_is() {
        let msi = r"C:\Windows\System32\MsiExec.exe";
        let e = files(&[msi]);
        let c = split_command(
            "MsiExec.exe /I{23170F69-40C1-2702-2408-000001000000}",
            &e,
            r"C:\Windows",
        )
        .unwrap();
        // /I stays /I: the installer's own Repair/Remove screen is a second confirm
        assert_eq!(c.params, "/I{23170F69-40C1-2702-2408-000001000000}");
    }

    #[test]
    fn rundll32_kept_as_is() {
        let r = r"C:\Windows\System32\rundll32.exe";
        let e = files(&[r]);
        let s = r#"rundll32.exe dfshim.dll,ShArpMaintain App.application, Culture=neutral"#;
        let c = split_command(s, &e, r"C:\Windows").unwrap();
        assert_eq!(c.program, r);
        assert_eq!(
            c.params,
            "dfshim.dll,ShArpMaintain App.application, Culture=neutral"
        );
    }

    #[test]
    fn missing_exe_is_no_uninstaller() {
        let none = files(&[]);
        assert_eq!(
            split_command(&format!("\"{SEVEN}\""), &none, r"C:\Windows"),
            None
        );
        assert_eq!(split_command(SEVEN, &none, r"C:\Windows"), None);
        assert_eq!(split_command("", &none, r"C:\Windows"), None);
        // relative or UNC programs are never started
        let rel = files(&[r"unins\x.exe", r"\\server\share\x.exe"]);
        assert_eq!(split_command(r#""unins\x.exe""#, &rel, r"C:\Windows"), None);
        assert_eq!(
            split_command(r#""\\server\share\x.exe""#, &rel, r"C:\Windows"),
            None
        );
        let ctx = ctx_with(&none);
        let app = row_to_app(View::Machine, "k", &seven_zip(), &ctx).unwrap();
        assert_eq!(app.removable, Removable::NoUninstaller);
        let no_string = RegRow {
            uninstall_string: None,
            ..seven_zip()
        };
        let e = files(&[SEVEN]);
        let ctx = ctx_with(&e);
        assert_eq!(
            row_to_app(View::Machine, "k", &no_string, &ctx)
                .unwrap()
                .removable,
            Removable::NoUninstaller
        );
    }

    #[test]
    fn only_an_exe_is_started() {
        // ShellExecute "open" follows file associations: a script or a shortcut would run
        // whatever its handler is, so only an .exe counts as an uninstaller
        for p in [
            r"C:\Program Files\X\uninstall.vbs",
            r"C:\Program Files\X\uninstall.lnk",
            r"C:\Program Files\X\uninstall.bat",
            r"C:\Program Files\X\uninstall.cmd",
            r"C:\Program Files\X\uninstall",
        ] {
            let e = files(&[p]);
            assert_eq!(
                split_command(&format!("\"{p}\" /x"), &e, r"C:\Windows"),
                None,
                "{p}"
            );
        }
        let vbs = r"C:\Program Files\X\uninstall.vbs";
        let e = files(&[vbs]);
        let ctx = ctx_with(&e);
        let r = RegRow {
            uninstall_string: Some(format!("\"{vbs}\"")),
            ..seven_zip()
        };
        let app = row_to_app(View::Machine, "k", &r, &ctx).unwrap();
        assert_eq!(app.removable, Removable::NoUninstaller);
        assert_eq!(app.command, None);
        // an .exe in any case is fine
        let up = r"C:\Program Files\X\UNINS000.EXE";
        let e = files(&[up]);
        assert!(split_command(&format!("\"{up}\""), &e, r"C:\Windows").is_some());
    }

    #[test]
    fn nothing_is_appended() {
        let unins = r"C:\Program Files\Some App\unins000.exe";
        let msi = r"C:\Windows\System32\MsiExec.exe";
        let e = files(&[unins, msi, SEVEN]);
        for (s, params) in [
            (format!("\"{unins}\""), ""),
            (
                format!("\"{unins}\"   /SUPPRESSMSGBOXES"),
                "/SUPPRESSMSGBOXES",
            ),
            ("MsiExec.exe /X{AB}".to_string(), "/X{AB}"),
            (SEVEN.to_string(), ""),
        ] {
            let c = split_command(&s, &e, r"C:\Windows").unwrap();
            assert_eq!(c.params, params, "{s}");
            for silent in ["/S ", "/qn", "/quiet", "/VERYSILENT"] {
                if !s.contains(silent) {
                    assert!(!c.params.contains(silent), "{s}");
                }
            }
        }
    }

    /// Plan 18, 1.4: the quiet variant may appear only in comments, never in code.
    #[test]
    fn quiet_uninstall_string_is_never_read() {
        let word = ["Quiet", "Uninstall", "String"].concat();
        for (name, src) in [
            ("uninstall_windows.rs", include_str!("uninstall_windows.rs")),
            ("uninstall.rs", include_str!("uninstall.rs")),
            (
                "commands/uninstall.rs",
                include_str!("../commands/uninstall.rs"),
            ),
        ] {
            for (i, line) in src.lines().enumerate() {
                if line.contains(&word) {
                    let t = line.trim_start();
                    assert!(
                        t.starts_with("//"),
                        "{name}:{} uses the quiet uninstall string in code",
                        i + 1
                    );
                }
            }
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "reads this machine's registry; lists only, never uninstalls"]
    fn live_list_has_rows() {
        let rows = list().expect("list");
        assert!(!rows.is_empty());
        eprintln!("{} rows", rows.len());
    }
}

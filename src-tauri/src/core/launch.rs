//! What a launch asks for, from the command line explorer.exe callers already use:
//! `app <path>`, `app /select,<path>`, and the `/e,` `/n,` `/root,` prefixes other programs
//! still pass. Relative paths resolve against the caller's cwd. A shell folder given as
//! `::{CLSID}` (Explorer's own form for This PC) is passed through verbatim; the frontend
//! maps it to a place.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Explorer's argument for the Recycle Bin (a desktop double-click passes it); the frontend
/// compares case-insensitively and shows its own bin view. This PC's CLSID is handled the
/// same way there; any other `::{…}` is handed back to explorer.exe.
pub const RECYCLE_BIN_CLSID: &str = "::{645FF040-5081-101B-9F08-00AA002F954E}";

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    /// Folder to show, or a `::{CLSID}` shell folder the frontend maps to a place. For
    /// `/select,` this is the item's parent.
    pub path: Option<String>,
    /// Item to highlight inside `path`.
    pub select: Option<String>,
    /// `--hidden`: start in the tray, no window (the "start with Windows" entry passes it).
    #[serde(default)]
    pub hidden: bool,
}

/// `parse` for this process's own command line: a Store-build logon StartupTask carries no
/// `--hidden`, so its activation kind stands in for it (`core::startup`).
pub fn parse_own(args: &[String], cwd: &Path) -> Launch {
    let mut l = parse(args, cwd);
    l.hidden |= crate::core::startup::launched_by_login_task();
    l
}

/// `args` excludes the executable. Unknown switches are ignored, as explorer.exe does.
pub fn parse(args: &[String], cwd: &Path) -> Launch {
    let mut select: Option<PathBuf> = None;
    let mut path: Option<PathBuf> = None;
    let mut hidden = false;
    // `explorer /select, "C:\x\f.txt"` (a space after the comma) arrives as two arguments:
    // `/select,` then the item.
    let mut select_next = false;

    for raw in args {
        let arg = raw.trim_matches('"');
        if arg.is_empty() {
            continue;
        }
        if select_next {
            select_next = false;
            select = Some(resolve(arg, cwd));
            continue;
        }
        let lower = arg.to_ascii_lowercase();
        if lower == "--hidden" {
            hidden = true;
        } else if let Some(rest) = lower.strip_prefix("/select,") {
            let item = arg[arg.len() - rest.len()..].trim().trim_matches('"');
            if item.is_empty() {
                // The item is the next argument. Resolving "" here opened the cwd instead.
                select_next = true;
            } else {
                select = Some(resolve(item, cwd));
            }
        } else if let Some(rest) = ["/e,", "/n,", "/root,"]
            .iter()
            .find_map(|p| lower.strip_prefix(p))
        {
            path = Some(resolve(&arg[arg.len() - rest.len()..], cwd));
        } else if lower == "/e" || lower == "/n" || lower.starts_with("/separate") {
            // bare switches with no path
        } else if !arg.starts_with('/') || !cfg!(windows) {
            // On Windows a leading `/` is an Explorer switch, and unknown ones are ignored. Elsewhere
            // an absolute path starts with `/`, so any other `/…` argument is a folder to open.
            path = Some(resolve(arg, cwd));
        }
    }

    if let Some(item) = select {
        let parent = item.parent().map(Path::to_path_buf);
        return Launch {
            path: parent.map(display),
            select: Some(display(item)),
            hidden,
        };
    }
    Launch {
        path: path.map(display),
        select: None,
        hidden,
    }
}

/// Whether a launch argument is the Recycle Bin's CLSID, in any case.
pub fn is_recycle_bin_arg(arg: &str) -> bool {
    arg.trim().eq_ignore_ascii_case(RECYCLE_BIN_CLSID)
}

fn resolve(s: &str, cwd: &Path) -> PathBuf {
    let s = s.trim().trim_matches('"');
    let p = Path::new(s);
    // `::{CLSID}` is a shell folder, not a relative path: keep it as typed.
    if p.is_absolute() || s.starts_with("::") {
        p.to_path_buf()
    } else {
        cwd.join(p)
    }
}

fn display(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }
    // Absolute paths are per-OS: a drive path is not absolute on Linux/macOS, so it would be joined
    // onto the cwd. `abs` builds the same shape with the platform's root and separator.
    fn abs(parts: &[&str]) -> String {
        let mut p = PathBuf::from(if cfg!(windows) { r"C:\" } else { "/" });
        p.extend(parts);
        p.to_string_lossy().into_owned()
    }
    fn cwd() -> PathBuf {
        PathBuf::from(if cfg!(windows) { r"D:\work" } else { "/work" })
    }

    #[test]
    fn no_args_is_an_empty_launch() {
        assert_eq!(parse(&[], &cwd()), Launch::default());
    }

    #[test]
    fn a_plain_path_is_the_folder() {
        let want = abs(&["Users", "alex"]);
        let l = parse(&args(&[&want]), &cwd());
        assert_eq!(l.path.as_deref(), Some(want.as_str()));
        assert_eq!(l.select, None);
    }

    #[test]
    fn a_relative_path_resolves_against_cwd() {
        let l = parse(&args(&["src"]), &cwd());
        assert_eq!(
            l.path,
            Some(cwd().join("src").to_string_lossy().into_owned())
        );
    }

    #[test]
    fn select_shows_the_parent_and_highlights_the_item() {
        let item = abs(&["Users", "alex", "notes.txt"]);
        let l = parse(&args(&[&format!("/select,{item}")]), &cwd());
        assert_eq!(l.path, Some(abs(&["Users", "alex"])));
        assert_eq!(l.select, Some(item));
    }

    #[test]
    fn select_is_case_insensitive_and_unquotes() {
        let item = abs(&["a b", "c.txt"]);
        let l = parse(&args(&[&format!("/SELECT,\"{item}\"")]), &cwd());
        assert_eq!(l.select, Some(item));
    }

    #[test]
    fn select_with_a_space_after_the_comma_takes_the_next_argument() {
        let item = abs(&["a b", "f.txt"]);
        let l = parse(&args(&["/select,", &item]), &cwd());
        assert_eq!(l.select, Some(item.clone()));
        assert_eq!(l.path, Some(abs(&["a b"])));
        // the same item glued to the switch, bare and quoted, lands in the same place
        let glued = parse(&args(&[&format!("/select,{item}")]), &cwd());
        assert_eq!(glued, l);
        let quoted = parse(&args(&[&format!("/select,\"{item}\"")]), &cwd());
        assert_eq!(quoted, l);
    }

    #[test]
    fn select_with_nothing_after_it_selects_nothing() {
        assert_eq!(parse(&args(&["/select,"]), &cwd()), Launch::default());
    }

    #[test]
    fn a_plain_folder_with_spaces_is_still_the_folder() {
        let want = abs(&["a b"]);
        let l = parse(&args(&[&want]), &cwd());
        assert_eq!(l.path, Some(want));
        assert_eq!(l.select, None);
    }

    #[test]
    fn the_recycle_bin_clsid_is_known_in_any_case() {
        assert!(is_recycle_bin_arg(
            "::{645ff040-5081-101b-9f08-00aa002f954e}"
        ));
        assert!(is_recycle_bin_arg(RECYCLE_BIN_CLSID));
        assert!(!is_recycle_bin_arg(
            "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"
        ));
        let l = parse(&args(&[RECYCLE_BIN_CLSID]), &cwd());
        assert_eq!(l.path.as_deref(), Some(RECYCLE_BIN_CLSID));
    }

    #[test]
    fn a_shell_clsid_passes_through_unresolved() {
        let l = parse(&args(&["::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"]), &cwd());
        assert_eq!(
            l.path.as_deref(),
            Some("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}")
        );
        assert_eq!(l.select, None);
    }

    #[test]
    fn hidden_switch_is_a_flag_beside_the_path() {
        let l = parse(&args(&["--hidden"]), &cwd());
        assert!(l.hidden);
        assert_eq!(l.path, None);
        let x = abs(&["x"]);
        let l = parse(&args(&[&x, "--HIDDEN"]), &cwd());
        assert!(l.hidden);
        assert_eq!(l.path, Some(x));
        assert!(!parse(&[], &cwd()).hidden);
    }

    #[test]
    fn legacy_prefixes_and_unknown_switches() {
        let (x, y) = (abs(&["x"]), abs(&["y"]));
        let l = parse(&args(&["/e,", "/n", &format!("/root,{x}")]), &cwd());
        assert_eq!(l.path, Some(x));
        let l = parse(&args(&["/separate", &format!("/e,{y}")]), &cwd());
        assert_eq!(l.path, Some(y));
    }
}

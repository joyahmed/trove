//! Windows' registered context-menu verbs and the person's own commands. Mirrors
//! `src/lib/api/shell-verbs.ts`.
use std::path::Path;
use std::sync::Mutex;

use crate::core::known_apps::{self, DetectedApp};
use crate::core::shell_verbs::{self, ShellVerb, VerbScope};

static VERBS: Mutex<Option<Vec<ShellVerb>>> = Mutex::new(None);

/// Every verb on this machine, read once per process; `refresh` re-reads the hives.
#[tauri::command(async)]
pub fn shell_verbs(refresh: bool) -> Vec<ShellVerb> {
    let mut guard = VERBS.lock().unwrap_or_else(|e| e.into_inner());
    if refresh || guard.is_none() {
        *guard = Some(shell_verbs::all_verbs());
    }
    guard.clone().unwrap_or_default()
}

/// The common context-menu entries this machine could actually run — VS Code, Zed, VLC,
/// Windows Terminal — each ready to add as one click instead of three hand-typed boxes.
///
/// ⚠️ Reports only. Adding an entry stays the person's decision in the dialog; a file manager
/// that grows menu items on its own because it noticed an installer is one nobody trusts.
#[tauri::command(async)]
pub fn detect_common_commands() -> Vec<DetectedApp> {
    known_apps::detect()
}

/// Run a registered verb for `path`, from the folder that holds it.
#[tauri::command(async)]
pub fn run_shell_verb(key: String, scope: VerbScope, path: String) -> Result<(), String> {
    let template = {
        let guard = VERBS.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .and_then(|v| {
                v.iter()
                    .find(|x| x.scope == scope && x.key.eq_ignore_ascii_case(&key))
            })
            .map(|v| v.command.clone())
    }
    .ok_or_else(|| format!("No such context-menu entry: {key}"))?;
    shell_verbs::run(&template, &path).map_err(|e| format!("{key}: {e}"))
}

/// The file a custom command's `program` would actually start, or `None` when nothing would run:
/// a bare name that neither `App Paths` nor `PATH` knows, or a path to no file. The Customize
/// form asks this before it lets a command be saved.
///
/// ⚠️ Only the form asks. `run_custom_command` never refuses on this basis, so a command saved
/// before the check existed still runs exactly as it did.
#[tauri::command(async)]
pub fn resolve_custom_program(program: String) -> Option<String> {
    resolve_custom(&program)
}

fn resolve_custom(program: &str) -> Option<String> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains('\\') || trimmed.contains('/') {
        return Path::new(trimmed).is_file().then(|| trimmed.to_string());
    }
    // the same ladder `run_custom` uses: App Paths, then PATH with exe/com/cmd/bat
    let resolved = known_apps::resolve_program(trimmed);
    if resolved != trimmed {
        return Some(resolved);
    }
    // a name typed with no extension off Windows (`sh`), which the ladder above does not try bare
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(trimmed))
        .find(|full| full.is_file())
        .map(|full| full.to_string_lossy().into_owned())
}

/// A user-defined command; the arguments arrive expanded by the frontend.
#[tauri::command(async)]
pub fn run_custom_command(program: String, args: Vec<String>, cwd: String) -> Result<(), String> {
    shell_verbs::run_custom(&program, &args, &cwd).map_err(|e| format!("{program}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::resolve_custom;

    #[test]
    fn a_program_every_machine_has_resolves_to_a_real_file() {
        let name = if cfg!(windows) { "cmd" } else { "sh" };
        let found = resolve_custom(name).expect("the system shell is on PATH");
        assert!(std::path::Path::new(&found).is_file(), "{found}");
        if cfg!(windows) {
            assert!(found.to_ascii_lowercase().ends_with("cmd.exe"), "{found}");
            assert!(resolve_custom("cmd.exe").is_some());
        }
        // the path it resolved to is itself a valid program
        assert_eq!(resolve_custom(&found).as_deref(), Some(found.as_str()));
    }

    #[test]
    fn unknown_names_and_missing_paths_resolve_to_nothing() {
        assert_eq!(resolve_custom(""), None);
        assert_eq!(resolve_custom("   "), None);
        assert_eq!(resolve_custom("trove-no-such-program-4f1c"), None);
        let missing = std::env::temp_dir()
            .join("trove-no-such-dir-4f1c")
            .join("x.exe");
        assert_eq!(resolve_custom(&missing.to_string_lossy()), None);
    }
}

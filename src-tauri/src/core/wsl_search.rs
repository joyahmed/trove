//! Search inside a WSL distro the fast way: `find` running in the distro, its lines mapped to
//! `\\wsl.localhost\<distro>\…` paths. Walking the share from Windows goes through 9P at
//! hundreds of milliseconds per folder; `find` inside the VM reads ext4 directly.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::core::fs::{entry_from, FileEntry};
use crate::core::wsl;

/// Matches per sink call.
const BATCH: usize = 50;
/// A hit waits at most this long before it is shown, however few have arrived.
const FLUSH: std::time::Duration = std::time::Duration::from_millis(250);

/// `'` inside a single-quoted shell word: close, escaped quote, reopen.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The `wsl.exe -d <distro> -- sh -c "<script>"` that lists the paths whose name contains
/// `text` (case-insensitive) under `linux_roots` (`/` when empty), skipping `.git` and
/// `node_modules` trees. Errors from unreadable folders are dropped. No `| head` — a pipe
/// through `head` is block-buffered, so the hits would only arrive when `find` ends; the
/// reader stops after `max` lines and kills the child instead.
pub fn find_command(distro: &str, linux_roots: &[String], text: &str) -> (String, Vec<String>) {
    let roots: Vec<String> = if linux_roots.is_empty() {
        vec!["/".to_string()]
    } else {
        linux_roots.iter().map(|r| sh_quote(r)).collect()
    };
    let script = format!(
        "find {} -iname {} -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null",
        roots.join(" "),
        sh_quote(&format!("*{text}*")),
    );
    (
        "wsl.exe".to_string(),
        vec![
            "-d".to_string(),
            distro.to_string(),
            "--".to_string(),
            "sh".to_string(),
            "-c".to_string(),
            script,
        ],
    )
}

/// `/home/alex/notes.txt` in `Ubuntu` → `\\wsl.localhost\Ubuntu\home\alex\notes.txt`.
pub fn unc_of(distro: &str, linux_path: &str) -> String {
    let rest = linux_path.trim_start_matches('/').replace('/', "\\");
    if rest.is_empty() {
        wsl::root_of(distro)
    } else {
        format!("{}{}", wsl::root_of(distro), rest)
    }
}

#[cfg_attr(not(windows), allow(unused_variables))]
fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
}

/// Run `find` in the distro and hand the hits to `sink` in batches; `scanned` counts the
/// lines read. `cancel` is checked per line and kills the child. Returns the line count, or
/// the child's stderr when it failed without printing anything.
pub fn run(
    distro: &str,
    linux_roots: &[String],
    text: &str,
    max: usize,
    cancel: &AtomicBool,
    sink: &mut dyn FnMut(Vec<FileEntry>, u64),
) -> Result<u64, String> {
    let (program, args) = find_command(distro, linux_roots, text);
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("wsl.exe: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "wsl.exe gave no stdout".to_string())?;

    let mut types: HashMap<Option<String>, String> = HashMap::new();
    let mut batch: Vec<FileEntry> = Vec::with_capacity(BATCH);
    let mut scanned = 0u64;
    let mut last_flush = std::time::Instant::now();
    for line in BufReader::new(stdout).lines() {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            break;
        }
        let Ok(line) = line else { break };
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        scanned += 1;
        if scanned > max as u64 {
            let _ = child.kill();
            break;
        }
        let path = PathBuf::from(unc_of(distro, line));
        // A path whose metadata fails over the share is still listed, as `read_dir` does.
        let meta = std::fs::symlink_metadata(&path).ok();
        batch.push(entry_from(path, meta, &mut types));
        if batch.len() >= BATCH || last_flush.elapsed() >= FLUSH {
            sink(std::mem::take(&mut batch), scanned);
            last_flush = std::time::Instant::now();
        }
    }
    if !batch.is_empty() {
        sink(batch, scanned);
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("wsl.exe: {e}"))?;
    if scanned == 0 && !output.status.success() && !cancel.load(Ordering::Relaxed) {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("find in {distro} failed ({})", output.status)
        } else {
            stderr
        });
    }
    Ok(scanned)
}

/// The distros running right now (`wsl.exe -l --running -q`); empty when wsl is absent or
/// nothing runs. Never starts a distro.
pub fn running_distros() -> Vec<String> {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-l", "--running", "-q"]);
    no_window(&mut cmd);
    match cmd.output() {
        Ok(out) if out.status.success() => wsl::parse_wsl_list(&out.stdout),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_command_quotes_the_text_and_the_roots() {
        let (program, args) = find_command("Ubuntu", &["/home/alex".to_string()], "it's a");
        assert_eq!(program, "wsl.exe");
        assert_eq!(&args[..5], ["-d", "Ubuntu", "--", "sh", "-c"]);
        assert_eq!(
            args[5],
            "find '/home/alex' -iname '*it'\\''s a*' -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null"
        );
    }

    #[test]
    fn find_command_takes_several_roots_and_defaults_to_the_root() {
        let (_, args) = find_command("Ubuntu", &["/srv".to_string(), "/opt x".to_string()], "foo");
        assert!(args[5].starts_with("find '/srv' '/opt x' -iname '*foo*'"));
        let (_, args) = find_command("Ubuntu", &[], "foo");
        assert!(args[5].starts_with("find / -iname '*foo*'"));
        assert!(args[5].ends_with("2>/dev/null"));
    }

    #[test]
    fn unc_of_maps_a_linux_path_onto_the_share() {
        assert_eq!(
            unc_of("Ubuntu", "/home/alex/notes.txt"),
            r"\\wsl.localhost\Ubuntu\home\alex\notes.txt"
        );
        assert_eq!(unc_of("Ubuntu", "/"), r"\\wsl.localhost\Ubuntu\");
        assert_eq!(unc_of("Ubuntu", ""), r"\\wsl.localhost\Ubuntu\");
    }
}

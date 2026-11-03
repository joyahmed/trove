//! WSL distro snapshots for the name table (plan 21C.4).
//!
//! A running distro is listed once with `find -printf` run inside it (ext4 read directly, not
//! the slow 9P share). Fields and records are separated by NUL, the one byte a Linux file name
//! can never hold, so spaces, tabs, unicode and even newlines in names parse safely.
//!
//! Never starts a distro: `snapshot` refuses one that is not in the running list.

use std::process::Command;
use std::time::{Duration, Instant};

/// Folders listed when the caller gives none (Joy's Q1c, whole-distro depth, is unanswered).
pub const DEFAULT_ROOTS: [&str; 2] = ["/home", "/root"];
/// A snapshot older than this is refreshed when the palette opens (plan 21C.4b).
pub const STALE_AFTER: Duration = Duration::from_secs(10 * 60);

/// What kind of thing a listed path is (`find`'s `%y`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Link,
    Other,
}

/// One listed path inside the distro.
#[derive(Debug, Clone, PartialEq)]
pub struct WslEntry {
    /// Linux path, e.g. `/home/alex/a b.txt`.
    pub path: String,
    pub kind: Kind,
    pub size: u64,
    /// Seconds since the Unix epoch (`%T@`, fraction dropped).
    pub mtime: i64,
}

/// The entries of one distro and when they were taken.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub distro: String,
    pub taken_at: Instant,
    pub entries: Vec<WslEntry>,
}

impl Snapshot {
    /// True once the snapshot is older than [`STALE_AFTER`] at `now` (the clock is injected).
    pub fn is_stale(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.taken_at) > STALE_AFTER
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SnapshotError {
    /// The distro is stopped; listing it would boot it.
    NotRunning,
    /// `wsl.exe` could not run, or `find` printed nothing and failed.
    Failed(String),
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `wsl.exe -d <distro> -- sh -c "find <roots> -printf ..."`. Record = `type NUL size NUL
/// mtime NUL path NUL`. Roots default to [`DEFAULT_ROOTS`] when empty. Errors are dropped.
pub fn snapshot_command(distro: &str, roots: &[String]) -> (String, Vec<String>) {
    let roots: Vec<String> = if roots.is_empty() {
        DEFAULT_ROOTS.iter().map(|r| sh_quote(r)).collect()
    } else {
        roots.iter().map(|r| sh_quote(r)).collect()
    };
    let script = format!(
        "find {} -printf '%y\\0%s\\0%T@\\0%p\\0' 2>/dev/null",
        roots.join(" ")
    );
    (
        "wsl.exe".to_string(),
        vec![
            "-d".into(),
            distro.into(),
            "--".into(),
            "sh".into(),
            "-c".into(),
            script,
        ],
    )
}

/// Parse the bytes printed by [`snapshot_command`]. A cut-off record and records with a bad
/// number are skipped, never panicked on. Non-UTF-8 names are kept lossily.
pub fn parse_find_output(bytes: &[u8]) -> Vec<WslEntry> {
    let mut parts = bytes.split(|b| *b == 0);
    let mut out = Vec::new();
    while let (Some(y), Some(s), Some(t), Some(p)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    {
        if p.is_empty() {
            continue;
        }
        let kind = match y {
            b"f" => Kind::File,
            b"d" => Kind::Dir,
            b"l" => Kind::Link,
            _ => Kind::Other,
        };
        let size = std::str::from_utf8(s).ok().and_then(|v| v.parse().ok());
        let mtime = std::str::from_utf8(t)
            .ok()
            .and_then(|v| v.split('.').next())
            .and_then(|v| v.parse().ok());
        if let (Some(size), Some(mtime)) = (size, mtime) {
            out.push(WslEntry {
                path: String::from_utf8_lossy(p).into_owned(),
                kind,
                size,
                mtime,
            });
        }
    }
    out
}

/// Distros running now. Never starts one.
pub fn running_distros() -> Vec<String> {
    crate::core::wsl_search::running_distros()
}

/// True when `distro` is in `running` (case-insensitive, as wsl.exe names are).
pub fn is_running(distro: &str, running: &[String]) -> bool {
    running.iter().any(|r| r.eq_ignore_ascii_case(distro))
}

/// Should the palette refresh `distro` now? Only a running distro, and only when there is no
/// snapshot or it is stale.
pub fn needs_refresh(
    distro: &str,
    running: &[String],
    current: Option<&Snapshot>,
    now: Instant,
) -> bool {
    is_running(distro, running) && current.is_none_or(|s| s.is_stale(now))
}

#[cfg_attr(not(windows), allow(unused_variables))]
fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
}

/// List `roots` of a running distro. `running` is the caller's fresh [`running_distros`]; a
/// distro not in it returns `NotRunning` without touching `wsl.exe`.
pub fn snapshot(
    distro: &str,
    roots: &[String],
    running: &[String],
) -> Result<Snapshot, SnapshotError> {
    if !is_running(distro, running) {
        return Err(SnapshotError::NotRunning);
    }
    let (program, args) = snapshot_command(distro, roots);
    let mut cmd = Command::new(program);
    cmd.args(args);
    no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| SnapshotError::Failed(e.to_string()))?;
    let entries = parse_find_output(&out.stdout);
    if entries.is_empty() && !out.status.success() {
        return Err(SnapshotError::Failed(
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ));
    }
    Ok(Snapshot {
        distro: distro.to_string(),
        taken_at: Instant::now(),
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(y: &str, s: &str, t: &str, p: &str) -> Vec<u8> {
        format!("{y}\0{s}\0{t}\0{p}\0").into_bytes()
    }

    #[test]
    fn parses_odd_names() {
        let mut b = rec("d", "4096", "1760000000.1234567890", "/home/alex");
        b.extend(rec("f", "12", "1760000001.5", "/home/alex/a b\tc.txt"));
        b.extend(rec(
            "f",
            "0",
            "1.0",
            "/home/alex/caf\u{e9} \u{65e5}\u{672c}.md",
        ));
        b.extend(rec("f", "3", "2.0", "/home/alex/line\nbreak"));
        b.extend(rec("l", "9", "3.0", "/home/alex/link"));
        let e = parse_find_output(&b);
        assert_eq!(e.len(), 5);
        assert_eq!(
            e[0],
            WslEntry {
                path: "/home/alex".into(),
                kind: Kind::Dir,
                size: 4096,
                mtime: 1760000000
            }
        );
        assert_eq!(e[1].path, "/home/alex/a b\tc.txt");
        assert_eq!(e[2].path, "/home/alex/caf\u{e9} \u{65e5}\u{672c}.md");
        assert_eq!(e[3].path, "/home/alex/line\nbreak");
        assert_eq!(e[4].kind, Kind::Link);
    }

    #[test]
    fn cut_off_and_bad_records_are_skipped() {
        let mut b = rec("f", "1", "1.0", "/a");
        b.extend(rec("f", "x", "1.0", "/bad"));
        b.extend(b"f\x002\x002.0\x00/cut");
        let e = parse_find_output(&b);
        let paths: Vec<&str> = e.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(paths, ["/a", "/cut"]);
        assert!(parse_find_output(b"").is_empty());
        assert!(parse_find_output(b"f\x001").is_empty());
    }

    #[test]
    fn command_defaults_to_home_and_root_and_quotes() {
        let (p, a) = snapshot_command("Ubuntu", &[]);
        assert_eq!(p, "wsl.exe");
        assert_eq!(&a[..5], ["-d", "Ubuntu", "--", "sh", "-c"]);
        assert!(a[5].starts_with("find '/home' '/root' -printf '%y\\0%s\\0%T@\\0%p\\0'"));
        let (_, a) = snapshot_command("U", &["/o'p x".to_string()]);
        assert!(a[5].starts_with("find '/o'\\''p x' -printf"));
    }

    #[test]
    fn snapshot_is_stale_after_ten_minutes() {
        let t0 = Instant::now();
        let s = Snapshot {
            distro: "U".into(),
            taken_at: t0,
            entries: vec![],
        };
        assert!(!s.is_stale(t0));
        assert!(!s.is_stale(t0 + Duration::from_secs(600)));
        assert!(s.is_stale(t0 + Duration::from_secs(601)));
    }

    #[test]
    fn stopped_distro_is_never_snapshotted() {
        let running = vec!["Debian".to_string()];
        assert_eq!(
            snapshot("Ubuntu", &[], &running).unwrap_err(),
            SnapshotError::NotRunning
        );
        assert_eq!(
            snapshot("Ubuntu", &[], &[]).unwrap_err(),
            SnapshotError::NotRunning
        );
        let t0 = Instant::now();
        assert!(!needs_refresh("Ubuntu", &running, None, t0));
        assert!(needs_refresh("debian", &running, None, t0));
        let s = Snapshot {
            distro: "Debian".into(),
            taken_at: t0,
            entries: vec![],
        };
        assert!(!needs_refresh(
            "Debian",
            &running,
            Some(&s),
            t0 + Duration::from_secs(60)
        ));
        assert!(needs_refresh(
            "Debian",
            &running,
            Some(&s),
            t0 + Duration::from_secs(700)
        ));
    }
}

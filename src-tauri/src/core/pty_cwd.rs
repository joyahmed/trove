//! The shell's own report of its folder, read out of the PTY output (plan 08 E1: a `cd` in the
//! terminal moves the listing). Two escape sequences carry it:
//!
//! - **OSC 7** — `ESC ] 7 ; file://host/path BEL` (or `ESC \`). fish, zsh with most frameworks,
//!   bash/zsh through VTE's `/etc/profile.d/vte.sh` (Ubuntu, Fedora), macOS Terminal's
//!   `/etc/bashrc_Apple_Terminal`, WezTerm's and kitty's shell integration
//!   (`kitty-shell-cwd://`, unescaped).
//! - **OSC 9;9** — `ESC ] 9 ; 9 ; "C:\path" ST`, the ConEmu / Windows Terminal form a PowerShell
//!   prompt snippet emits.
//!
//! The parse runs in the reader thread, on the raw bytes, before they are cut into UTF-8
//! strings: it sees every chunk boundary, it can ask the file system whether the folder exists,
//! and it knows the session's kind (a WSL path maps to `\\wsl.localhost\<distro>\…`). The bytes
//! themselves are passed on unchanged — the emulator ignores an OSC it does not know.
//!
//! ⛔ Nothing here makes a shell emit these. Trove never touches `PROMPT_COMMAND`, `precmd` or a
//! PowerShell `prompt`; a shell that does not report its folder simply never moves the listing.

use crate::core::pty::SessionKind;

/// An OSC longer than this is not a folder report (OSC 52 clipboard payloads can be megabytes);
/// it is dropped, never buffered whole.
const MAX_OSC: usize = 4096;

/// One folder report, still in the shell's own words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CwdReport {
    /// The text after `7;`: a `file://` (or `kitty-shell-cwd://`) URI.
    Osc7(String),
    /// The text after `9;9;`: a path, possibly in double quotes.
    Osc99(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    Esc,
    Osc,
    /// an ESC inside an OSC: `\` ends it, anything else abandons it
    OscEsc,
    /// an OSC past `MAX_OSC`, skipped to its terminator
    Skip,
    SkipEsc,
}

/// A byte-at-a-time OSC scanner that keeps its state between reads, so a sequence split across
/// any number of chunks is still found.
#[derive(Debug)]
pub struct OscScanner {
    state: State,
    buf: Vec<u8>,
}

impl Default for OscScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl OscScanner {
    pub fn new() -> Self {
        Self {
            state: State::Ground,
            buf: Vec::new(),
        }
    }

    /// Feed one read's bytes; returns the folder reports that ended inside it.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<CwdReport> {
        let mut out = Vec::new();
        for &b in bytes {
            self.step(b, &mut out);
        }
        out
    }

    fn step(&mut self, b: u8, out: &mut Vec<CwdReport>) {
        const ESC: u8 = 0x1b;
        const BEL: u8 = 0x07;
        // CAN and SUB cancel any sequence in progress (ECMA-48)
        let cancel = b == 0x18 || b == 0x1a;
        self.state = match self.state {
            State::Ground => {
                if b == ESC {
                    State::Esc
                } else {
                    State::Ground
                }
            }
            State::Esc => match b {
                b']' => {
                    self.buf.clear();
                    State::Osc
                }
                ESC => State::Esc,
                _ => State::Ground,
            },
            State::Osc => match b {
                BEL => {
                    self.finish(out);
                    State::Ground
                }
                ESC => State::OscEsc,
                _ if cancel => State::Ground,
                _ if self.buf.len() >= MAX_OSC => {
                    self.buf.clear();
                    State::Skip
                }
                _ => {
                    self.buf.push(b);
                    State::Osc
                }
            },
            State::OscEsc => match b {
                b'\\' => {
                    self.finish(out);
                    State::Ground
                }
                // an unterminated OSC followed by a new sequence: start that one
                b']' => {
                    self.buf.clear();
                    State::Osc
                }
                ESC => State::Esc,
                _ => State::Ground,
            },
            State::Skip => match b {
                BEL => State::Ground,
                ESC => State::SkipEsc,
                _ if cancel => State::Ground,
                _ => State::Skip,
            },
            State::SkipEsc => match b {
                b'\\' => State::Ground,
                b']' => {
                    self.buf.clear();
                    State::Osc
                }
                ESC => State::Esc,
                _ => State::Ground,
            },
        };
    }

    fn finish(&mut self, out: &mut Vec<CwdReport>) {
        let payload = std::mem::take(&mut self.buf);
        let Ok(text) = String::from_utf8(payload) else {
            return;
        };
        if let Some(rest) = text.strip_prefix("7;") {
            out.push(CwdReport::Osc7(rest.to_string()));
        } else if let Some(rest) = text.strip_prefix("9;9;") {
            out.push(CwdReport::Osc99(rest.to_string()));
        }
    }
}

/// `%XX` decoded; `None` when an escape is malformed or the result is not UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Whether `host` (from the URI) names this machine. Empty and `localhost` always do; otherwise
/// the names are compared case-insensitively, and by their first label too, since a Mac's
/// `$HOSTNAME` says `name.local` where `gethostname` may not.
pub fn is_local_host(host: &str, local: &str) -> bool {
    let host = host.to_ascii_lowercase();
    if host.is_empty() || host == "localhost" {
        return true;
    }
    let local = local.to_ascii_lowercase();
    if local.is_empty() {
        return false;
    }
    let first = |s: &str| s.split('.').next().unwrap_or_default().to_string();
    host == local || first(&host) == first(&local)
}

/// `C:` / `C:\…` / `C:/…` at the start of `p`.
fn is_drive_path(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 2
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b.len() == 2 || b[2] == b'/' || b[2] == b'\\')
}

/// A path the way the listing writes it: no trailing separator except on a root.
fn trim_trailing(mut p: String, sep: char) -> String {
    while p.len() > 1 && p.ends_with(sep) && !(p.len() == 3 && is_drive_path(&p)) {
        p.pop();
    }
    p
}

/// A folder as the shell saw it (`/…`, or `C:\…`) turned into the form the listing uses for
/// this kind of session. `None` when this session cannot mean that path.
fn to_listing_path(path: &str, kind: &SessionKind) -> Option<String> {
    match kind {
        SessionKind::Plain => None,
        SessionKind::Unix => path
            .starts_with('/')
            .then(|| trim_trailing(path.to_string(), '/')),
        SessionKind::Windows => {
            // `/C:/x` from an OSC 7 URI, or `C:\x` / `C:/x` from OSC 9;9
            let p = path
                .strip_prefix('/')
                .filter(|p| is_drive_path(p))
                .unwrap_or(path);
            if !is_drive_path(p) {
                return None;
            }
            let mut win = p.replace('/', "\\");
            if win.len() == 2 {
                win.push('\\');
            }
            let mut chars: Vec<char> = win.chars().collect();
            chars[0] = chars[0].to_ascii_uppercase();
            Some(trim_trailing(chars.into_iter().collect(), '\\'))
        }
        SessionKind::Wsl { distro } => {
            if !path.starts_with('/') {
                return None;
            }
            let inner = trim_trailing(path.to_string(), '/');
            let tail = if inner == "/" {
                String::new()
            } else {
                inner.replace('/', "\\")
            };
            Some(format!("\\\\wsl.localhost\\{distro}{tail}"))
        }
    }
}

/// The folder a report names, in listing form — or `None` for a foreign host, a malformed URI,
/// or a path this session's kind cannot mean. Existence is the caller's check (`resolve`).
pub fn report_path(report: &CwdReport, kind: &SessionKind, local_host: &str) -> Option<String> {
    match report {
        CwdReport::Osc7(uri) => {
            let lower = uri.to_ascii_lowercase();
            let (rest, encoded) = if lower.starts_with("file://") {
                (&uri["file://".len()..], true)
            } else if lower.starts_with("kitty-shell-cwd://") {
                (&uri["kitty-shell-cwd://".len()..], false)
            } else {
                return None;
            };
            let slash = rest.find('/')?;
            let (host, raw_path) = rest.split_at(slash);
            let host = percent_decode(host)?;
            if !is_local_host(&host, local_host) {
                return None;
            }
            let path = if encoded {
                percent_decode(raw_path)?
            } else {
                raw_path.to_string()
            };
            to_listing_path(&path, kind)
        }
        CwdReport::Osc99(raw) => {
            let p = raw.trim();
            let p = p
                .strip_prefix('"')
                .and_then(|p| p.strip_suffix('"'))
                .unwrap_or(p);
            if p.is_empty() {
                return None;
            }
            to_listing_path(p, kind)
        }
    }
}

/// A report turned into a folder that exists on this machine, or `None` (the listing stays put).
pub fn resolve(report: &CwdReport, kind: &SessionKind, local_host: &str) -> Option<String> {
    report_path(report, kind, local_host).filter(|p| std::path::Path::new(p).is_dir())
}

/// This machine's name, for the OSC 7 host check.
pub fn local_hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: `buf` is valid for `buf.len()` bytes; gethostname NUL-terminates within it or
        // truncates, and we read only up to the first NUL.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
        if rc == 0 {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            return String::from_utf8_lossy(&buf[..end]).into_owned();
        }
        std::env::var("HOSTNAME").unwrap_or_default()
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn osc7(s: &str) -> CwdReport {
        CwdReport::Osc7(s.into())
    }

    #[test]
    fn finds_osc7_with_either_terminator() {
        let mut s = OscScanner::new();
        let got = s.feed(b"a\x1b]7;file://h/tmp\x07b\x1b]7;file://h/var\x1b\\c");
        assert_eq!(got, vec![osc7("file://h/tmp"), osc7("file://h/var")]);
    }

    #[test]
    fn finds_osc_9_9_and_ignores_other_oscs() {
        let mut s = OscScanner::new();
        let got = s
            .feed(b"\x1b]0;title\x07\x1b]9;9;\"C:\\x\"\x1b\\\x1b]9;4;1;50\x07\x1b]8;;http://a\x07");
        assert_eq!(got, vec![CwdReport::Osc99("\"C:\\x\"".into())]);
    }

    #[test]
    fn a_sequence_split_across_every_byte_is_still_found() {
        let whole = b"pre\x1b]7;file://host/home/j%20o\x1b\\post";
        let mut s = OscScanner::new();
        let mut got = Vec::new();
        for b in whole.iter() {
            got.extend(s.feed(std::slice::from_ref(b)));
        }
        assert_eq!(got, vec![osc7("file://host/home/j%20o")]);
        // and at each two-chunk cut
        for cut in 0..whole.len() {
            let mut s = OscScanner::new();
            let mut got = s.feed(&whole[..cut]);
            got.extend(s.feed(&whole[cut..]));
            assert_eq!(got, vec![osc7("file://host/home/j%20o")], "cut at {cut}");
        }
    }

    #[test]
    fn garbage_and_cancelled_and_overlong_sequences_yield_nothing() {
        let mut s = OscScanner::new();
        assert!(s
            .feed(b"\x1b[31mred\x1b[0m \x1b]7;file://h/a\x18 \x1bX \xff\xfe")
            .is_empty());
        // an unterminated OSC then ESC + non-backslash is abandoned, not reported
        assert!(s.feed(b"\x1b]7;file://h/b\x1bQ").is_empty());
        // non-UTF-8 payload
        assert!(s.feed(b"\x1b]7;file://h/\xff\x07").is_empty());
        // an OSC 52 far past the cap is skipped whole, and the scanner recovers after it
        let mut big = b"\x1b]52;c;".to_vec();
        big.extend(std::iter::repeat_n(b'A', MAX_OSC * 3));
        big.extend(b"\x07\x1b]7;file://h/ok\x07");
        assert_eq!(s.feed(&big), vec![osc7("file://h/ok")]);
    }

    #[test]
    fn a_new_osc_after_an_unterminated_one_is_read() {
        let mut s = OscScanner::new();
        assert_eq!(
            s.feed(b"\x1b]2;half\x1b]7;file:///x\x07"),
            vec![osc7("file:///x")]
        );
    }

    #[test]
    fn unix_paths_decode_and_check_the_host() {
        let k = SessionKind::Unix;
        let p = |u: &str| report_path(&osc7(u), &k, "box");
        assert_eq!(
            p("file://box/home/j%20o/%C3%A9t%C3%A9"),
            Some("/home/j o/été".into())
        );
        assert_eq!(p("file:///tmp/"), Some("/tmp".into()));
        assert_eq!(p("file://localhost/"), Some("/".into()));
        assert_eq!(p("FILE://BOX.local/srv"), Some("/srv".into()));
        assert_eq!(p("kitty-shell-cwd://box/a b"), Some("/a b".into()));
        // a shell on another machine (ssh) reports its own folder: not ours
        assert_eq!(p("file://other/home/x"), None);
        // malformed
        assert_eq!(p("file://box"), None);
        assert_eq!(p("file://box/%zz"), None);
        assert_eq!(p("http://box/x"), None);
        assert_eq!(p("file://box/%FF"), None);
    }

    #[test]
    fn windows_drive_paths_become_backslashed() {
        let k = SessionKind::Windows;
        let p = |r: CwdReport| report_path(&r, &k, "PC");
        assert_eq!(
            p(osc7("file://pc/C:/Users/alex%20A/")),
            Some("C:\\Users\\alex A".into())
        );
        assert_eq!(p(osc7("file:///c:/")), Some("C:\\".into()));
        assert_eq!(p(osc7("file:///D:")), Some("D:\\".into()));
        assert_eq!(
            p(CwdReport::Osc99("\"C:\\work\\\"".into())),
            Some("C:\\work".into())
        );
        assert_eq!(p(CwdReport::Osc99("d:/x".into())), Some("D:\\x".into()));
        // a Unix path means nothing in PowerShell
        assert_eq!(p(osc7("file:///home/x")), None);
        assert_eq!(p(CwdReport::Osc99("\"\"".into())), None);
        // and a drive path means nothing in a Unix shell
        assert_eq!(
            report_path(&CwdReport::Osc99("C:\\x".into()), &SessionKind::Unix, "h"),
            None
        );
    }

    #[test]
    fn a_wsl_path_maps_into_its_distro() {
        let k = SessionKind::Wsl {
            distro: "Ubuntu".into(),
        };
        let p = |u: &str| report_path(&osc7(u), &k, "PC");
        assert_eq!(
            p("file://pc/home/alex/"),
            Some("\\\\wsl.localhost\\Ubuntu\\home\\alex".into())
        );
        assert_eq!(p("file://pc/"), Some("\\\\wsl.localhost\\Ubuntu".into()));
    }

    #[test]
    fn a_plain_session_never_reports() {
        assert_eq!(
            report_path(&osc7("file:///tmp"), &SessionKind::Plain, ""),
            None
        );
    }

    #[test]
    fn resolve_drops_folders_that_do_not_exist() {
        let dir = std::env::temp_dir();
        let real = dir.to_string_lossy().into_owned();
        #[cfg(unix)]
        {
            let uri = format!("file://{real}");
            assert!(resolve(&osc7(&uri), &SessionKind::Unix, "h").is_some());
            assert_eq!(
                resolve(&osc7("file:///no/such/trove/dir"), &SessionKind::Unix, "h"),
                None
            );
        }
        #[cfg(windows)]
        {
            let r = CwdReport::Osc99(real.clone());
            assert!(resolve(&r, &SessionKind::Windows, "h").is_some());
            let r = CwdReport::Osc99("C:\\no\\such\\trove\\dir".into());
            assert_eq!(resolve(&r, &SessionKind::Windows, "h"), None);
        }
    }

    #[test]
    fn host_matching() {
        assert!(is_local_host("", "x"));
        assert!(is_local_host("LocalHost", "x"));
        assert!(is_local_host("Joys-Mac.local", "joys-mac"));
        assert!(!is_local_host("other", "box"));
        assert!(!is_local_host("box", ""));
        assert!(!local_hostname().is_empty() || cfg!(not(unix)));
    }
}

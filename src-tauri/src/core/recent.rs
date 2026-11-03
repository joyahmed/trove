//! Windows' recent files: the `.lnk` shortcuts the shell drops into
//! `%APPDATA%\Microsoft\Windows\Recent`, newest first, resolved to the files they point at.
//! The shortcut format is [MS-SHLLINK]; only the LinkInfo's local base path is read — enough
//! for every file on a local volume, and no COM.
//!
//! Ubuntu (and any freedesktop desktop) keeps the same list in `recently-used.xbel`; the XML
//! reading (`parse_xbel`) is plain string work with no OS call, so it is built and tested on
//! every OS and only the file's location is Linux-only.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::core::fs::{self, FileEntry};

/// Explorer's Recent shows the last twenty-odd files; more is noise on a Home page.
pub const MAX_RECENT_FILES: usize = 20;

const HEADER_SIZE: usize = 0x4C;
const HAS_LINK_TARGET_ID_LIST: u32 = 0x1;
const HAS_LINK_INFO: u32 = 0x2;
const VOLUME_ID_AND_LOCAL_BASE_PATH: u32 = 0x1;
// The StringData sections that may follow LinkInfo, in file order ([MS-SHLLINK] 2.4).
const HAS_NAME: u32 = 0x4;
const HAS_RELATIVE_PATH: u32 = 0x8;
const HAS_WORKING_DIR: u32 = 0x10;
const HAS_ARGUMENTS: u32 = 0x20;
const IS_UNICODE: u32 = 0x80;
/// A LinkInfo header this long carries the Unicode offsets after the ANSI ones.
const LINK_INFO_HEADER_WITH_UNICODE: usize = 0x24;

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at + 4)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// A NUL-terminated ANSI string at `at`; bytes are read as Latin-1, which is exact for ASCII
/// paths and the Unicode field wins whenever the shortcut has one.
fn ansi_at(b: &[u8], at: usize) -> Option<String> {
    if at == 0 {
        return None;
    }
    let s = b.get(at..)?;
    let end = s.iter().position(|&c| c == 0)?;
    Some(s[..end].iter().map(|&c| c as char).collect())
}

/// A NUL-terminated UTF-16LE string at `at`.
fn utf16_at(b: &[u8], at: usize) -> Option<String> {
    if at == 0 {
        return None;
    }
    let s = b.get(at..)?;
    let units: Vec<u16> = s
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .take_while(|&u| u != 0)
        .collect();
    String::from_utf16(&units).ok()
}

/// The local path a `.lnk` points at, or `None` for a shortcut with no local base path (a
/// network target, a shell item with no file behind it, a truncated file).
pub fn parse_lnk(bytes: &[u8]) -> Option<String> {
    parse_lnk_full(bytes).map(|l| l.target)
}

/// What a shortcut starts: its local target and the arguments it passes.
#[derive(Debug, Clone, PartialEq)]
pub struct Lnk {
    pub target: String,
    /// `COMMAND_LINE_ARGUMENTS`: `Some("")` when the shortcut has none, `None` when it says it
    /// has some but they could not be read (truncated file) — callers treat that as "has args".
    pub args: Option<String>,
}

/// `parse_lnk` plus the shortcut's own arguments. ⚠️ A Squirrel app's shortcut targets
/// `Update.exe` with `--processStart X.exe`; the target alone would start the updater.
pub fn parse_lnk_full(bytes: &[u8]) -> Option<Lnk> {
    if u32_at(bytes, 0)? as usize != HEADER_SIZE {
        return None;
    }
    let flags = u32_at(bytes, 0x14)?;
    let mut pos = HEADER_SIZE;
    if flags & HAS_LINK_TARGET_ID_LIST != 0 {
        pos += 2 + u16_at(bytes, pos)? as usize;
    }
    if flags & HAS_LINK_INFO == 0 {
        return None;
    }
    let info = bytes.get(pos..)?;
    let info = info.get(..u32_at(info, 0)? as usize)?;
    let header_size = u32_at(info, 4)? as usize;
    if u32_at(info, 8)? & VOLUME_ID_AND_LOCAL_BASE_PATH == 0 {
        return None;
    }
    let unicode = header_size >= LINK_INFO_HEADER_WITH_UNICODE;
    let base = unicode
        .then(|| utf16_at(info, u32_at(info, 28)? as usize))
        .flatten()
        .or_else(|| ansi_at(info, u32_at(info, 16)? as usize))?;
    let suffix = unicode
        .then(|| utf16_at(info, u32_at(info, 32)? as usize))
        .flatten()
        .or_else(|| ansi_at(info, u32_at(info, 24)? as usize))
        .unwrap_or_default();
    if base.is_empty() {
        return None;
    }
    let args = string_data_args(bytes, pos + info.len(), flags);
    Some(Lnk {
        target: base + &suffix,
        args,
    })
}

/// Walks the StringData sections from `at` to `COMMAND_LINE_ARGUMENTS`. `Some("")` when the
/// flag is not set; `None` when it is set but the bytes run out.
fn string_data_args(bytes: &[u8], mut at: usize, flags: u32) -> Option<String> {
    if flags & HAS_ARGUMENTS == 0 {
        return Some(String::new());
    }
    let unit = if flags & IS_UNICODE != 0 { 2 } else { 1 };
    for skip in [HAS_NAME, HAS_RELATIVE_PATH, HAS_WORKING_DIR] {
        if flags & skip != 0 {
            at += 2 + unit * u16_at(bytes, at)? as usize;
        }
    }
    let count = u16_at(bytes, at)? as usize;
    let raw = bytes.get(at + 2..at + 2 + unit * count)?;
    Some(if unit == 2 {
        let units: Vec<u16> = raw
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        raw.iter().map(|&c| c as char).collect()
    })
}

/// `%APPDATA%\Microsoft\Windows\Recent`, where the shell keeps the shortcuts.
pub fn recent_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join(r"Microsoft\Windows\Recent"))
}

/// The files the person opened recently, newest shortcut first: existing files only (a moved
/// or deleted target is skipped, so is a folder — Explorer's Recent lists files), at most
/// `MAX_RECENT_FILES`. A missing Recent folder is an empty list, not an error.
pub fn recent_files(recent_dir: &Path) -> Vec<FileEntry> {
    let Ok(entries) = std::fs::read_dir(recent_dir) else {
        return Vec::new();
    };
    let mut links: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("lnk"))
        })
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, e.path()))
        })
        .collect();
    links.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));

    let mut types: HashMap<Option<String>, String> = HashMap::new();
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for (_, link) in links {
        if out.len() >= MAX_RECENT_FILES {
            break;
        }
        let Some(target) = std::fs::read(&link).ok().and_then(|b| parse_lnk(&b)) else {
            continue;
        };
        let key = target.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        let path = PathBuf::from(&target);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            continue;
        }
        seen.push(key);
        out.push(fs::entry_from(path, Some(meta), &mut types));
    }
    out
}

/// One `<bookmark>` of `recently-used.xbel`: the local path it names and the newest of its
/// `visited` / `modified` / `added` stamps, in microseconds since the epoch.
#[derive(Debug, Clone, PartialEq)]
pub struct XbelEntry {
    pub path: String,
    pub stamp_us: i64,
}

/// `$XDG_DATA_HOME/recently-used.xbel`, else `~/.local/share/recently-used.xbel`, where GTK
/// (and so Ubuntu's file chooser and Files) records the files the person opened.
pub fn xbel_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join("recently-used.xbel"))
}

/// `%41` -> `A`. Bytes are decoded first and read as UTF-8 after, so a multi-byte name survives;
/// `None` when the result is not UTF-8 (such a path cannot be shown in a `String` anyway).
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The five XML entities and numeric references in an attribute value.
fn xml_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';') else { break };
        let name = &rest[1..end];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => name
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The `name="value"` pairs of one start tag's body (after the tag name). Either quote works.
fn tag_attributes(tag: &str) -> Vec<(&str, String)> {
    let mut attrs = Vec::new();
    let mut rest = tag;
    while let Some(eq) = rest.find('=') {
        let before = rest[..eq].trim();
        let after = rest[eq + 1..].trim_start();
        let Some(quote) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            break;
        };
        let body = &after[1..];
        let Some(end) = body.find(quote) else { break };
        let name = before.rsplit(char::is_whitespace).next().unwrap_or(before);
        attrs.push((name, xml_unescape(&body[..end])));
        rest = &body[end + 1..];
    }
    attrs
}

/// `2025-03-04T05:06:07.123456Z` -> microseconds since the epoch. UTC only, which is all GTK
/// writes; anything else is `None`.
fn parse_iso_us(s: &str) -> Option<i64> {
    let s = s.trim().strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let (y, m, day): (i64, i64, i64) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.split(':');
    let (h, mi, sec): (i64, i64, i64) = (
        t.next()?.parse().ok()?,
        t.next()?.parse().ok()?,
        t.next()?.parse().ok()?,
    );
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return None;
    }
    let micros: i64 = if frac.is_empty() {
        0
    } else {
        let digits: String = frac.chars().take(6).collect();
        digits.parse::<i64>().ok()? * 10i64.pow(6 - digits.len() as u32)
    };
    // days from civil (Howard Hinnant)
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000_000 + sec * 1_000_000 + micros)
}

/// Every `file://` bookmark of a `recently-used.xbel` document, newest first. Pure text work:
/// no file or OS is touched, so existence is the caller's check. Remote hrefs (`smb://`,
/// `https://`), malformed ones and a path repeated by a second bookmark are dropped or merged.
pub fn parse_xbel(xml: &str) -> Vec<XbelEntry> {
    let mut found: Vec<XbelEntry> = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find("<bookmark") {
        rest = &rest[at + "<bookmark".len()..];
        // `<bookmark-other>` is not a bookmark; the name must end at whitespace
        if !rest.starts_with(char::is_whitespace) {
            continue;
        }
        let Some(end) = rest.find('>') else { break };
        let attrs = tag_attributes(&rest[..end]);
        let get = |k: &str| attrs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.as_str());
        let Some(uri) = get("href").and_then(|h| h.strip_prefix("file://")) else {
            continue;
        };
        // `file://localhost/x` and `file:///x` are the same place
        let encoded = uri.strip_prefix("localhost").unwrap_or(uri);
        if !encoded.starts_with('/') {
            continue;
        }
        let Some(path) = percent_decode(encoded) else {
            continue;
        };
        let stamp_us = ["visited", "modified", "added"]
            .iter()
            .filter_map(|k| get(k).and_then(parse_iso_us))
            .max()
            .unwrap_or(0);
        // the same file can be listed twice; its newest stamp wins
        match found.iter_mut().find(|e| e.path == path) {
            Some(e) => e.stamp_us = e.stamp_us.max(stamp_us),
            None => found.push(XbelEntry { path, stamp_us }),
        }
    }
    found.sort_by_key(|e| std::cmp::Reverse(e.stamp_us));
    found
}

/// The files of `recently-used.xbel` that still exist, newest first, at most `MAX_RECENT_FILES`:
/// the Linux twin of `recent_files`, same shape. A missing or unreadable file is an empty list.
pub fn recent_files_xbel(xbel: &Path) -> Vec<FileEntry> {
    let Ok(xml) = std::fs::read_to_string(xbel) else {
        return Vec::new();
    };
    let mut types: HashMap<Option<String>, String> = HashMap::new();
    let mut out = Vec::new();
    for entry in parse_xbel(&xml) {
        if out.len() >= MAX_RECENT_FILES {
            break;
        }
        let path = PathBuf::from(&entry.path);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            continue;
        }
        out.push(fs::entry_from(path, Some(meta), &mut types));
    }
    out
}

/// Test fixture shared with `core::spotlight`: a minimal [MS-SHLLINK] file.
#[cfg(test)]
pub(crate) mod lnk_fixture {
    use super::*;

    /// A minimal [MS-SHLLINK] file: header, an (empty) ID list, LinkInfo with a local base
    /// path in ANSI or in Unicode.
    pub(crate) fn build_lnk(path: &str, unicode: bool) -> Vec<u8> {
        build_lnk_with_args(path, unicode, None)
    }

    /// `build_lnk` plus a working dir and, when given, `COMMAND_LINE_ARGUMENTS` StringData
    /// (UTF-16 when `unicode`), so the reader has to skip one section to reach the arguments.
    pub(crate) fn build_lnk_with_args(path: &str, unicode: bool, args: Option<&str>) -> Vec<u8> {
        let mut b = build_lnk_bare(path, unicode);
        let Some(args) = args else { return b };
        let mut flags = u32_at(&b, 0x14).unwrap() | HAS_WORKING_DIR | HAS_ARGUMENTS;
        if unicode {
            flags |= IS_UNICODE;
        }
        b[0x14..0x18].copy_from_slice(&flags.to_le_bytes());
        for s in [r"C:\work", args] {
            if unicode {
                let units: Vec<u16> = s.encode_utf16().collect();
                b.extend_from_slice(&(units.len() as u16).to_le_bytes());
                for u in units {
                    b.extend_from_slice(&u.to_le_bytes());
                }
            } else {
                b.extend_from_slice(&(s.len() as u16).to_le_bytes());
                b.extend_from_slice(s.as_bytes());
            }
        }
        b
    }

    fn build_lnk_bare(path: &str, unicode: bool) -> Vec<u8> {
        let mut b = vec![0u8; HEADER_SIZE];
        b[0..4].copy_from_slice(&(HEADER_SIZE as u32).to_le_bytes());
        let flags = HAS_LINK_TARGET_ID_LIST | HAS_LINK_INFO;
        b[0x14..0x18].copy_from_slice(&flags.to_le_bytes());
        // LinkTargetIDList: size 2 = just the terminator
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&0u16.to_le_bytes());
        // LinkInfo
        let header_size: u32 = if unicode { 0x24 } else { 0x1C };
        let mut info = vec![0u8; header_size as usize];
        info[4..8].copy_from_slice(&header_size.to_le_bytes());
        info[8..12].copy_from_slice(&VOLUME_ID_AND_LOCAL_BASE_PATH.to_le_bytes());
        // VolumeID: a 16-byte stub straight after the header
        let volume_at = info.len() as u32;
        info[12..16].copy_from_slice(&volume_at.to_le_bytes());
        info.extend_from_slice(&16u32.to_le_bytes());
        info.extend_from_slice(&[0u8; 12]);
        let base_at = info.len() as u32;
        if unicode {
            // ANSI slot holds a decoy so the test proves the Unicode field is the one read
            info[16..20].copy_from_slice(&base_at.to_le_bytes());
            info.extend_from_slice(b"C:\\decoy.txt\0");
            let ubase_at = info.len() as u32;
            info[28..32].copy_from_slice(&ubase_at.to_le_bytes());
            for u in path.encode_utf16() {
                info.extend_from_slice(&u.to_le_bytes());
            }
            info.extend_from_slice(&[0, 0]);
            let usuffix_at = info.len() as u32;
            info[32..36].copy_from_slice(&usuffix_at.to_le_bytes());
            info.extend_from_slice(&[0, 0]);
            let suffix_at = info.len() as u32;
            info[24..28].copy_from_slice(&suffix_at.to_le_bytes());
            info.push(0);
        } else {
            info[16..20].copy_from_slice(&base_at.to_le_bytes());
            info.extend_from_slice(path.as_bytes());
            info.push(0);
            let suffix_at = info.len() as u32;
            info[24..28].copy_from_slice(&suffix_at.to_le_bytes());
            info.push(0);
        }
        let size = info.len() as u32;
        info[0..4].copy_from_slice(&size.to_le_bytes());
        b.extend_from_slice(&info);
        b
    }
}

#[cfg(test)]
mod tests {
    use super::lnk_fixture::build_lnk;
    use super::*;

    #[test]
    fn reads_an_ansi_local_base_path() {
        let lnk = build_lnk(r"C:\Users\alex\notes.txt", false);
        assert_eq!(parse_lnk(&lnk).as_deref(), Some(r"C:\Users\alex\notes.txt"));
    }

    #[test]
    fn prefers_the_unicode_path_when_the_header_carries_one() {
        let lnk = build_lnk(r"D:\Projekte\Größe.md", true);
        assert_eq!(parse_lnk(&lnk).as_deref(), Some(r"D:\Projekte\Größe.md"));
    }

    #[test]
    fn reads_the_shortcuts_own_arguments_in_ansi_and_unicode() {
        use super::lnk_fixture::build_lnk_with_args;
        let plain = build_lnk_with_args(r"C:\a\app.exe", false, None);
        let full = parse_lnk_full(&plain).unwrap();
        assert_eq!(full.target, r"C:\a\app.exe");
        assert_eq!(full.args.as_deref(), Some(""));
        for unicode in [false, true] {
            let lnk = build_lnk_with_args(
                r"C:\a\Update.exe",
                unicode,
                Some("--processStart Discord.exe"),
            );
            let full = parse_lnk_full(&lnk).unwrap();
            assert_eq!(full.target, r"C:\a\Update.exe");
            assert_eq!(full.args.as_deref(), Some("--processStart Discord.exe"));
            // the old entry point still answers the target alone
            assert_eq!(parse_lnk(&lnk).as_deref(), Some(r"C:\a\Update.exe"));
            // a truncated argument section is "has args, unreadable", never "no args"
            let cut = &lnk[..lnk.len() - 3];
            assert_eq!(parse_lnk_full(cut).unwrap().args, None);
        }
    }

    #[test]
    fn a_shortcut_without_link_info_or_a_bad_header_is_none() {
        let mut no_info = build_lnk(r"C:\x.txt", false);
        no_info[0x14..0x18].copy_from_slice(&HAS_LINK_TARGET_ID_LIST.to_le_bytes());
        assert_eq!(parse_lnk(&no_info), None);
        assert_eq!(parse_lnk(b"not a shortcut"), None);
        assert_eq!(parse_lnk(&[]), None);
    }

    #[test]
    fn a_missing_recent_folder_is_an_empty_list() {
        let dir = std::env::temp_dir().join("trove-recent-does-not-exist");
        assert!(recent_files(&dir).is_empty());
    }

    #[test]
    fn resolves_existing_file_targets_only_newest_first() {
        let scratch = std::env::temp_dir().join(format!(
            "trove-recent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        struct Guard(PathBuf);
        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _guard = Guard(scratch.clone());
        let recent = scratch.join("Recent");
        std::fs::create_dir_all(&recent).unwrap();
        let a = scratch.join("a.txt");
        let folder = scratch.join("folder");
        std::fs::write(&a, "a").unwrap();
        std::fs::create_dir(&folder).unwrap();
        let gone = scratch.join("gone.txt");
        for (name, target) in [("a", &a), ("folder", &folder), ("gone", &gone)] {
            std::fs::write(
                recent.join(format!("{name}.lnk")),
                build_lnk(&target.to_string_lossy(), true),
            )
            .unwrap();
        }
        std::fs::write(recent.join("noise.txt"), "x").unwrap();
        let files = recent_files(&recent);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "a.txt");
        assert!(!files[0].is_dir);
    }

    const XBEL: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0" xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks">
  <bookmark href="file:///home/alex/old.txt" added="2024-01-01T00:00:00Z" modified="2024-01-01T00:00:00Z" visited="2024-01-01T00:00:00Z">
    <info><metadata owner="http://freedesktop.org"><mime:mime-type type="text/plain"/></metadata></info>
  </bookmark>
  <bookmark href="file:///home/alex/My%20Docs/caf%C3%A9%20%26%20co.md" added="2025-03-04T05:06:07Z" modified="2025-03-04T05:06:07Z" visited="2025-03-05T00:00:00.500000Z"/>
  <bookmark href='file://localhost/home/alex/single.txt' modified="2025-02-01T00:00:00Z"/>
  <bookmark href="smb://nas/share/remote.txt" modified="2026-01-01T00:00:00Z"/>
  <bookmark href="https://example.com/x" modified="2026-01-01T00:00:00Z"/>
  <bookmark href="file:///home/alex/a&amp;b.txt" modified="2025-01-01T00:00:00Z"/>
  <bookmark href="file:///home/alex/old.txt" modified="2025-06-01T00:00:00Z"/>
  <bookmark href="file:///bad%FF.txt" modified="2026-01-01T00:00:00Z"/>
  <bookmark-other href="file:///nope"/>
</xbel>"#;

    #[test]
    fn xbel_keeps_local_files_newest_first_decoded() {
        let got: Vec<String> = parse_xbel(XBEL).into_iter().map(|e| e.path).collect();
        assert_eq!(
            got,
            [
                "/home/alex/old.txt", // listed twice; the 2025-06 stamp wins and beats the rest
                "/home/alex/My Docs/café & co.md",
                "/home/alex/single.txt",
                "/home/alex/a&b.txt",
            ]
        );
    }

    #[test]
    fn xbel_stamps_use_the_newest_of_the_three_with_fractions() {
        let e = &parse_xbel(XBEL)[1];
        assert_eq!(e.stamp_us, 1_741_132_800_500_000); // 2025-03-05T00:00:00.5Z
        assert_eq!(parse_iso_us("1970-01-01T00:00:01Z"), Some(1_000_000));
        assert_eq!(parse_iso_us("not a date"), None);
    }

    #[test]
    fn xbel_garbage_is_an_empty_list() {
        assert!(parse_xbel("").is_empty());
        assert!(parse_xbel("<bookmark href=\"file:///x").is_empty());
        assert!(parse_xbel("<xbel/>").is_empty());
    }

    #[test]
    fn xbel_files_skip_missing_targets_and_folders() {
        let scratch = std::env::temp_dir().join(format!("trove-xbel-{}", std::process::id()));
        std::fs::create_dir_all(scratch.join("folder")).unwrap();
        let a = scratch.join("a b.txt");
        std::fs::write(&a, "a").unwrap();
        let uri = |p: &Path| format!("file://{}", p.to_string_lossy().replace(' ', "%20"));
        let xml = format!(
            "<xbel><bookmark href=\"{}\" modified=\"2025-01-01T00:00:00Z\"/>\
             <bookmark href=\"{}\" modified=\"2025-01-02T00:00:00Z\"/>\
             <bookmark href=\"{}\" modified=\"2025-01-03T00:00:00Z\"/></xbel>",
            uri(&a),
            uri(&scratch.join("folder")),
            uri(&scratch.join("gone.txt")),
        );
        let xbel = scratch.join("recently-used.xbel");
        std::fs::write(&xbel, xml).unwrap();
        let files = recent_files_xbel(&xbel);
        let _ = std::fs::remove_dir_all(&scratch);
        // Windows paths do not start with '/', so the parser rejects them there by design
        if cfg!(unix) {
            assert_eq!(files.len(), 1);
            assert_eq!(files[0].name, "a b.txt");
        }
        assert!(recent_files_xbel(Path::new("/no/such/recently-used.xbel")).is_empty());
    }

    #[test]
    fn this_machines_recent_folder_reads_without_panicking() {
        let Some(dir) = recent_dir() else { return };
        let files = recent_files(&dir);
        assert!(files.len() <= MAX_RECENT_FILES);
        assert!(files.iter().all(|f| !f.is_dir));
    }
}

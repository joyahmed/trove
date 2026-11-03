//! The Windows clipboard's file list: `CF_HDROP` (a `DROPFILES` header followed by a
//! double-NUL-terminated UTF-16 path list) plus the registered `Preferred DropEffect` DWORD
//! that tells Explorer whether the paste is a move (cut) or a copy. Writing both is what makes
//! "Cut here, paste in Explorer" and the other way round work. The encoding is pure and
//! tested; only the clipboard calls are Win32.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardPaths {
    pub paths: Vec<String>,
    /// true when the paths were cut (Preferred DropEffect has DROPEFFECT_MOVE)
    pub cut: bool,
}

/// `DROPFILES` is 20 bytes: `pFiles` (u32 offset of the list), `pt` (two i32), `fNC`, `fWide`.
#[cfg_attr(not(windows), allow(dead_code))] // used by the pure encoder, which off Windows only the tests call
const DROPFILES_LEN: usize = 20;
#[cfg(windows)] // only the Win32 clipboard and drag-out code use the effect bits
pub const DROPEFFECT_COPY: u32 = 1;
#[cfg(windows)]
pub const DROPEFFECT_MOVE: u32 = 2;

/// A `CF_HDROP` payload for `paths`, wide (UTF-16) form.
#[cfg_attr(not(windows), allow(dead_code))] // pure encoding, unit-tested on every OS; only Windows calls it outside tests
pub fn encode_hdrop(paths: &[String]) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        DROPFILES_LEN + paths.iter().map(|p| p.len() * 2 + 2).sum::<usize>() + 2,
    );
    out.extend_from_slice(&(DROPFILES_LEN as u32).to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes()); // pt.x
    out.extend_from_slice(&0i32.to_le_bytes()); // pt.y
    out.extend_from_slice(&0u32.to_le_bytes()); // fNC
    out.extend_from_slice(&1u32.to_le_bytes()); // fWide
    for path in paths {
        for unit in path.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out.extend_from_slice(&0u16.to_le_bytes());
    }
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// The paths in a `CF_HDROP` payload; wide or ANSI as the header says. Malformed → empty.
#[cfg_attr(not(windows), allow(dead_code))] // pure encoding, unit-tested on every OS; only Windows calls it outside tests
pub fn decode_hdrop(bytes: &[u8]) -> Vec<String> {
    let u32_at = |i: usize| {
        bytes
            .get(i..i + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    let (Some(offset), Some(wide)) = (u32_at(0), u32_at(16)) else {
        return Vec::new();
    };
    let Some(list) = bytes.get(offset as usize..) else {
        return Vec::new();
    };
    if wide != 0 {
        let units: Vec<u16> = list
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_le_bytes(*b))
            .collect();
        units
            .split(|&u| u == 0)
            .take_while(|s| !s.is_empty())
            .map(String::from_utf16_lossy)
            .collect()
    } else {
        list.split(|&b| b == 0)
            .take_while(|s| !s.is_empty())
            .map(|s| s.iter().map(|&b| b as char).collect())
            .collect()
    }
}

/// Explorer's "Copy as path": every path on its own line, each in double quotes. Lines end the
/// way the host's own text does: `\r\n` on Windows, `\n` on macOS and Linux.
pub fn quote_paths(paths: &[String]) -> String {
    let eol = if cfg!(windows) { "\r\n" } else { "\n" };
    paths
        .iter()
        .map(|p| format!("\"{p}\""))
        .collect::<Vec<_>>()
        .join(eol)
}

/// `CF_UNICODETEXT`: UTF-16LE with a terminating NUL.
#[cfg_attr(not(windows), allow(dead_code))] // pure encoding, unit-tested on every OS; only Windows calls it outside tests
pub fn encode_unicode_text(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(windows)]
pub use win::{read_paths, write_paths, write_text};

#[cfg(not(windows))]
pub use fallback::{read_paths, write_paths, write_text};

/// Off Windows there is no `CF_HDROP`, so files copied or cut in Trove live in this process
/// only: copy/cut/paste between Trove windows works (they share one process), with cut vs copy
/// kept. ⛔ Files are NOT put on the system clipboard, so pasting them into another app (or
/// another app's files into Trove) does not work off Windows; that is a deliberate scope
/// limit, not an oversight. Plain text does go to the system clipboard, through `arboard`.
#[cfg(not(windows))]
mod fallback {
    use super::ClipboardPaths;
    use std::sync::Mutex;

    /// The in-process file list. A struct (not a bare static) so tests use their own instance.
    #[derive(Default)]
    pub(super) struct Store(Mutex<Option<ClipboardPaths>>);

    impl Store {
        pub(super) const fn new() -> Self {
            Store(Mutex::new(None))
        }

        pub(super) fn set(&self, paths: &[String], cut: bool) {
            let next = (!paths.is_empty()).then(|| ClipboardPaths {
                paths: paths.to_vec(),
                cut,
            });
            *self.0.lock().unwrap_or_else(|e| e.into_inner()) = next;
        }

        pub(super) fn get(&self) -> Option<ClipboardPaths> {
            self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }

    static STORE: Store = Store::new();

    pub fn write_paths(paths: &[String], cut: bool) -> Result<(), String> {
        STORE.set(paths, cut);
        Ok(())
    }

    /// Plain text replaces the clipboard, so it also drops the file list (as on Windows).
    pub fn write_text(text: &str) -> Result<(), String> {
        STORE.set(&[], false);
        set_text(text).map_err(|e| format!("Cannot write to the clipboard: {e}"))
    }

    /// ⛔ Linux: on X11 the copied text lives in the PROCESS THAT OWNS THE SELECTION, and an
    /// `arboard::Clipboard` is that owner only while it is alive. A clipboard made per call and
    /// dropped right after `set_text` gave ownership up at once: with no clipboard manager
    /// running to take it over (app.log: "Could not hand the clipboard contents over to the
    /// clipboard manager"), the text was simply gone. One clipboard kept for the life of the
    /// process stays the owner until another app copies. A failed write drops it, so a lost X
    /// connection is rebuilt on the next copy.
    #[cfg(target_os = "linux")]
    fn set_text(text: &str) -> Result<(), arboard::Error> {
        static OWNER: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);
        let mut owner = OWNER.lock().unwrap_or_else(|e| e.into_inner());
        let clipboard = match owner.as_mut() {
            Some(c) => c,
            None => owner.insert(arboard::Clipboard::new()?),
        };
        let written = clipboard.set_text(text);
        if written.is_err() {
            *owner = None;
        }
        written
    }

    /// A Mac pasteboard keeps the text after the writer is gone, so a clipboard per call is fine.
    #[cfg(not(target_os = "linux"))]
    fn set_text(text: &str) -> Result<(), arboard::Error> {
        arboard::Clipboard::new().and_then(|mut c| c.set_text(text))
    }

    pub fn read_paths() -> Option<ClipboardPaths> {
        STORE.get()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn copy_and_cut_round_trip_with_their_flag() {
            let store = Store::new();
            assert_eq!(store.get(), None);
            let paths = vec![String::from("/a/b.txt"), String::from("/a/c")];
            store.set(&paths, false);
            assert_eq!(
                store.get(),
                Some(ClipboardPaths {
                    paths: paths.clone(),
                    cut: false
                })
            );
            store.set(&paths[..1], true);
            assert_eq!(
                store.get(),
                Some(ClipboardPaths {
                    paths: vec![String::from("/a/b.txt")],
                    cut: true
                })
            );
        }

        /// Needs an X display with NO clipboard manager and `xclip`, so it is opt-in:
        /// `DISPLAY=:99 cargo test -- --ignored copied_text_outlives_the_call` (never the desktop's
        /// own display: it overwrites that clipboard). Without the kept owner it reads back "".
        #[cfg(target_os = "linux")]
        #[test]
        #[ignore]
        fn copied_text_outlives_the_call() {
            let text = format!("trove-clipboard-{}", std::process::id());
            write_text(&text).expect("write");
            std::thread::sleep(std::time::Duration::from_millis(500));
            let out = std::process::Command::new("xclip")
                .args(["-o", "-selection", "clipboard"])
                .output()
                .expect("xclip");
            assert_eq!(String::from_utf8_lossy(&out.stdout), text);
        }

        #[test]
        fn an_empty_list_clears_the_store() {
            let store = Store::new();
            store.set(&[String::from("/x")], true);
            store.set(&[], false);
            assert_eq!(store.get(), None);
        }
    }
}

#[cfg(windows)]
mod win {
    use super::{
        decode_hdrop, encode_hdrop, encode_unicode_text, ClipboardPaths, DROPEFFECT_COPY,
        DROPEFFECT_MOVE,
    };
    use std::ptr::null_mut;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
        OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Ole::{CF_HDROP, CF_UNICODETEXT};

    const OPEN_RETRIES: u32 = 10;

    /// Holds the clipboard open; closes it on drop, whatever happened in between.
    struct Clipboard;

    impl Clipboard {
        fn open() -> Result<Self, String> {
            for _ in 0..OPEN_RETRIES {
                // SAFETY: a null owner window is allowed; the call has no other preconditions.
                if unsafe { OpenClipboard(null_mut()) } != 0 {
                    return Ok(Clipboard);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err("The clipboard is in use by another program".into())
        }
    }

    impl Drop for Clipboard {
        fn drop(&mut self) {
            // SAFETY: paired with the OpenClipboard that built this value.
            unsafe { CloseClipboard() };
        }
    }

    fn drop_effect_format() -> u32 {
        let name: Vec<u16> = "Preferred DropEffect\0".encode_utf16().collect();
        // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the call.
        unsafe { RegisterClipboardFormatW(name.as_ptr()) }
    }

    /// Copy `bytes` into a movable global block and hand it to the clipboard under `format`.
    /// The clipboard owns the block on success; on failure it is freed here.
    fn put(format: u32, bytes: &[u8]) -> Result<(), String> {
        // SAFETY: plain allocation; the size is the payload's.
        let block = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) };
        if block.is_null() {
            return Err("Out of memory".into());
        }
        // SAFETY: `block` is a valid movable handle; the lock gives a writable pointer of at
        // least `bytes.len()` bytes, unlocked before the clipboard takes the handle.
        unsafe {
            let dst = GlobalLock(block);
            if dst.is_null() {
                GlobalFree(block);
                return Err("Cannot lock clipboard memory".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst as *mut u8, bytes.len());
            GlobalUnlock(block);
            if SetClipboardData(format, block).is_null() {
                GlobalFree(block);
                return Err("SetClipboardData failed".into());
            }
        }
        Ok(())
    }

    /// The bytes of the clipboard's block for `format`, or None when it has none.
    fn get(format: u32) -> Option<Vec<u8>> {
        // SAFETY: the clipboard is open (callers hold a `Clipboard`); a null handle means
        // the format is absent; the lock/unlock pair brackets the read of `GlobalSize` bytes.
        unsafe {
            let handle = GetClipboardData(format);
            if handle.is_null() {
                return None;
            }
            let ptr = GlobalLock(handle);
            if ptr.is_null() {
                return None;
            }
            let len = GlobalSize(handle);
            let bytes = std::slice::from_raw_parts(ptr as *const u8, len).to_vec();
            GlobalUnlock(handle);
            Some(bytes)
        }
    }

    pub fn write_paths(paths: &[String], cut: bool) -> Result<(), String> {
        let _open = Clipboard::open()?;
        // SAFETY: the clipboard is open on this thread.
        if unsafe { EmptyClipboard() } == 0 {
            return Err("EmptyClipboard failed".into());
        }
        put(u32::from(CF_HDROP), &encode_hdrop(paths))?;
        let effect = if cut {
            DROPEFFECT_MOVE
        } else {
            DROPEFFECT_COPY
        };
        put(drop_effect_format(), &effect.to_le_bytes())
    }

    /// Plain text (Copy as path): replaces whatever the clipboard held.
    pub fn write_text(text: &str) -> Result<(), String> {
        let _open = Clipboard::open()?;
        // SAFETY: the clipboard is open on this thread.
        if unsafe { EmptyClipboard() } == 0 {
            return Err("EmptyClipboard failed".into());
        }
        put(u32::from(CF_UNICODETEXT), &encode_unicode_text(text))
    }

    pub fn read_paths() -> Option<ClipboardPaths> {
        // SAFETY: a pure query, no preconditions.
        if unsafe { IsClipboardFormatAvailable(u32::from(CF_HDROP)) } == 0 {
            return None;
        }
        let _open = Clipboard::open().ok()?;
        let paths = decode_hdrop(&get(u32::from(CF_HDROP))?);
        let cut = get(drop_effect_format())
            .and_then(|b| {
                b.get(..4)
                    .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            })
            .is_some_and(|effect| effect & DROPEFFECT_MOVE != 0);
        Some(ClipboardPaths { paths, cut })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_paths_is_one_quoted_path_per_line() {
        let one = quote_paths(&[String::from(r"C:\a b\c.txt")]);
        assert_eq!(one, "\"C:\\a b\\c.txt\"");
        let two = quote_paths(&[String::from(r"C:\x"), String::from("Ubuntu:/home/alex")]);
        let eol = if cfg!(windows) { "\r\n" } else { "\n" };
        assert_eq!(two, format!("\"C:\\x\"{eol}\"Ubuntu:/home/alex\""));
        assert_eq!(quote_paths(&[]), "");
    }

    #[test]
    fn unicode_text_is_utf16le_with_a_nul() {
        assert_eq!(encode_unicode_text("A\u{e9}"), vec![0x41, 0, 0xe9, 0, 0, 0]);
    }

    #[test]
    fn hdrop_round_trips_wide_paths() {
        let paths = vec![
            String::from(r"C:\Users\alex\Ünïcode file.txt"),
            String::from(r"\\wsl.localhost\Ubuntu\home\alex"),
        ];
        let bytes = encode_hdrop(&paths);
        assert_eq!(&bytes[..4], &20u32.to_le_bytes());
        assert_eq!(&bytes[16..20], &1u32.to_le_bytes());
        assert_eq!(&bytes[bytes.len() - 4..], &[0, 0, 0, 0]);
        assert_eq!(decode_hdrop(&bytes), paths);
    }

    #[test]
    fn hdrop_decodes_ansi_and_rejects_garbage() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&20u32.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 12]);
        bytes.extend_from_slice(&0u32.to_le_bytes()); // fWide = 0
        bytes.extend_from_slice(b"C:\\a.txt\0D:\\b\0\0");
        assert_eq!(decode_hdrop(&bytes), vec!["C:\\a.txt", "D:\\b"]);
        assert!(decode_hdrop(&[1, 2, 3]).is_empty());
        assert!(decode_hdrop(&encode_hdrop(&[])).is_empty());
    }
}

/// Live round trip against the real Windows clipboard and PowerShell, standing in for Explorer.
/// `#[ignore]` because they overwrite the machine's clipboard (the text is saved and put back).
/// Run: `cargo test -- --ignored clipboard_live --test-threads=1`.
#[cfg(all(test, windows))]
mod live_tests {
    use super::*;
    use std::process::Command;

    fn ps(script: &str, env: Option<(&str, &str)>) -> String {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-STA", "-Command", script]);
        if let Some((k, v)) = env {
            cmd.env(k, v);
        }
        let out = cmd.output().expect("powershell runs");
        assert!(
            out.status.success(),
            "powershell failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Saves the clipboard text on creation and puts it back on drop, even when a test fails.
    struct Restore(String);

    impl Restore {
        fn new() -> Self {
            Restore(ps("Get-Clipboard -Raw", None))
        }
    }

    impl Drop for Restore {
        fn drop(&mut self) {
            let mut cmd = Command::new("powershell");
            cmd.args(["-NoProfile", "-STA", "-Command"]);
            if self.0.is_empty() {
                cmd.arg("Set-Clipboard -Value $null");
            } else {
                cmd.arg("Set-Clipboard -Value $env:TROVE_CLIP")
                    .env("TROVE_CLIP", &self.0);
            }
            let _ = cmd.output();
        }
    }

    /// The clipboard is not always readable the instant a write returns (a clipboard manager
    /// or history service holds it for a moment), so poll for up to 3 seconds.
    fn eventually<T>(mut f: impl FnMut() -> Option<T>) -> Option<T> {
        for _ in 0..30 {
            if let Some(v) = f() {
                return Some(v);
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        None
    }

    fn temp_file(name: &str) -> String {
        let p = std::env::temp_dir().join(format!("trove-clip-{}-{name}", std::process::id()));
        std::fs::write(&p, b"x").unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    #[ignore = "overwrites the real clipboard"]
    fn clipboard_live_rust_copy_is_seen_by_powershell() {
        let _g = Restore::new();
        let f = temp_file("copy.txt");
        write_paths(std::slice::from_ref(&f), false).unwrap();
        let seen = eventually(|| {
            let s = ps(
                "foreach ($i in (Get-Clipboard -Format FileDropList)) { $i.FullName }",
                None,
            );
            (!s.is_empty()).then_some(s)
        })
        .unwrap_or_default();
        std::fs::remove_file(&f).ok();
        assert!(
            seen.lines().any(|l| l.eq_ignore_ascii_case(&f)),
            "FileDropList was {seen:?}, wanted {f}"
        );
    }

    #[test]
    #[ignore = "overwrites the real clipboard"]
    fn clipboard_live_powershell_copy_is_read_by_rust() {
        let _g = Restore::new();
        let f = temp_file("ps.txt");
        ps("Set-Clipboard -Path $env:TROVE_T", Some(("TROVE_T", &f)));
        let got = eventually(read_paths);
        std::fs::remove_file(&f).ok();
        let got = got.expect("file list on the clipboard");
        assert!(
            got.paths.iter().any(|p| p.eq_ignore_ascii_case(&f)),
            "{got:?}"
        );
        assert!(!got.cut);
    }

    #[test]
    #[ignore = "overwrites the real clipboard"]
    fn clipboard_live_cut_round_trips_and_sets_move_effect() {
        let _g = Restore::new();
        let f = temp_file("cut.txt");
        write_paths(std::slice::from_ref(&f), true).unwrap();
        let back = eventually(read_paths);
        let effect = ps(
            "Add-Type -AssemblyName System.Windows.Forms; \
             $s = [Windows.Forms.Clipboard]::GetData('Preferred DropEffect'); \
             $b = New-Object byte[] 4; [void]$s.Read($b, 0, 4); [BitConverter]::ToUInt32($b, 0)",
            None,
        );
        std::fs::remove_file(&f).ok();
        let back = back.expect("file list on the clipboard");
        assert!(back.cut, "{back:?}");
        assert!(back.paths.iter().any(|p| p.eq_ignore_ascii_case(&f)));
        assert_eq!(
            effect, "2",
            "Preferred DropEffect should be DROPEFFECT_MOVE"
        );
    }
}

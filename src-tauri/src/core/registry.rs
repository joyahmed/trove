//! A small typed API over `HKEY_CURRENT_USER`: read / write / delete `REG_SZ` values and
//! delete key trees. Paths are relative to HKCU (`Software\...`). Only the current user's
//! hive is ever touched — the set-as-default phase is per user and needs no elevation.
//!
//! Every function is `Unsupported` off Windows so `core` builds everywhere.

// Linux has no registry caller left (its default file manager uses `xdg-mime`).
#![cfg_attr(all(unix, not(target_os = "macos")), allow(dead_code))]

#[cfg(windows)]
use std::io::Result;
#[cfg(not(windows))]
use std::io::{Error, ErrorKind, Result};

#[cfg(windows)]
mod imp {
    use std::ffi::OsStr;
    use std::io::{Error, Result};
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
    };
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteKeyW, RegDeleteTreeW, RegDeleteValueW,
        RegEnumKeyExW, RegOpenKeyExW, RegQueryInfoKeyW, RegQueryValueExW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, REG_DWORD, REG_EXPAND_SZ,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    fn hkey(hive: super::Hive) -> HKEY {
        match hive {
            super::Hive::CurrentUser => HKEY_CURRENT_USER,
            super::Hive::LocalMachine => HKEY_LOCAL_MACHINE,
        }
    }

    pub(super) fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn os_err(rc: u32) -> Error {
        Error::from_raw_os_error(rc as i32)
    }

    fn not_found(rc: u32) -> bool {
        rc == ERROR_FILE_NOT_FOUND || rc == ERROR_PATH_NOT_FOUND
    }

    /// An open key under HKCU, closed on drop.
    pub(super) struct Key(HKEY);

    impl Key {
        /// `Ok(None)` when the key does not exist.
        pub(super) fn open(path: &str, access: u32) -> Result<Option<Key>> {
            Self::open_in(super::Hive::CurrentUser, path, access)
        }

        /// The same under a chosen hive; HKLM is only ever opened for reading.
        pub(super) fn open_in(hive: super::Hive, path: &str, access: u32) -> Result<Option<Key>> {
            let mut h: HKEY = std::ptr::null_mut();
            // SAFETY: `path` is NUL-terminated and outlives the call; `h` receives the handle.
            let rc = unsafe { RegOpenKeyExW(hkey(hive), wide(path).as_ptr(), 0, access, &mut h) };
            if rc == ERROR_SUCCESS {
                Ok(Some(Key(h)))
            } else if not_found(rc) {
                Ok(None)
            } else {
                Err(os_err(rc))
            }
        }

        /// The names of this key's subkeys, in registry order.
        pub(super) fn subkeys(&self) -> Result<Vec<String>> {
            let mut names = Vec::new();
            let mut index = 0u32;
            loop {
                let mut buf = [0u16; 256];
                let mut len = buf.len() as u32;
                // SAFETY: `buf` holds `len` UTF-16 units; the unused out-params are null, which
                // the API allows; `len` receives the name length without the NUL.
                let rc = unsafe {
                    RegEnumKeyExW(
                        self.0,
                        index,
                        buf.as_mut_ptr(),
                        &mut len,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                if rc != ERROR_SUCCESS {
                    // ERROR_NO_MORE_ITEMS ends the walk; anything else is not worth failing a
                    // menu over — the names so far are what we have.
                    return Ok(names);
                }
                names.push(String::from_utf16_lossy(&buf[..len as usize]));
                index += 1;
            }
        }

        /// Open, creating the whole path when missing.
        pub(super) fn create(path: &str) -> Result<Key> {
            let mut h: HKEY = std::ptr::null_mut();
            // SAFETY: `path` is NUL-terminated; a null class and security descriptor are the
            // documented defaults; `h` receives the handle; the disposition out-param may be null.
            let rc = unsafe {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    wide(path).as_ptr(),
                    0,
                    std::ptr::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_READ | KEY_WRITE,
                    std::ptr::null(),
                    &mut h,
                    std::ptr::null_mut(),
                )
            };
            if rc == ERROR_SUCCESS {
                Ok(Key(h))
            } else {
                Err(os_err(rc))
            }
        }

        /// A `REG_SZ` value; `Ok(None)` when the value is missing or not a string.
        pub(super) fn string(&self, name: &str) -> Result<Option<String>> {
            Ok(self.string_of(name, false)?.map(|(s, _)| s))
        }

        /// Like `string`, but a `REG_EXPAND_SZ` is accepted too, returned as stored (unexpanded)
        /// with `true` for the expand kind, so only that kind gets expanded.
        pub(super) fn string_or_expand(&self, name: &str) -> Result<Option<(String, bool)>> {
            self.string_of(name, true)
        }

        fn string_of(&self, name: &str, expand_ok: bool) -> Result<Option<(String, bool)>> {
            let name = wide(name);
            let mut ty = 0u32;
            let mut len = 0u32;
            // SAFETY: a null data pointer asks for the size only; `len` receives it.
            let rc = unsafe {
                RegQueryValueExW(
                    self.0,
                    name.as_ptr(),
                    std::ptr::null(),
                    &mut ty,
                    std::ptr::null_mut(),
                    &mut len,
                )
            };
            if not_found(rc) {
                return Ok(None);
            }
            if rc != ERROR_SUCCESS && rc != ERROR_MORE_DATA {
                return Err(os_err(rc));
            }
            let mut data = vec![0u8; len as usize];
            // SAFETY: `data` has `len` bytes, as the registry just told us it needs.
            let rc = unsafe {
                RegQueryValueExW(
                    self.0,
                    name.as_ptr(),
                    std::ptr::null(),
                    &mut ty,
                    data.as_mut_ptr(),
                    &mut len,
                )
            };
            if rc != ERROR_SUCCESS {
                return Err(os_err(rc));
            }
            if ty != REG_SZ && !(expand_ok && ty == REG_EXPAND_SZ) {
                return Ok(None);
            }
            data.truncate(len as usize);
            let units: Vec<u16> = data
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .take_while(|&u| u != 0)
                .collect();
            Ok(Some((
                String::from_utf16_lossy(&units),
                ty == REG_EXPAND_SZ,
            )))
        }

        /// A `REG_DWORD` value; `Ok(None)` when the value is missing or not a DWORD.
        pub(super) fn dword(&self, name: &str) -> Result<Option<u32>> {
            let name = wide(name);
            let mut ty = 0u32;
            let mut data = [0u8; 4];
            let mut len = data.len() as u32;
            // SAFETY: `data` has `len` bytes; the registry writes at most that many.
            let rc = unsafe {
                RegQueryValueExW(
                    self.0,
                    name.as_ptr(),
                    std::ptr::null(),
                    &mut ty,
                    data.as_mut_ptr(),
                    &mut len,
                )
            };
            if not_found(rc) {
                return Ok(None);
            }
            if rc != ERROR_SUCCESS {
                // ERROR_MORE_DATA: the value is not a DWORD-sized thing
                return if rc == ERROR_MORE_DATA {
                    Ok(None)
                } else {
                    Err(os_err(rc))
                };
            }
            if ty != REG_DWORD || len != 4 {
                return Ok(None);
            }
            Ok(Some(u32::from_le_bytes(data)))
        }

        #[allow(dead_code)] // the write half of the DWORD API; tests exercise it
        pub(super) fn set_dword(&self, name: &str, value: u32) -> Result<()> {
            let name = wide(name);
            let data = value.to_le_bytes();
            // SAFETY: `data` is 4 bytes of little-endian u32, which is what REG_DWORD is.
            let rc = unsafe {
                RegSetValueExW(
                    self.0,
                    name.as_ptr(),
                    0,
                    REG_DWORD,
                    data.as_ptr(),
                    data.len() as u32,
                )
            };
            if rc == ERROR_SUCCESS {
                Ok(())
            } else {
                Err(os_err(rc))
            }
        }

        pub(super) fn set_string(&self, name: &str, value: &str) -> Result<()> {
            let name = wide(name);
            let data = wide(value);
            let bytes = data.len() * 2;
            // SAFETY: `data` holds `bytes` bytes of NUL-terminated UTF-16, which is what REG_SZ is.
            let rc = unsafe {
                RegSetValueExW(
                    self.0,
                    name.as_ptr(),
                    0,
                    REG_SZ,
                    data.as_ptr().cast::<u8>(),
                    bytes as u32,
                )
            };
            if rc == ERROR_SUCCESS {
                Ok(())
            } else {
                Err(os_err(rc))
            }
        }

        /// Ok when the value was already missing.
        pub(super) fn delete_value(&self, name: &str) -> Result<()> {
            // SAFETY: `name` is NUL-terminated and outlives the call.
            let rc = unsafe { RegDeleteValueW(self.0, wide(name).as_ptr()) };
            if rc == ERROR_SUCCESS || not_found(rc) {
                Ok(())
            } else {
                Err(os_err(rc))
            }
        }

        /// Subkeys and values under this key.
        pub(super) fn counts(&self) -> Result<(u32, u32)> {
            let mut subkeys = 0u32;
            let mut values = 0u32;
            // SAFETY: every out-param not needed is null, which the API allows; the two we
            // pass are valid u32 slots.
            let rc = unsafe {
                RegQueryInfoKeyW(
                    self.0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut subkeys,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut values,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if rc == ERROR_SUCCESS {
                Ok((subkeys, values))
            } else {
                Err(os_err(rc))
            }
        }
    }

    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: the handle came from a successful open/create and is closed once.
            unsafe { RegCloseKey(self.0) };
        }
    }

    /// Delete `path` and everything under it; Ok when it does not exist.
    pub(super) fn delete_tree(path: &str) -> Result<()> {
        // SAFETY: `path` is NUL-terminated and outlives the call.
        let rc = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, wide(path).as_ptr()) };
        if rc == ERROR_SUCCESS || not_found(rc) {
            Ok(())
        } else {
            Err(os_err(rc))
        }
    }

    /// Delete `path` only when it has no subkeys and no values. `Ok(false)` when it was kept.
    pub(super) fn delete_key_if_empty(path: &str) -> Result<bool> {
        let Some(key) = Key::open(path, KEY_READ)? else {
            return Ok(true);
        };
        let (subkeys, values) = key.counts()?;
        drop(key);
        if subkeys > 0 || values > 0 {
            return Ok(false);
        }
        // SAFETY: `path` is NUL-terminated and outlives the call.
        let rc = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, wide(path).as_ptr()) };
        if rc == ERROR_SUCCESS || not_found(rc) {
            Ok(true)
        } else {
            Err(os_err(rc))
        }
    }

    pub(super) fn key_exists(path: &str) -> bool {
        matches!(Key::open(path, KEY_READ), Ok(Some(_)))
    }

    pub(super) const READ: u32 = KEY_READ;
    pub(super) const WRITE: u32 = KEY_READ | KEY_WRITE;
}

/// The `(default)` value of a key is the empty name.
pub const DEFAULT_VALUE: &str = "";

/// Which hive a read-only lookup goes to. Writes stay on `CurrentUser`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hive {
    CurrentUser,
    LocalMachine,
}

/// A `REG_SZ` under `hive`; `None` when the key or the value is missing.
#[cfg(windows)]
pub fn read_sz_in(hive: Hive, subkey: &str, name: &str) -> Result<Option<String>> {
    match imp::Key::open_in(hive, subkey, imp::READ)? {
        Some(key) => key.string(name),
        None => Ok(None),
    }
}

/// A `REG_SZ` or `REG_EXPAND_SZ` under `hive`. Only a `REG_EXPAND_SZ` has its `%VAR%`s expanded
/// from this process's environment (what `ExpandEnvironmentStringsW` does; an unknown `%VAR%`
/// stays as written); a `REG_SZ` is returned exactly as stored, as Windows reads it.
/// `None` when the key or the value is missing. Uninstall keys store `UninstallString`,
/// `InstallLocation` and `DisplayIcon` either way (plan 18, 1.2), and `read_sz_in` reads the
/// expand kind as missing. Expanded in Rust, so no new `windows-sys` feature is needed.
#[cfg(windows)]
pub fn read_expand_sz_in(hive: Hive, subkey: &str, name: &str) -> Result<Option<String>> {
    let raw = match imp::Key::open_in(hive, subkey, imp::READ)? {
        Some(key) => key.string_or_expand(name)?,
        None => None,
    };
    Ok(raw.map(|(s, is_expand)| expand_if(s, is_expand, &|v| std::env::var(v).ok())))
}

/// Expand `%VAR%` only in a `REG_EXPAND_SZ` value; a `REG_SZ` stays as stored.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn expand_if(s: String, is_expand: bool, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    if is_expand {
        expand_env(&s, lookup)
    } else {
        s
    }
}

/// `%VAR%` → `lookup(VAR)`; an unknown name, an empty `%%` or a lone `%` stays as written, like
/// `ExpandEnvironmentStringsW`. Pure, so it is tested on every OS.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn expand_env(s: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => match lookup(&after[..end]) {
                Some(value) => {
                    out.push_str(&value);
                    rest = &after[end + 1..];
                }
                None => {
                    // keep the first `%` and look again from the second: it may open a real one
                    out.push('%');
                    out.push_str(&after[..end]);
                    rest = &after[end..];
                }
            },
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A `REG_DWORD` under `hive`; `None` when the key or the value is missing.
#[cfg(windows)]
pub fn read_dword_in(hive: Hive, subkey: &str, name: &str) -> Result<Option<u32>> {
    match imp::Key::open_in(hive, subkey, imp::READ)? {
        Some(key) => key.dword(name),
        None => Ok(None),
    }
}

/// The subkey names under `hive\subkey`; empty when the key is missing.
#[cfg(windows)]
pub fn subkeys_in(hive: Hive, subkey: &str) -> Result<Vec<String>> {
    match imp::Key::open_in(hive, subkey, imp::READ)? {
        Some(key) => key.subkeys(),
        None => Ok(Vec::new()),
    }
}

#[cfg(not(windows))]
pub fn read_sz_in(_hive: Hive, _subkey: &str, _name: &str) -> Result<Option<String>> {
    Err(unsupported())
}
#[cfg(not(windows))]
#[allow(dead_code)]
pub fn read_expand_sz_in(_hive: Hive, _subkey: &str, _name: &str) -> Result<Option<String>> {
    Err(unsupported())
}
#[cfg(not(windows))]
pub fn subkeys_in(_hive: Hive, _subkey: &str) -> Result<Vec<String>> {
    Err(unsupported())
}

/// A `REG_SZ` under HKCU; `None` when the key or the value is missing.
#[cfg(windows)]
pub fn read_sz(subkey: &str, name: &str) -> Result<Option<String>> {
    match imp::Key::open(subkey, imp::READ)? {
        Some(key) => key.string(name),
        None => Ok(None),
    }
}

/// Write a `REG_SZ`, creating the key path when missing.
#[cfg(windows)]
pub fn write_sz(subkey: &str, name: &str, value: &str) -> Result<()> {
    imp::Key::create(subkey)?.set_string(name, value)
}

/// A `REG_DWORD` under HKCU; `None` when the key or the value is missing.
#[cfg(windows)]
pub fn read_dword(subkey: &str, name: &str) -> Result<Option<u32>> {
    match imp::Key::open(subkey, imp::READ)? {
        Some(key) => key.dword(name),
        None => Ok(None),
    }
}

/// Write a `REG_DWORD`, creating the key path when missing.
#[cfg(windows)]
#[allow(dead_code)] // the write half of the DWORD API; tests exercise it
pub fn write_dword(subkey: &str, name: &str, value: u32) -> Result<()> {
    imp::Key::create(subkey)?.set_dword(name, value)
}

/// Delete one value; Ok when the key or the value is already missing.
#[cfg(windows)]
pub fn delete_value(subkey: &str, name: &str) -> Result<()> {
    match imp::Key::open(subkey, imp::WRITE)? {
        Some(key) => key.delete_value(name),
        None => Ok(()),
    }
}

/// Delete a key and everything under it; Ok when missing.
#[cfg(windows)]
pub fn delete_tree(subkey: &str) -> Result<()> {
    imp::delete_tree(subkey)
}

/// Delete a key only if it holds no subkeys and no values. `Ok(false)` when it was kept.
#[cfg(windows)]
pub fn delete_key_if_empty(subkey: &str) -> Result<bool> {
    imp::delete_key_if_empty(subkey)
}

#[cfg(windows)]
pub fn key_exists(subkey: &str) -> bool {
    imp::key_exists(subkey)
}

#[cfg(not(windows))]
pub fn read_sz(_subkey: &str, _name: &str) -> Result<Option<String>> {
    Err(unsupported())
}
#[cfg(not(windows))]
pub fn write_sz(_subkey: &str, _name: &str, _value: &str) -> Result<()> {
    Err(unsupported())
}
#[cfg(not(windows))]
pub fn read_dword(_subkey: &str, _name: &str) -> Result<Option<u32>> {
    Err(unsupported())
}
#[cfg(not(windows))]
pub fn delete_value(_subkey: &str, _name: &str) -> Result<()> {
    Err(unsupported())
}
#[cfg(not(windows))]
pub fn delete_tree(_subkey: &str) -> Result<()> {
    Err(unsupported())
}
#[cfg(not(windows))]
pub fn delete_key_if_empty(_subkey: &str) -> Result<bool> {
    Err(unsupported())
}
#[cfg(not(windows))]
pub fn key_exists(_subkey: &str) -> bool {
    false
}
#[cfg(not(windows))]
fn unsupported() -> Error {
    Error::new(ErrorKind::Unsupported, "registry is Windows-only")
}

#[cfg(test)]
mod expand_tests {
    use super::{expand_env, expand_if};

    fn env(name: &str) -> Option<String> {
        match name.to_ascii_lowercase().as_str() {
            "programfiles" => Some(r"C:\Program Files".into()),
            "systemroot" => Some(r"C:\Windows".into()),
            _ => None,
        }
    }

    #[test]
    fn known_vars_expand_unknown_stay() {
        assert_eq!(
            expand_env(r"%ProgramFiles%\7-Zip\Uninstall.exe", &env),
            r"C:\Program Files\7-Zip\Uninstall.exe"
        );
        assert_eq!(expand_env(r"%NOPE%\x", &env), r"%NOPE%\x");
        assert_eq!(expand_env("100% sure", &env), "100% sure");
        assert_eq!(expand_env("%%", &env), "%%");
        assert_eq!(expand_env("%NOPE%SystemRoot%", &env), r"%NOPEC:\Windows");
        assert_eq!(expand_env("no vars", &env), "no vars");
    }

    #[test]
    fn only_expand_sz_is_expanded() {
        let raw = r"%ProgramFiles%\7-Zip\Uninstall.exe".to_string();
        // REG_SZ: Windows never expands it, so neither does Trove
        assert_eq!(expand_if(raw.clone(), false, &env), raw);
        assert_eq!(
            expand_if(raw, true, &env),
            r"C:\Program Files\7-Zip\Uninstall.exe"
        );
    }
}

#[cfg(all(test, windows))]
pub(crate) mod tests {
    use super::*;

    /// Every scratch root shares the `Software\trove-test` parent and each guard deletes that
    /// parent once it is empty; tests run on parallel threads, so the guards serialize on this
    /// lock or one deletes the parent between another's create and write.
    pub(crate) static SCRATCH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Take the scratch lock (a lock poisoned by a failed test is still a lock).
    pub(crate) fn scratch_lock() -> std::sync::MutexGuard<'static, ()> {
        SCRATCH_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A throw-away root under HKCU\Software\trove-test, deleted on drop. Nothing in
    /// these tests goes anywhere near HKCU\Software\Classes.
    pub(crate) struct Scratch(
        pub String,
        #[allow(dead_code)] std::sync::MutexGuard<'static, ()>,
    );

    impl Scratch {
        pub(crate) fn new(tag: &str) -> Scratch {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            Scratch(
                format!("Software\\trove-test\\{tag}-{}-{nanos}", std::process::id()),
                scratch_lock(),
            )
        }
        pub(crate) fn sub(&self, rest: &str) -> String {
            format!("{}\\{rest}", self.0)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = delete_tree(&self.0);
            let _ = delete_key_if_empty("Software\\trove-test");
        }
    }

    #[test]
    fn write_read_delete_round_trip() {
        let s = Scratch::new("rt");
        let key = s.sub("a\\b\\command");
        assert!(!key_exists(&key));
        assert_eq!(read_sz(&key, DEFAULT_VALUE).unwrap(), None);
        write_sz(&key, DEFAULT_VALUE, "\"C:\\x.exe\" \"%1\"").unwrap();
        write_sz(&key, "DelegateExecute", "").unwrap();
        assert!(key_exists(&key));
        assert_eq!(
            read_sz(&key, DEFAULT_VALUE).unwrap().as_deref(),
            Some("\"C:\\x.exe\" \"%1\"")
        );
        assert_eq!(
            read_sz(&key, "DelegateExecute").unwrap().as_deref(),
            Some("")
        );
        assert_eq!(read_sz(&key, "Missing").unwrap(), None);
        delete_value(&key, "DelegateExecute").unwrap();
        assert_eq!(read_sz(&key, "DelegateExecute").unwrap(), None);
        delete_value(&key, "DelegateExecute").unwrap(); // already gone is fine
        assert!(!delete_key_if_empty(&key).unwrap()); // still holds (default)
        delete_tree(&s.sub("a")).unwrap();
        assert!(!key_exists(&key));
        delete_tree(&s.sub("a")).unwrap(); // missing is fine
    }

    #[test]
    fn reg_sz_with_percent_is_not_expanded() {
        let s = Scratch::new("sz-pct");
        let key = s.sub("u");
        write_sz(&key, "UninstallString", r"%SystemRoot%\x.exe").unwrap();
        assert_eq!(
            read_expand_sz_in(Hive::CurrentUser, &key, "UninstallString")
                .unwrap()
                .as_deref(),
            Some(r"%SystemRoot%\x.exe")
        );
    }

    #[test]
    fn dword_round_trip_and_type_mismatch() {
        let s = Scratch::new("dword");
        let key = s.sub("theme");
        assert_eq!(read_dword(&key, "AccentColor").unwrap(), None);
        write_dword(&key, "AccentColor", 0xffb85f00).unwrap();
        assert_eq!(read_dword(&key, "AccentColor").unwrap(), Some(0xffb85f00));
        // a string under the same name is not a DWORD
        write_sz(&key, "Name", "x").unwrap();
        assert_eq!(read_dword(&key, "Name").unwrap(), None);
    }

    #[test]
    fn delete_key_if_empty_only_removes_empty_keys() {
        let s = Scratch::new("empty");
        let leaf = s.sub("p\\q");
        write_sz(&leaf, DEFAULT_VALUE, "v").unwrap();
        assert!(!delete_key_if_empty(&s.sub("p")).unwrap());
        delete_value(&leaf, DEFAULT_VALUE).unwrap();
        assert!(delete_key_if_empty(&leaf).unwrap());
        assert!(delete_key_if_empty(&s.sub("p")).unwrap());
        assert!(!key_exists(&s.sub("p")));
    }
}

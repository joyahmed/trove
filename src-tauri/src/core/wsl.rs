//! WSL distros as places. The installed distros come from the registry
//! (`HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss`), so listing them spawns nothing;
//! `wsl.exe -l -q` is only the fallback when that key is missing. A distro's entry point is its
//! default user's home, read from `/etc/passwd` over the `\\wsl.localhost` share the first time
//! the user opens it. Everything here that decides something is a pure function with a test;
//! the registry and process code is thin around it.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    pub name: String,
    pub is_default: bool,
    /// `DefaultUid`: the user whose home is the distro's entry point.
    pub uid: u32,
}

/// One `Lxss\{guid}` subkey as read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawDistro {
    pub name: String,
    pub uid: u32,
    /// `Flags` — kept for the record (bit 3 = WSL 2), not filtered on.
    pub flags: u32,
    pub base_path: String,
}

/// The Lxss key as read: its subkeys (guid, values) and `DefaultDistribution`.
pub type LxssDump = (Vec<(String, RawDistro)>, Option<String>);

#[cfg(windows)] // only the Windows registry reader uses it
const LXSS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Lxss";
const SHARE: &str = r"\\wsl.localhost\";
const LEGACY_SHARE: &str = r"\\wsl$\";

/// Registry subkeys → the list the sidebar shows: the default distro first, then by name.
/// A subkey without a name is not a distro.
pub fn distros_from(raw: Vec<(String, RawDistro)>, default_guid: Option<&str>) -> Vec<WslDistro> {
    let default = default_guid.map(|g| g.to_ascii_lowercase());
    let mut list: Vec<WslDistro> = raw
        .into_iter()
        .filter(|(_, d)| !d.name.trim().is_empty())
        .map(|(guid, d)| WslDistro {
            is_default: default.as_deref() == Some(&guid.to_ascii_lowercase()),
            name: d.name,
            uid: d.uid,
        })
        .collect();
    list.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    list
}

/// The installed distros, from the registry; `wsl -l -q` only when the key is missing.
/// ⛔ Windows only: off Windows the registry read always fails, and a Linux build running INSIDE
/// WSL still finds `wsl.exe` through interop, so it listed its own host's distros as a "Linux"
/// section (seen in a WSLg window, 2026-10-06). On a Mac or Linux there are no WSL distros.
pub fn distros() -> Vec<WslDistro> {
    match registry::read_lxss() {
        Some((raw, default)) => distros_from(raw, default.as_deref()),
        None if cfg!(windows) => distros_from_wsl_list(),
        None => Vec::new(),
    }
}

/// `wsl.exe -l -q` prints UTF-16LE, one name per line, the default first.
fn distros_from_wsl_list() -> Vec<WslDistro> {
    let Some(output) = run_wsl_list() else {
        return Vec::new();
    };
    parse_wsl_list(&output)
        .into_iter()
        .enumerate()
        .map(|(i, name)| WslDistro {
            name,
            is_default: i == 0,
            uid: 1000,
        })
        .collect()
}

fn run_wsl_list() -> Option<Vec<u8>> {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-l", "-q"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    out.status.success().then_some(out.stdout)
}

/// Little-endian UTF-16 code units from raw bytes (an odd trailing byte is dropped).
fn utf16le(bytes: &[u8]) -> Vec<u16> {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect()
}

/// Decode `wsl -l -q` output: UTF-16LE with a BOM (falls back to UTF-8), NULs and blank lines
/// dropped.
pub fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    // wsl.exe prints UTF-16LE; through a pipe it writes the BOM for `-l -q` and not for
    // `-l --running -q`. A NUL in the second byte is the tell either way (ASCII names).
    let bom = bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE;
    let wide = bom || (bytes.len() >= 2 && bytes[1] == 0);
    let text = if wide {
        String::from_utf16_lossy(&utf16le(if bom { &bytes[2..] } else { bytes }))
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.lines()
        .map(|l| l.trim_matches(|c: char| c == '\0' || c.is_whitespace()))
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// The UNC root of a distro: `\\wsl.localhost\Ubuntu\`.
pub fn root_of(distro: &str) -> String {
    format!("{SHARE}{distro}\\")
}

/// `\\wsl.localhost\<distro>\<linux path>`, separators flipped.
fn unc(distro: &str, linux_path: &str) -> String {
    let rest = linux_path.trim_start_matches('/').replace('/', "\\");
    if rest.is_empty() {
        root_of(distro)
    } else {
        format!("{SHARE}{distro}\\{rest}")
    }
}

/// The entry point for `uid` from the text of `/etc/passwd`: its home directory; `/home/<login>`
/// when the home field is empty; the distro root when the uid is not listed.
pub fn home_from_passwd(passwd: &str, uid: u32, distro: &str) -> String {
    let uid_text = uid.to_string();
    let line = passwd.lines().find(|l| {
        let mut f = l.split(':');
        f.next().is_some() && f.next().is_some() && f.next() == Some(uid_text.as_str())
    });
    match line {
        None => root_of(distro),
        Some(l) => {
            let f: Vec<&str> = l.split(':').collect();
            let login = f.first().copied().unwrap_or_default();
            let home = f.get(5).copied().unwrap_or_default();
            if home.is_empty() {
                unc(distro, &format!("/home/{login}"))
            } else {
                unc(distro, home)
            }
        }
    }
}

/// Where a click on the distro lands. Reading the share starts the distro; that is intended.
pub fn home(distro: &str, uid: u32) -> String {
    let passwd = Path::new(&root_of(distro)).join("etc").join("passwd");
    match std::fs::read_to_string(passwd) {
        Ok(text) => home_from_passwd(&text, uid, distro),
        Err(_) => root_of(distro),
    }
}

pub fn is_wsl_path(path: &str) -> bool {
    split_wsl_path(path).is_some()
}

/// `\\wsl.localhost\Ubuntu\home\alex` → (`Ubuntu`, `/home/alex`); `\\wsl$\Ubuntu` → (`Ubuntu`, `/`).
pub fn split_wsl_path(path: &str) -> Option<(String, String)> {
    let lower = path.to_ascii_lowercase();
    let share = [SHARE, LEGACY_SHARE]
        .into_iter()
        .find(|s| lower.starts_with(&s.to_ascii_lowercase()))?;
    let rest = &path[share.len()..];
    let (distro, tail) = match rest.find(['\\', '/']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if distro.is_empty() {
        return None;
    }
    let mut linux = tail.replace('\\', "/");
    while linux.ends_with('/') && linux.len() > 1 {
        linux.pop();
    }
    if linux.is_empty() {
        linux.push('/');
    }
    Some((distro.to_string(), linux))
}

/// The process to start for "Open in Terminal": (program, args, needs its own console).
/// Windows Terminal takes the folder itself; without it, `cmd` or `wsl` in a new console.
#[cfg_attr(not(windows), allow(dead_code))] // only Windows spawns it; tests run everywhere
pub fn terminal_command(path: &str, have_wt: bool) -> (String, Vec<String>, bool) {
    let s = |v: &str| v.to_string();
    match (split_wsl_path(path), have_wt) {
        (Some((distro, linux)), true) => (
            s("wt.exe"),
            vec![s("wsl"), s("-d"), distro, s("--cd"), linux],
            false,
        ),
        (Some((distro, linux)), false) => {
            (s("wsl.exe"), vec![s("-d"), distro, s("--cd"), linux], true)
        }
        (None, true) => (s("wt.exe"), vec![s("-d"), s(path)], false),
        (None, false) => (s("cmd.exe"), vec![s("/K"), s("cd"), s("/d"), s(path)], true),
    }
}

/// Is `exe` on PATH?
pub(crate) fn on_path(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file()))
        .unwrap_or(false)
}

#[cfg(any(not(windows), test))]
/// Terminals tried on Linux, in order, after `$TERMINAL`.
const LINUX_TERMINALS: &[&str] = &[
    "x-terminal-emulator",
    "gnome-terminal",
    "ptyxis",
    "kgx",
    "konsole",
    "xfce4-terminal",
    "alacritty",
    "kitty",
    "wezterm",
    "xterm",
];

#[cfg(any(not(windows), test))]
/// The terminal to start on Linux: (program, args). The caller also sets the working
/// directory, so most need no folder argument. `have` says whether a program exists.
pub fn linux_terminal_command(
    path: &str,
    env_terminal: Option<&str>,
    have: impl Fn(&str) -> bool,
) -> Option<(String, Vec<String>)> {
    let env = env_terminal.map(str::trim).filter(|t| !t.is_empty());
    let program = env
        .into_iter()
        .chain(LINUX_TERMINALS.iter().copied())
        .find(|t| have(t))?;
    let name = program.rsplit('/').next().unwrap_or(program);
    let args = match name {
        "gnome-terminal" => vec![format!("--working-directory={path}")],
        "konsole" => vec!["--workdir".to_string(), path.to_string()],
        _ => Vec::new(),
    };
    Some((program.to_string(), args))
}

#[cfg(any(not(windows), test))]
/// macOS: Terminal.app opens a window at the folder.
pub fn mac_terminal_command(path: &str) -> (String, Vec<String>) {
    (
        "open".to_string(),
        vec!["-a".to_string(), "Terminal".to_string(), path.to_string()],
    )
}

/// "Open in Terminal" at `path`.
pub fn open_terminal(path: &str) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let (program, args, new_console) = terminal_command(path, on_path("wt.exe"));
        let mut cmd = Command::new(program);
        cmd.args(args);
        if new_console {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NEW_CONSOLE);
        }
        cmd.spawn().map(drop)
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;
        let (program, args) = if cfg!(target_os = "macos") {
            mac_terminal_command(path)
        } else {
            let env = std::env::var("TERMINAL").ok();
            linux_terminal_command(path, env.as_deref(), |t| {
                if t.contains('/') {
                    Path::new(t).is_file()
                } else {
                    on_path(t)
                }
            })
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "No terminal app found. Install one, or set $TERMINAL.",
                )
            })?
        };
        // Detached: own process group and no stdio, so it outlives Trove; a thread reaps it when
        // it exits so a closed terminal does not linger as a zombie while Trove runs.
        let mut child = Command::new(program)
            .args(args)
            .current_dir(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()?;
        std::thread::spawn(move || child.wait());
        Ok(())
    }
}

#[cfg(windows)]
mod registry {
    //! `HKCU\...\Lxss`: one subkey per distro, `DefaultDistribution` on the key itself.
    use super::{LxssDump, RawDistro, LXSS_KEY};
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_READ, REG_DWORD, REG_SZ,
    };

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// An open key, closed on drop.
    struct Key(HKEY);

    impl Key {
        fn open(parent: HKEY, path: &str) -> Option<Key> {
            let mut h: HKEY = std::ptr::null_mut();
            // SAFETY: `path` is NUL-terminated and outlives the call; `h` receives the handle.
            let rc = unsafe { RegOpenKeyExW(parent, wide(path).as_ptr(), 0, KEY_READ, &mut h) };
            (rc == ERROR_SUCCESS).then_some(Key(h))
        }

        fn subkeys(&self) -> Vec<String> {
            let mut names = Vec::new();
            let mut buf = [0u16; 256];
            for i in 0.. {
                let mut len = buf.len() as u32;
                // SAFETY: `buf` holds `len` u16s; the other out-params are allowed to be null.
                let rc = unsafe {
                    RegEnumKeyExW(
                        self.0,
                        i,
                        buf.as_mut_ptr(),
                        &mut len,
                        std::ptr::null(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                if rc != ERROR_SUCCESS {
                    break;
                }
                names.push(String::from_utf16_lossy(&buf[..len as usize]));
            }
            names
        }

        /// The raw bytes and type of a value, if it exists.
        fn value(&self, name: &str) -> Option<(u32, Vec<u8>)> {
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
            if rc != ERROR_SUCCESS {
                return None;
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
            (rc == ERROR_SUCCESS).then(|| {
                data.truncate(len as usize);
                (ty, data)
            })
        }

        fn string(&self, name: &str) -> Option<String> {
            let (ty, data) = self.value(name)?;
            if ty != REG_SZ {
                return None;
            }
            let units: Vec<u16> = super::utf16le(&data)
                .into_iter()
                .take_while(|&u| u != 0)
                .collect();
            Some(String::from_utf16_lossy(&units))
        }

        fn dword(&self, name: &str) -> Option<u32> {
            let (ty, data) = self.value(name)?;
            (ty == REG_DWORD && data.len() >= 4)
                .then(|| u32::from_le_bytes([data[0], data[1], data[2], data[3]]))
        }
    }

    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: the handle came from a successful RegOpenKeyExW and is closed once.
            unsafe { RegCloseKey(self.0) };
        }
    }

    /// `None` when the Lxss key does not exist (no WSL), else the subkeys and the default GUID.
    pub fn read_lxss() -> Option<LxssDump> {
        let lxss = Key::open(HKEY_CURRENT_USER, LXSS_KEY)?;
        let default = lxss.string("DefaultDistribution");
        let raw = lxss
            .subkeys()
            .into_iter()
            .filter_map(|guid| {
                let k = Key::open(lxss.0, &guid)?;
                Some((
                    guid,
                    RawDistro {
                        name: k.string("DistributionName").unwrap_or_default(),
                        uid: k.dword("DefaultUid").unwrap_or(0),
                        flags: k.dword("Flags").unwrap_or(0),
                        base_path: k.string("BasePath").unwrap_or_default(),
                    },
                ))
            })
            .collect();
        Some((raw, default))
    }
}

#[cfg(not(windows))]
mod registry {
    use super::LxssDump;
    pub fn read_lxss() -> Option<LxssDump> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UBUNTU: &str = "{cb561c40-17a8-47fe-b9b1-f5b7622a4518}";
    const DOCKER: &str = "{01a6a016-9f61-4427-b265-e3dde6d364d6}";

    /// The Lxss key of the machine this was written on, captured 2026-09-21.
    fn dump() -> Vec<(String, RawDistro)> {
        vec![
            (
                DOCKER.to_string(),
                RawDistro {
                    name: "docker-desktop".into(),
                    uid: 0,
                    flags: 15,
                    base_path: r"\\?\C:\Users\alex\AppData\Local\Docker\wsl\main".into(),
                },
            ),
            (
                UBUNTU.to_string(),
                RawDistro {
                    name: "Ubuntu".into(),
                    uid: 1000,
                    flags: 15,
                    base_path: r"D:\ProgramFiles\WSL\Ubuntu\UbuntuExtracted".into(),
                },
            ),
            ("{dead}".to_string(), RawDistro::default()),
        ]
    }

    #[test]
    fn registry_dump_lists_the_default_first_and_skips_nameless_keys() {
        let list = distros_from(dump(), Some(&UBUNTU.to_ascii_uppercase()));
        assert_eq!(
            list,
            vec![
                WslDistro {
                    name: "Ubuntu".into(),
                    is_default: true,
                    uid: 1000
                },
                WslDistro {
                    name: "docker-desktop".into(),
                    is_default: false,
                    uid: 0
                },
            ]
        );
        assert_eq!(dump()[1].1.flags, 15);
    }

    #[test]
    fn no_default_means_alphabetical() {
        let names: Vec<String> = distros_from(dump(), None)
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert_eq!(names, vec!["docker-desktop", "Ubuntu"]);
    }

    #[test]
    fn wsl_list_output_is_utf16_with_a_bom() {
        let mut bytes = vec![0xFF, 0xFE];
        for u in "Ubuntu\r\ndocker-desktop\r\n\r\n".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(parse_wsl_list(&bytes), vec!["Ubuntu", "docker-desktop"]);
        assert_eq!(parse_wsl_list(b"Ubuntu\n"), vec!["Ubuntu"]);
        // `-l --running -q` through a pipe: UTF-16LE without the BOM
        let no_bom: Vec<u8> = "Ubuntu\r\n"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert_eq!(parse_wsl_list(&no_bom), vec!["Ubuntu"]);
    }

    #[test]
    fn home_comes_from_the_uid_line_of_passwd() {
        let passwd = "root:x:0:0:root:/root:/bin/bash\nalex:x:1000:1000::/home/alex:/bin/bash\n";
        assert_eq!(
            home_from_passwd(passwd, 1000, "Ubuntu"),
            r"\\wsl.localhost\Ubuntu\home\alex"
        );
        assert_eq!(
            home_from_passwd(passwd, 0, "Ubuntu"),
            r"\\wsl.localhost\Ubuntu\root"
        );
        assert_eq!(
            home_from_passwd(passwd, 42, "Ubuntu"),
            r"\\wsl.localhost\Ubuntu\"
        );
        assert_eq!(
            home_from_passwd("alex:x:1000:1000:::/bin/bash\n", 1000, "Ubuntu"),
            r"\\wsl.localhost\Ubuntu\home\alex"
        );
    }

    #[test]
    fn wsl_paths_split_into_distro_and_linux_path() {
        assert_eq!(
            split_wsl_path(r"\\wsl.localhost\Ubuntu\home\alex"),
            Some(("Ubuntu".into(), "/home/alex".into()))
        );
        assert_eq!(
            split_wsl_path(r"\\wsl$\Ubuntu"),
            Some(("Ubuntu".into(), "/".into()))
        );
        assert_eq!(
            split_wsl_path(r"\\WSL.LOCALHOST\Ubuntu\"),
            Some(("Ubuntu".into(), "/".into()))
        );
        assert_eq!(split_wsl_path(r"C:\x"), None);
        assert_eq!(split_wsl_path(r"\\wsl.localhost\"), None);
        assert!(is_wsl_path(r"\\wsl.localhost\Ubuntu"));
        assert!(!is_wsl_path(r"\\server\share"));
    }

    #[test]
    fn terminal_command_for_the_four_cases() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            terminal_command(r"C:\Users\alex", true),
            ("wt.exe".into(), s(&["-d", r"C:\Users\alex"]), false)
        );
        assert_eq!(
            terminal_command(r"C:\Users\alex", false),
            (
                "cmd.exe".into(),
                s(&["/K", "cd", "/d", r"C:\Users\alex"]),
                true
            )
        );
        assert_eq!(
            terminal_command(r"\\wsl.localhost\Ubuntu\home\alex", true),
            (
                "wt.exe".into(),
                s(&["wsl", "-d", "Ubuntu", "--cd", "/home/alex"]),
                false
            )
        );
        assert_eq!(
            terminal_command(r"\\wsl.localhost\Ubuntu\home\alex", false),
            (
                "wsl.exe".into(),
                s(&["-d", "Ubuntu", "--cd", "/home/alex"]),
                true
            )
        );
    }

    #[test]
    fn linux_terminal_pick_order() {
        let only = |names: &'static [&'static str]| move |t: &str| names.contains(&t);
        let pick = |env: Option<&str>, have: &'static [&'static str]| {
            linux_terminal_command("/home/alex", env, only(have))
        };
        // $TERMINAL wins over everything.
        assert_eq!(
            pick(Some("kitty"), &["kitty", "gnome-terminal"]),
            Some(("kitty".into(), vec![]))
        );
        // An unusable $TERMINAL falls through to the list.
        assert_eq!(
            pick(Some("nope"), &["xterm", "konsole"]).unwrap().0,
            "konsole"
        );
        // List order: x-terminal-emulator first, then gnome-terminal, ...
        assert_eq!(
            pick(None, &["gnome-terminal", "x-terminal-emulator", "xterm"]),
            Some(("x-terminal-emulator".into(), vec![]))
        );
        assert_eq!(
            pick(None, &["xterm", "gnome-terminal"]),
            Some((
                "gnome-terminal".into(),
                vec!["--working-directory=/home/alex".to_string()]
            ))
        );
        assert_eq!(
            pick(None, &["xterm", "konsole"]),
            Some((
                "konsole".into(),
                vec!["--workdir".to_string(), "/home/alex".to_string()]
            ))
        );
        assert_eq!(pick(None, &["xterm"]).unwrap().0, "xterm");
        // Empty $TERMINAL is ignored; nothing installed gives None.
        assert_eq!(pick(Some("  "), &["wezterm"]).unwrap().0, "wezterm");
        assert_eq!(pick(None, &[]), None);
    }

    #[test]
    fn mac_terminal_opens_terminal_app() {
        assert_eq!(
            mac_terminal_command("/Users/alex"),
            (
                "open".to_string(),
                vec![
                    "-a".to_string(),
                    "Terminal".to_string(),
                    "/Users/alex".to_string()
                ]
            )
        );
    }
}

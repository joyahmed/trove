//! "Retry as administrator" (plan 05 5.6). When a rename, new folder or delete fails with
//! access denied, the frontend can offer to run that ONE operation again elevated. The main
//! process never runs elevated: it starts its own exe through UAC (`ShellExecuteExW`, verb
//! `runas`) with `--elevated-op <hex of the op's JSON> --result <temp file>`. That process does
//! the one operation, writes the answer to the temp file and exits before any window, plugin or
//! single-instance check starts (`lib.rs` `elevated_entry`). It never browses.
//!
//! The op travels hex-encoded so no path can break Windows' command-line quoting.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

use crate::core::ops;

/// The flag that turns the exe into the one-shot helper.
pub const OP_ARG: &str = "--elevated-op";
/// Where the helper writes its answer.
pub const RESULT_ARG: &str = "--result";

/// The one operation an elevated helper may run. Nothing that lists or opens anything.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ElevatedOp {
    Rename { path: String, new_name: String },
    CreateFolder { dir: String },
    Delete { paths: Vec<String> },
}

/// The helper's answer, as the temp file carries it.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// the new path (rename, new folder) or "" (delete)
    Ok(String),
    Err(String),
}

/// Does the operation in this process (the helper's half, and the tests').
pub fn perform(op: &ElevatedOp) -> io::Result<String> {
    match op {
        ElevatedOp::Rename { path, new_name } => {
            ops::rename(Path::new(path), new_name).map(|p| p.to_string_lossy().into_owned())
        }
        ElevatedOp::CreateFolder { dir } => {
            ops::create_folder(Path::new(dir)).map(|p| p.to_string_lossy().into_owned())
        }
        ElevatedOp::Delete { paths } => {
            if paths.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "nothing to delete",
                ));
            }
            let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
            ops::delete_permanently(&paths).map(|()| String::new())
        }
    }
}

#[cfg_attr(not(windows), allow(dead_code))] // only Windows elevates; tested everywhere
pub fn encode(op: &ElevatedOp) -> String {
    let json = serde_json::to_vec(op).unwrap_or_default();
    json.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn decode(hex: &str) -> Option<ElevatedOp> {
    if !hex.len().is_multiple_of(2) || !hex.is_ascii() {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect();
    serde_json::from_slice(&bytes?).ok()
}

/// The helper's arguments, or None when this is a normal start.
pub fn parse_args(args: &[String]) -> Option<(Option<ElevatedOp>, Option<PathBuf>)> {
    let at = args.iter().position(|a| a == OP_ARG)?;
    let op = args.get(at + 1).and_then(|h| decode(h));
    let result = args
        .iter()
        .position(|a| a == RESULT_ARG)
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from);
    Some((op, result))
}

/// The helper: run the op, write the answer, return the exit code. None: a normal start.
pub fn helper_main(args: &[String]) -> Option<i32> {
    let (op, result) = parse_args(args)?;
    let outcome = match op {
        Some(op) => match perform(&op) {
            Ok(s) => Outcome::Ok(s),
            Err(e) => Outcome::Err(e.to_string()),
        },
        None => Outcome::Err("the elevated helper got an operation it could not read".into()),
    };
    let code = i32::from(matches!(outcome, Outcome::Err(_)));
    if let Some(file) = result {
        let _ = std::fs::write(file, serde_json::to_vec(&outcome).unwrap_or_default());
    }
    Some(code)
}

/// Reads the helper's answer; `exit` is its exit code, for a helper that left none.
#[cfg_attr(not(windows), allow(dead_code))] // only Windows elevates; tested everywhere
pub fn read_outcome(file: &Path, exit: u32) -> Result<String, String> {
    match std::fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice::<Outcome>(&b).ok())
    {
        Some(Outcome::Ok(s)) => Ok(s),
        Some(Outcome::Err(e)) => Err(e),
        None => Err(format!(
            "the administrator copy of Trove gave no answer (exit code {exit})"
        )),
    }
}

/// Runs `op` in an elevated copy of this exe and waits for it. Windows only.
#[cfg(windows)]
pub fn run_elevated(op: &ElevatedOp) -> Result<String, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, WaitForSingleObject, INFINITE,
    };
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let result = std::env::temp_dir().join(format!(
        "trove-elevated-{}-{stamp}.json",
        std::process::id()
    ));
    let params = format!(
        "{OP_ARG} {} {RESULT_ARG} \"{}\"",
        encode(op),
        result.display()
    );
    let verb = wide("runas");
    let file_w = wide(&exe.to_string_lossy());
    let params_w = wide(&params);
    crate::core::icons::ensure_com();
    // SAFETY: zeroed is a valid SHELLEXECUTEINFOW (all pointers null, all flags clear).
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOASYNC | SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file_w.as_ptr();
    info.lpParameters = params_w.as_ptr();
    info.nShow = SW_HIDE;
    // SAFETY: every string is NUL-terminated and outlives the call.
    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok == 0 || info.hProcess.is_null() {
        let err = io::Error::last_os_error();
        return Err(match err.raw_os_error() {
            Some(1223) => "Retry as administrator was cancelled".into(),
            _ => err.to_string(),
        });
    }
    let mut exit = 0u32;
    // SAFETY: the handle is ours until CloseHandle below.
    unsafe {
        WaitForSingleObject(info.hProcess, INFINITE);
        GetExitCodeProcess(info.hProcess, &mut exit);
        CloseHandle(info.hProcess);
    }
    let answer = read_outcome(&result, exit);
    let _ = std::fs::remove_file(&result);
    answer
}

#[cfg(not(windows))]
pub fn run_elevated(_op: &ElevatedOp) -> Result<String, String> {
    Err("Retry as administrator is only on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("trove-elev-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn an_op_survives_the_hex_round_trip_with_spaces_quotes_and_unicode() {
        let op = ElevatedOp::Rename {
            path: r#"C:\Program Files\a "b" ü.txt"#.into(),
            new_name: "c d.txt".into(),
        };
        let hex = encode(&op);
        assert!(hex.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(decode(&hex), Some(op));
    }

    #[test]
    fn the_json_shape_is_the_frontends() {
        let op: ElevatedOp =
            serde_json::from_str(r#"{"kind":"rename","path":"a","newName":"b"}"#).unwrap();
        assert_eq!(
            op,
            ElevatedOp::Rename {
                path: "a".into(),
                new_name: "b".into()
            }
        );
        let op: ElevatedOp = serde_json::from_str(r#"{"kind":"createFolder","dir":"d"}"#).unwrap();
        assert_eq!(op, ElevatedOp::CreateFolder { dir: "d".into() });
    }

    #[test]
    fn garbage_does_not_decode() {
        assert_eq!(decode("zz"), None);
        assert_eq!(decode("abc"), None);
        assert_eq!(decode(&"7b".repeat(3)), None);
    }

    #[test]
    fn a_normal_start_is_not_the_helper() {
        assert_eq!(helper_main(&["trove.exe".into()]), None);
        assert_eq!(helper_main(&["trove.exe".into(), r"C:\docs".into()]), None);
    }

    #[test]
    fn the_helper_runs_one_op_and_writes_its_answer() {
        let d = tmp("helper");
        let out = d.join("result.json");
        let op = ElevatedOp::CreateFolder {
            dir: d.to_string_lossy().into_owned(),
        };
        let args = vec![
            "trove.exe".into(),
            OP_ARG.into(),
            encode(&op),
            RESULT_ARG.into(),
            out.to_string_lossy().into_owned(),
        ];
        assert_eq!(helper_main(&args), Some(0));
        let made = read_outcome(&out, 0).unwrap();
        assert!(Path::new(&made).is_dir());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_failed_op_exits_1_with_the_error() {
        let d = tmp("fail");
        let out = d.join("result.json");
        let op = ElevatedOp::Rename {
            path: d.join("missing.txt").to_string_lossy().into_owned(),
            new_name: "x.txt".into(),
        };
        let args = vec![
            "t".into(),
            OP_ARG.into(),
            encode(&op),
            RESULT_ARG.into(),
            out.to_string_lossy().into_owned(),
        ];
        assert_eq!(helper_main(&args), Some(1));
        assert!(read_outcome(&out, 1).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unreadable_op_is_an_error_not_a_normal_start() {
        let d = tmp("bad");
        let out = d.join("result.json");
        let args = vec![
            "t".into(),
            OP_ARG.into(),
            "nothex".into(),
            RESULT_ARG.into(),
            out.to_string_lossy().into_owned(),
        ];
        assert_eq!(helper_main(&args), Some(1));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_missing_answer_names_the_exit_code() {
        let err = read_outcome(Path::new("Z:/no/such/answer.json"), 7).unwrap_err();
        assert!(err.contains("exit code 7"), "{err}");
    }

    #[test]
    fn an_empty_delete_is_refused() {
        assert!(perform(&ElevatedOp::Delete { paths: vec![] }).is_err());
    }
}

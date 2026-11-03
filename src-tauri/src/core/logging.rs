//! The runtime log. Until this existed Trove said nothing at all: no plugin, one `println!`
//! and it sat inside a `#[test]`, and 40 commands returning `Result<_, String>` whose error
//! the frontend threw away. A bug that only happens on someone's machine was not debuggable,
//! only guessable — see `docs/plans/07-the-log-and-four-bugs.md`.
//!
//! Two targets, deliberately. **Stdout** so `tauri dev` shows it live, and a rolling **file**
//! in the OS app-log dir so a shipped build still leaves something to read afterwards.
//! ⛔ Never a target inside the repo: the log must not become a file the gate or a commit can
//! pick up.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri_plugin_log::{Builder, Target, TargetKind};

/// The file in the app-log dir. Windows puts it under
/// `%LOCALAPPDATA%\com.joyahmed.trove\logs\`.
const LOG_FILE: &str = "trove";

/// Keep the tail of a long session without letting the file grow without bound. A folder walk
/// or a drag logs steadily, so this is sized for "a day of use", not for a single incident.
const MAX_FILE_BYTES: u128 = 4 * 1024 * 1024;

/// ⛔ **The level gate is a privacy decision, not a verbosity one.** Full paths are personal,
/// and this file is the one Joy would attach to a bug report. Paths belong at `debug`, which
/// a release build does not record; `info` and above must stay safe to hand to someone else.
/// `A.4` of the plancheck. Keep new call sites on that side of the line.
#[cfg(debug_assertions)]
const LEVEL: log::LevelFilter = log::LevelFilter::Debug;
#[cfg(not(debug_assertions))]
const LEVEL: log::LevelFilter = log::LevelFilter::Info;

/// The configured plugin, ready for `.plugin(...)`.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir {
                file_name: Some(LOG_FILE.into()),
            }),
        ])
        .max_file_size(MAX_FILE_BYTES)
        .level(LEVEL)
        // ⛔ Do NOT add `.level_for("webview", …)` here. The plugin records everything the
        // frontend logs under the `webview` target, so raising that target's floor silently
        // drops the frontend half of the log — which is the half this phase exists to add.
        // Written that way first: the Rust lines appeared, the frontend's did not, and the
        // filter looked like a broken IPC path for a good while.
        //
        // ⚠️ `tao` is a different case and safe to quieten: it is the windowing crate, neither
        // our code nor the webview, and in a dev build it emits a steady
        // "NewEvents emitted without explicit RedrawEventsCleared" that buries our own lines.
        // A warning from it still gets through.
        .level_for("tao", log::LevelFilter::Warn)
        .build()
}

/// Write a panic where it can be read, **before** the process goes.
///
/// ⛔ `[profile.release]` sets `panic = "abort"`, so a panic does not unwind: nothing that
/// relies on `Drop` or an unwind handler to flush ever runs. Without this hook a release-build
/// panic is exactly as invisible as the silence this module exists to end. Installed from
/// `run()` before the builder, so it covers setup too.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let where_ = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".into());
        // `payload_as_str` is not stable on this toolchain; the two common payload types are.
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".into());
        log::error!("panic at {where_}: {what}");
        // Keep the default hook's stderr output — `tauri dev` and a terminal build still show
        // the backtrace, which is more than this line carries.
        previous(info);
    }));
}

/// The facts a bug report needs and nobody can reconstruct afterwards, written once at start.
///
/// ⚠️ Elevation is here for a reason. `docs/plans/07` B.2 lists "Windows launches Trove with a
/// different token when it is the default handler, so it reads a different user's Recycle Bin"
/// as a hypothesis for the bin that reported a delete it had not done. It is a *weak* one —
/// registration is HKCU-only and needs no elevation — and one line here retires or confirms it
/// instead of it being argued about. `info`: no paths and no user name (a name is
/// personal too), safe to hand to someone else (A.4).
pub fn log_environment() {
    log::info!(
        "trove {} starting — elevated {}",
        env!("CARGO_PKG_VERSION"),
        is_elevated()
            .map(|b| b.to_string())
            .unwrap_or_else(|| "unknown".into())
    );
}

/// When `run()` began: the zero of the start-time line (plan 21 gap 6). Set by `mark_start`,
/// first thing in `run()`; the OS loader's time before `main` is not in it.
static STARTED: OnceLock<Instant> = OnceLock::new();

/// One start-time line per process: a second window, or a webview reload, says nothing.
static PAINT_LOGGED: AtomicBool = AtomicBool::new(false);

/// Start the clock that `first_paint` reads. Called once, first thing in `run()`.
pub fn mark_start() {
    let _ = STARTED.get_or_init(Instant::now);
}

/// The start-time line, `starting → first folder painted`, in ms. `what` is the kind of view
/// (`folder`, `home`, `this-pc`, `archive`) and `rows` how many it drew — no path, so `info` (A.4).
/// `None` when it was already said, or the clock never started; the line itself otherwise.
pub fn first_paint(what: &str, rows: usize) -> Option<String> {
    let started = *STARTED.get()?;
    if PAINT_LOGGED.swap(true, Ordering::SeqCst) {
        return None;
    }
    let line = paint_line(started.elapsed(), what, rows);
    log::info!("{line}");
    Some(line)
}

/// The words of the line, apart so a test can read them without the process-wide latch.
fn paint_line(elapsed: Duration, what: &str, rows: usize) -> String {
    // the frontend's word, trimmed to a short token: a log line must not carry free text
    let what: String = what
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(16)
        .collect();
    format!(
        "startup: first {what} painted {} ms after starting ({rows} rows)",
        elapsed.as_millis()
    )
}

/// Whether this process runs with an elevated token. `None` when the question cannot be asked.
#[cfg(windows)]
fn is_elevated() -> Option<bool> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `token` is a live handle slot the call fills in; the process handle is a
    // pseudo-handle that needs no closing.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut size = 0u32;
    // SAFETY: the out-buffer is a live TOKEN_ELEVATION of the stated size.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            u32::try_from(std::mem::size_of::<TOKEN_ELEVATION>()).unwrap_or(0),
            &mut size,
        )
    };
    // SAFETY: `token` came from OpenProcessToken above and is not used after this.
    unsafe { CloseHandle(token) };
    (ok != 0).then_some(elevation.TokenIsElevated != 0)
}

#[cfg(not(windows))]
fn is_elevated() -> Option<bool> {
    None
}

/// An error crossing the IPC boundary, logged on the Rust side as it goes.
///
/// ⚠️ The frontend discards most of these — 12 `catch {}` blocks bind nothing at all, and the
/// rest raise a toast that fades. Logging here means a failed command leaves a trace even when
/// nothing downstream keeps it. `command` is the command name, so a log line says which.
pub fn command_err<T, E: std::fmt::Display>(command: &str, r: Result<T, E>) -> Result<T, E> {
    if let Err(e) = &r {
        log::error!("{command}: {e}");
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hook must not itself panic on either payload shape, and must leave the previous
    /// hook running — a panic inside a panic hook aborts with nothing said at all.
    #[test]
    fn the_panic_hook_handles_both_payload_shapes() {
        install_panic_hook();
        let str_payload = std::panic::catch_unwind(|| panic!("a &str payload"));
        assert!(str_payload.is_err());
        let string_payload =
            std::panic::catch_unwind(|| panic!("{}", String::from("a String payload")));
        assert!(string_payload.is_err());
        let _ = std::panic::take_hook();
    }

    #[test]
    fn the_paint_line_says_ms_and_keeps_only_a_short_token() {
        let line = paint_line(Duration::from_millis(412), "folder", 37);
        assert_eq!(
            line,
            "startup: first folder painted 412 ms after starting (37 rows)"
        );
        let odd = paint_line(
            Duration::from_millis(5),
            r"C:\Users\me this-pc-and-much-more",
            0,
        );
        assert!(!odd.contains('\\'), "{odd}");
        assert!(
            odd.starts_with("startup: first CUsersmethis-pc- painted 5 ms"),
            "{odd}"
        );
    }

    #[test]
    fn first_paint_is_said_once_per_process() {
        mark_start();
        let first = first_paint("home", 3);
        let second = first_paint("folder", 9);
        // another test in this binary may have said it first; either way never twice
        assert!(first.is_none() || first.as_deref().is_some_and(|l| l.contains("first home")));
        assert!(second.is_none());
    }

    #[test]
    fn command_err_passes_both_outcomes_through_unchanged() {
        let ok: Result<u8, String> = command_err("t", Ok(7));
        assert_eq!(ok, Ok(7));
        let err: Result<u8, String> = command_err("t", Err("boom".into()));
        assert_eq!(err, Err("boom".into()));
    }
}

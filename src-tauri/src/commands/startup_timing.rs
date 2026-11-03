//! The start-time line (plan 21 gap 6). Mirrors `src/lib/api/startup-timing.ts`.
use crate::core::logging;

/// The frontend has painted its first view: log how long after `starting` that was, once.
/// `what` is the view's kind, `rows` how many it drew; never a path (A.4).
#[tauri::command(async)]
pub fn startup_painted(what: String, rows: usize) {
    let _ = logging::first_paint(&what, rows);
}

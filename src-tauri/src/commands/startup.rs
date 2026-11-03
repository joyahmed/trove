use crate::core::startup;

fn msg<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Start at login on or off: the `Run` key on Windows, a LaunchAgent on macOS, an autostart
/// `.desktop` file on Linux. The command keeps its old name; the frontend calls it by that.
#[tauri::command(async)]
pub fn set_start_with_windows(on: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(msg)?;
    startup::set_login_entry(on, &exe).map_err(msg)
}

#[tauri::command(async)]
pub fn start_with_windows() -> bool {
    startup::login_entry_exists()
}

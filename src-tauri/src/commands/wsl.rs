use crate::core::wsl::{self, WslDistro};

/// Installed distros, from the registry. Spawns nothing.
#[tauri::command(async)]
pub fn wsl_distros() -> Vec<WslDistro> {
    wsl::distros()
}

/// The distro's entry point (its default user's home) as a UNC path. Starts the distro.
#[tauri::command(async)]
pub fn wsl_home(name: String, uid: u32) -> String {
    wsl::home(&name, uid)
}

/// "Open in Terminal" at a Windows or WSL path.
#[tauri::command(async)]
pub fn open_terminal(path: String) -> Result<(), String> {
    wsl::open_terminal(&path).map_err(|e| e.to_string())
}

/// The distros running right now; never starts one. A This PC search covers these.
#[tauri::command(async)]
pub fn wsl_running_distros() -> Vec<String> {
    crate::core::wsl_search::running_distros()
}

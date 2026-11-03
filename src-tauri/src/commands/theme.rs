use crate::core::theme::{self, SystemTheme};

/// The system accent colour and whether transparency effects are on. Read once on mount.
#[tauri::command(async)]
pub fn system_theme() -> SystemTheme {
    theme::system_theme()
}

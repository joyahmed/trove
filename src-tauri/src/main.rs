// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // "Retry as administrator": do the one operation and exit, no window (plan 05 5.6)
    if let Some(code) = trove_lib::elevated_entry() {
        std::process::exit(code);
    }
    trove_lib::run()
}

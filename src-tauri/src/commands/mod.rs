//! `#[tauri::command]` surface. Thin: parse arguments, call `core`, map errors to strings the
//! frontend can show. Each file mirrors one `src/lib/api/<domain>.ts`.
//!
//! **Every command here is `#[tauri::command(async)]` unless it touches a window, a menu or
//! the tray.** A plain `#[tauri::command]` runs its body on the main thread — the same thread
//! that pumps the window's message loop — so anything that waits on the disk, the registry,
//! the shell or the network freezes the whole UI while it runs. That is invisible on a
//! developer's machine (warm caches, one local SSD) and brutal on a tester's (a mapped drive
//! that is gone, an empty card reader, a cold icon cache): `read_dir`, `drives` and
//! `spotlight_apps` were all blocking the first paint. `(async)` keeps the body synchronous
//! and moves it onto the async runtime's thread pool.
//!
//! The exceptions — `tray::*` and the window half of `spotlight::*` — must stay on the main
//! thread: Win32 windows and menus belong to the thread that created them.

#[cfg(target_os = "macos")]
pub mod app_menu;
pub mod archive;
pub mod default_handler;
#[cfg(target_os = "macos")]
pub mod dock;
pub mod fs;
pub mod gallery;
pub mod image_dims;
pub mod index;
pub mod index_settings;
pub mod launch;
pub mod lockers;
pub mod open_with;
pub mod preview;
pub mod props;
pub mod pty;
pub mod recent;
pub mod recycle;
pub mod search;
pub mod session;
pub mod settings;
pub mod shell;
pub mod shell_verbs;
pub mod spotlight;
pub mod startup;
pub mod startup_timing;
pub mod theme;
pub mod transfer;
pub mod tray;
pub mod undo_log;
pub mod uninstall;
pub mod updater;
pub mod watch;
pub mod window_layout;
pub mod windows;
pub mod wsl;

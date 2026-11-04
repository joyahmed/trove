#[cfg(any(all(unix, not(target_os = "macos")), test))]
pub mod apps_linux;
#[cfg(any(target_os = "macos", test))]
pub mod apps_mac;
pub mod archive;
// Which store this build ships through (plan 22): `direct` or `msstore`, fixed at compile time.
pub mod channel;
pub mod clipboard;
pub mod default_handler;
#[cfg(any(all(unix, not(target_os = "macos")), test))]
pub mod default_handler_linux;
pub mod drag_out;
pub mod folder_sizes;
pub mod frame;
pub mod fs;
pub mod gallery;
pub mod helper_windows;
// GNOME shortcuts that already hold the Spotlight chord (plan 15 D.5.2). A stub off Linux.
pub mod hotkey_conflicts;
pub mod icons;
pub mod image_dims;
// Off Windows: image thumbnails decoded in Rust (plan 14.2). In tests on every OS.
#[cfg(any(not(windows), test))]
pub mod image_thumbs;
// Trove's own file-name index (plan 21C): the home folder in memory, kept live by a watcher.
pub mod index;
pub mod key_menu;
pub mod keys;
pub mod known_apps;
pub mod launch;
pub mod lockers;
pub mod logging;
// The minimum window size is the inside size on Windows too (tao counts it on the outside).
pub mod elevate;
pub mod min_size;
pub mod mounts;
pub mod net;
pub mod ops;
// "Open with" (plan 15 G.61): shared shape and Windows here, the Mac and Linux sources beside.
pub mod open_with;
#[cfg(any(all(unix, not(target_os = "macos")), test))]
pub mod open_with_linux;
#[cfg(any(target_os = "macos", test))]
pub mod open_with_mac;
pub mod os_limited;
// The journal of moves parked beside their target, recovered at start after a crash.
pub mod parked;
pub mod places_unix;
pub mod preview;
// macOS: the privacy-guarded home folders (TCC) and which ones the person has opened.
pub mod privacy_folders;
// macOS: QuickLook thumbnails for HEIC, TIFF and video, which the Rust decoders cannot read.
pub mod props;
pub mod pty;
pub mod pty_cwd;
#[cfg(target_os = "macos")]
pub mod quicklook;
pub mod recent;
pub mod recycle;
#[cfg(any(target_os = "linux", test))]
pub mod reduced_motion;
// The macOS Trash read as a folder (`~/.Trash`). In tests on every OS.
#[cfg(any(target_os = "macos", test))]
pub mod recycle_mac;
pub mod registry;
pub mod search;
pub mod session;
pub mod settings;
pub mod shell;
pub mod shell_menu;
pub mod shell_verbs;
pub mod spotlight;
pub mod startup;
pub mod sync_root;
pub mod sys_menu;
pub mod theme;
pub mod thumbs;
pub mod transfer;
// The macOS move to the Trash: Finder, then the file manager when Apple Events are denied; each
// records where the item landed, so ⌘Z can put it back.
#[cfg(any(target_os = "macos", test))]
pub mod trash_mac;
// What can be uninstalled and how (plan 18). Parsers are pure and tested on every OS; only the
// live reads and the LiveLauncher are cfg'd inside.
pub mod undo_log;
pub mod uninstall;
pub mod uninstall_linux;
#[cfg(any(target_os = "macos", test))]
pub mod uninstall_mac;
pub mod uninstall_windows;
pub mod volume;
pub mod watch;
pub mod window_layout;
pub mod workers;
pub mod wsl;
pub mod wsl_search;
// Self-update for the GitHub downloads (plan 22.5), behind the cargo feature `updater`.
pub mod updater;

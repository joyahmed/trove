//! Tauri entry. Commands live in `commands/`, logic in `core/` — see CONTRIBUTING.md.

use tauri::{Emitter, Manager};

mod commands;
mod core;
#[cfg(test)]
mod ipc_contract;

/// Event name a second launch is delivered on; the payload is a `core::launch::Launch`.
pub const LAUNCH_EVENT: &str = "launch";

/// How long the main window waits for the frontend to show it before showing itself. Long
/// enough that a cold start on a slow disk still reveals a painted window, short enough that
/// a broken frontend is a visible bug rather than a process with no window at all.
const REVEAL_BACKSTOP_MS: u64 = 4000;

/// `icon://ext/<ext>?size=16` and `icon://file/<url-encoded path>?size=32` → PNG. The
/// webview sees it as `http://icon.localhost/…`. Answered off the webview thread because a
/// first lookup for an extension asks the shell; after that it is a cache read. On a pool
/// thread (`core::workers`), never a fresh one: a scroll through a large folder asks for
/// thousands of these at once.
fn icon_response(
    cache_dir: &std::path::Path,
    uri: &tauri::http::Uri,
) -> tauri::http::Response<Vec<u8>> {
    let Some((key, size)) = core::icons::parse_icon_request(uri.path(), uri.query()) else {
        return icon_ok_response(None);
    };
    let Some(path) = core::icons::key_path(&key).map(str::to_owned) else {
        return icon_ok_response(core::icons::icon_body(cache_dir, &key, size));
    };
    // plan 08 D1: a picture of a file on a share waits for the server, so it gets the probe
    // deadline, and a share that just missed one is not asked again per row; 503 draws the
    // fallback glyph, as for a shed request
    let cache_dir = cache_dir.to_path_buf();
    match core::workers::guarded_unless_dead("icon", &path, core::workers::PROBE_WAIT, move || {
        core::icons::icon_body(&cache_dir, &key, size)
    }) {
        Ok(body) => icon_ok_response(body),
        Err(_) => icon_busy_response(),
    }
}

/// 200 with the body's one content type (`nosniff`: never guessed), or 404. An SVG also gets a
/// CSP that lets it run nothing should it ever be opened as a document rather than an `<img>`.
/// Only a real answer (`true`) is kept for a day; a stand-in for a thumbnail the shell could not
/// make, or the picture of a file still arriving, is `no-store` like the 404 (B.5.5).
fn icon_ok_response(body: Option<(core::icons::IconBody, bool)>) -> tauri::http::Response<Vec<u8>> {
    let builder = tauri::http::Response::builder();
    match body {
        Some((body, real)) => {
            let builder = builder
                .status(200)
                .header("Content-Type", body.content_type())
                .header("X-Content-Type-Options", "nosniff")
                .header(
                    "Cache-Control",
                    if real { "max-age=86400" } else { "no-store" },
                );
            let builder = match body {
                core::icons::IconBody::Svg(_) => builder.header(
                    "Content-Security-Policy",
                    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                ),
                core::icons::IconBody::Png(_) => builder,
            };
            builder.body(body.bytes().to_vec())
        }
        // never cached: a file still being written, locked or undecodable answers 404 now and
        // may answer 200 a moment later, so the webview must not remember the failure
        None => builder
            .status(404)
            .header("Cache-Control", "no-store")
            .body(Vec::new()),
    }
    .expect("a static response builds")
}

/// The answer for an image request the pool shed (`core::workers::Fate::Shed`): 503 and never
/// cached, so the `<img>` fails now and asks again the next time it is mounted, instead of
/// keeping a blank the browser remembers for a day like a real answer.
fn icon_busy_response() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(503)
        .header("Cache-Control", "no-store")
        .body(Vec::new())
        .expect("a static response builds")
}

/// The page origin that may read `preview://` answers across origins on Linux (measured).
#[cfg(any(target_os = "linux", test))]
const APP_ORIGIN: &str = "tauri://localhost";

/// The value for `Access-Control-Allow-Origin`: the request's `Origin` when it is Trove's own
/// page, otherwise nothing (no header, so the browser refuses the read).
#[cfg(any(target_os = "linux", test))]
fn cors_allowed_origin(origin: Option<&str>) -> Option<&'static str> {
    origin.filter(|o| *o == APP_ORIGIN).map(|_| APP_ORIGIN)
}

/// `preview://file/<url-encoded path>` → the file's bytes with its content type, whole or the
/// requested `Range` (206), for the preview pane's `<img>` / `<video>` / `<iframe>`. The
/// webview sees it as `http://preview.localhost/…`.
fn preview_response(
    uri: &tauri::http::Uri,
    range: Option<&str>,
    origin: Option<&str>,
) -> tauri::http::Response<Vec<u8>> {
    let path = uri
        .path()
        .trim_start_matches('/')
        .strip_prefix("file/")
        .filter(|p| !p.is_empty())
        .map(core::icons::percent_decode);
    let builder = tauri::http::Response::builder();
    let Some(path) = path else {
        return builder
            .status(404)
            .body(Vec::new())
            .expect("a static response builds");
    };
    let served = core::preview::serve(std::path::Path::new(&path), range);
    let mut builder = builder
        .status(served.status)
        .header("Content-Type", served.content_type)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", served.body.len().to_string());
    if let Some(cr) = served.content_range {
        builder = builder.header("Content-Range", cr);
    }
    // Linux plays media from a blob the page `fetch`es here (WebKitGTK's player cannot load a
    // custom scheme, `media-src.ts`), and the page's origin is not this one. Only Trove's own
    // page may read the answer, never any other origin.
    #[cfg(target_os = "linux")]
    {
        builder = builder.header("Vary", "Origin");
        if let Some(allowed) = cors_allowed_origin(origin) {
            builder = builder.header("Access-Control-Allow-Origin", allowed);
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = origin;
    builder.body(served.body).expect("a static response builds")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// The one-shot elevated helper (`core/elevate.rs`): when the exe was started with
/// `--elevated-op`, do that one operation and return its exit code, before anything else starts.
pub fn elevated_entry() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    core::elevate::helper_main(&args)
}

pub fn run() {
    // the zero of the start-time line (plan 21 gap 6)
    core::logging::mark_start();
    // Before the builder, so a panic during setup is still written somewhere. Release builds
    // abort rather than unwind, so nothing that waits for a `Drop` would ever run.
    core::logging::install_panic_hook();
    with_app_menu(tauri::Builder::default())
        // The log first of all, so everything after it can say what went wrong.
        .plugin(core::logging::plugin())
        // Must be registered first among the behavioural plugins: it decides whether this
        // process lives at all.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // what Chrome's "Show in folder", VS Code's Reveal and others actually send
            // a count at info, the paths only at debug (plan 15 D.8.2: release logs no paths)
            log::info!("launch: {} arg(s)", argv.len());
            log::debug!("launch argv {argv:?}");
            let launch = core::launch::parse(
                argv.get(1..).unwrap_or_default(),
                std::path::Path::new(&cwd),
            );
            // Decided before `show_main`, which rebuilds a `main` that is gone: a new one must
            // get THIS launch from `initial_launch`, not the process's first argv (D.3.4).
            let main_exists = app.get_webview_window("main").is_some();
            let to_emit = app
                .state::<commands::launch::LaunchGate>()
                .0
                .lock()
                .map(|mut g| g.second_launch(main_exists, launch.clone()))
                .unwrap_or(Some(launch));
            // a hidden resident window comes back on Win+E / a second launch
            commands::tray::show_main(app);
            if let Some(launch) = to_emit {
                let _ = app.emit(LAUNCH_EVENT, launch);
            }
        }))
        .manage(commands::tray::Residency(std::sync::Mutex::new(None)))
        .manage(commands::launch::LaunchGate::default())
        .manage(core::index::Index::default())
        .manage(core::updater::Pending::default())
        .setup(|app| {
            core::logging::log_environment();
            // Self-update (plan 22.5): only a `--features updater` build registers the plugin;
            // `start` is a no-op otherwise, and until the public key is set (22.5.1).
            #[cfg(feature = "updater")]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            core::updater::start(app.handle());
            // Windows: the hidden helper windows (event loop, single instance, hotkey) ignore a
            // stray WM_CLOSE instead of dying with it — see `core::helper_windows`.
            core::helper_windows::guard_on_main(app.handle());
            // GNOME's Reduce animation, live: WebKitGTK re-applies its media query only on a
            // resize, so the GTK setting is watched here and written onto the page.
            #[cfg(target_os = "linux")]
            core::reduced_motion::watch(app.handle());
            // Old open-inside-an-archive copies (plan 16 Phase 4): only those older than 7
            // days and untouched since Trove wrote them; a copy the person changed is kept.
            if let Some(root) = commands::archive::open_cache_root(app.handle()) {
                std::thread::spawn(move || {
                    core::archive::index::clean_open_cache(
                        &root,
                        std::time::SystemTime::now(),
                        core::archive::index::OPEN_CACHE_MAX_AGE,
                    );
                });
            }
            // A Replace by move parks the file beside its target for a moment; one a crash left
            // hidden there is renamed to be seen (never deleted). Only the entries there now are
            // touched, on a thread of their own while jobs may already run (`recover_at_start`).
            if let Ok(data_dir) = app.path().app_local_data_dir() {
                core::parked::recover_at_start(&data_dir);
            }
            // The name index (plan 21C): the home folder, then each fixed local drive the
            // person left on, walked on background-priority threads so it never holds up startup
            // or a listing; the palette walks a root as before until that root is ready. Saved in
            // the same folder Settings' Forget empties (`index_settings::index_dir`).
            // Mac: which privacy-guarded folders the person has opened (`core::privacy_folders`)
            // — before the index, which must not read inside the others.
            if let Ok(config_dir) = app.path().app_config_dir() {
                core::privacy_folders::load(&config_dir);
            }
            let settings = commands::index_settings::current(app.handle());
            core::index::start_with(
                &app.state::<core::index::Index>(),
                core::index::Startup {
                    home: core::shell::user_profile(),
                    drives: settings.drives(),
                    skip_folders: settings.skip_folders.clone(),
                    enabled: settings.on,
                    index_dir: commands::index_settings::index_dir(app.handle()).ok(),
                    guarded: core::privacy_folders::all(),
                    opened: core::privacy_folders::opened(),
                },
            );
            // Trim the thumbnail cache on disk, off the startup path: it walks the whole cache
            // folder, and nothing needs it finished — a PNG pruned while being read is simply
            // drawn again.
            if let Ok(cache_dir) = app.path().app_local_data_dir() {
                std::thread::spawn(move || {
                    let removed =
                        core::icons::prune_disk_cache(&cache_dir, core::icons::DISK_CAP_BYTES);
                    if removed > 0 {
                        log::info!("icon cache: removed {removed} old files");
                    }
                });
            }
            // Windows' right-click items: warm the shell worker once, a few seconds in, so
            // the first right-click is not the one that pays for COM and handler loading
            #[cfg(windows)]
            std::thread::spawn(|| {
                std::thread::sleep(core::shell_menu::PREWARM_DELAY);
                core::shell_menu::prewarm();
            });
            // ⛔ `main` is the one explorer window `build_explorer_window` does NOT make — it
            // comes from `tauri.conf.json` — so it is handed the same DWM treatment here, before
            // the `--hidden` return below, or a resident start would reveal a window with a
            // border that `main-2` does not have. See `core::frame`.
            if let Some(main) = app.get_webview_window("main") {
                core::frame::suppress_dwm_border(&main);
                core::sys_menu::guard(&main);
                // 800x500 is the page, not the frame around it (`core::min_size`)
                core::min_size::guard(&main);
                core::frame::set_window_icon(&main);
                // Alt+Space goes to a listening shortcut recorder, not the window menu
                core::key_menu::guard(&main);
                // what a drag OUT of it later needs to have been watching (`core::drag_out`)
                core::drag_out::prepare_window(&main);
                // where it was last run, even with Restore tabs off (as Explorer). Still hidden,
                // so a maximize waits for its first show: maximizing it here would show it
                if let Some(bounds) = commands::session::restore_bounds(app.handle(), "main", None)
                {
                    commands::windows::apply_bounds(&main, bounds);
                    if bounds.maximized {
                        commands::windows::maximize_when_shown(&main);
                    }
                }
                // its glass follows the window's appearance: the saved theme before it shows
                #[cfg(target_os = "macos")]
                if let Err(e) = main.set_theme(commands::settings::saved_window_theme(app.handle()))
                {
                    log::warn!("main: could not set the window theme: {e}");
                }
            }
            // The main window is built hidden (`visible: false` in tauri.conf.json) and the
            // frontend shows it once the first listing is on screen — a transparent,
            // undecorated window that appears before the webview has painted is an empty
            // rectangle, and that is what "it freezes on launch" looked like.
            //
            // `--hidden` (the "start with Windows" entry) stays in the tray instead; the
            // frontend shows the window anyway if its settings say the app is not resident.
            let args: Vec<String> = std::env::args().skip(1).collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            if core::launch::parse_own(&args, &cwd).hidden {
                return Ok(());
            }
            // Backstop: a frontend that fails to boot must not leave a process with no window.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(REVEAL_BACKSTOP_MS));
                commands::tray::show_main(&handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // resident: closing the main window hides it; the tray's Quit ends the process
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" && commands::tray::is_resident_now(window.app_handle())
                {
                    api.prevent_close();
                    // its place first: hidden, it saves none, and a move in the debounce is lost
                    commands::session::save_bounds_now(window);
                    let _ = window.hide();
                }
            }
            // ⛔ Not resident and the last explorer window is gone: END the process.
            //
            // Tauri exits when the last window closes, but `palette` is a window — a hidden,
            // always-on-top strip that lives for the whole session. So closing the only
            // explorer window left a process with no explorer window, a hidden palette, the
            // hotkey listener and the single-instance receiver: alive, responding, and unable
            // to show anything. Every later launch was handed to it and vanished. That is the
            // four-hour incident in plancheck 8 §G, and `keepRunning: false` with the default
            // handler unapplied — the shipped default — is all it takes to reach it.
            //
            // ⚠️ `main-2`, `main-3` … must each keep the app alive, so this counts the
            // explorer windows rather than testing for `main`; and it excludes the dying one
            // by NAME, because whether the manager has dropped it yet is a timing detail.
            tauri::WindowEvent::Destroyed => {
                // before the exit decision: closed on its own, a window is not restored next start
                commands::session::on_window_destroyed(window.app_handle(), window.label());
                commands::windows::exit_if_last_explorer_window(
                    window.app_handle(),
                    window.label(),
                );
            }
            _ => {}
        })
        .plugin(tauri_plugin_opener::init())
        // What This PC is called on this OS, set on `window` before any page script runs
        // (plan 10, B.2.3): every window, including detached tabs and the palette.
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("trove-platform")
                .js_init_script(core::shell::platform_init_script())
                .build(),
        )
        // Spotlight: the chord itself is registered by the main window (register_hotkey) so a
        // clash is a notice, not a failed start.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(commands::spotlight::on_shortcut)
                .build(),
        )
        .on_window_event(commands::spotlight::on_window_event)
        // A third listener, and that is fine: `tauri-2.11.x` appends them rather than replacing
        // (app.rs:2056). This one kills the terminal shells a destroyed window owned — see
        // `commands::pty`, which is also where the re-entry note lives, because `app.exit`
        // destroys every remaining window and each fires `Destroyed` again.
        .on_window_event(commands::pty::on_window_event)
        // and a fourth: each explorer window's size and place, saved as it moves (plan 15 G.45)
        .on_window_event(commands::session::on_window_event)
        .register_asynchronous_uri_scheme_protocol("icon", |ctx, request, responder| {
            let cache_dir = ctx
                .app_handle()
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            // Laned by URL alone (no I/O on the webview's thread): `ext/` icons must never
            // queue behind a burst of thumbnails, and thumbnails are served newest first with
            // the oldest dropped past a cap — see `core::workers`.
            match core::icons::lane_of(request.uri().path()) {
                core::icons::IconLane::Quick => core::workers::spawn(move || {
                    responder.respond(icon_response(&cache_dir, request.uri()))
                }),
                lane => {
                    core::workers::spawn_slow(lane == core::icons::IconLane::Image, move |fate| {
                        responder.respond(match fate {
                            core::workers::Fate::Run => icon_response(&cache_dir, request.uri()),
                            core::workers::Fate::Shed => icon_busy_response(),
                        })
                    })
                }
            }
        })
        .register_asynchronous_uri_scheme_protocol("preview", |_ctx, request, responder| {
            // a small pool, not a thread per request: a seeking `<video>` fires Range requests
            // in bursts, and each one holds up to a chunk of the file in memory
            core::workers::spawn_preview(move || {
                let range = request
                    .headers()
                    .get("range")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                let origin = request
                    .headers()
                    .get("origin")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                responder.respond(preview_response(
                    request.uri(),
                    range.as_deref(),
                    origin.as_deref(),
                ));
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_dir,
            commands::fs::palette_folder_count,
            commands::fs::unopened_guarded_folders,
            commands::fs::allow_guarded_folders,
            commands::fs::open_path,
            commands::open_with::open_with_apps,
            commands::open_with::open_with_app,
            commands::open_with::open_with_dialog,
            commands::fs::open_url,
            commands::fs::rename_entry,
            commands::fs::retry_elevated,
            commands::fs::create_folder,
            commands::fs::trash_entries,
            commands::fs::create_file,
            commands::fs::delete_entries,
            commands::lockers::who_is_locking,
            commands::lockers::end_locking_app,
            commands::startup_timing::startup_painted,
            commands::fs::compress_entries,
            commands::shell::drives,
            commands::shell::known_folders,
            commands::shell::user_profile,
            commands::shell::one_drive_root,
            commands::recent::recent_files,
            commands::image_dims::image_dimensions,
            commands::fs::path_kind,
            commands::fs::net_sign_in,
            commands::fs::set_cloud_pin,
            commands::fs::cloud_sync_status,
            commands::fs::mapped_drives,
            commands::theme::system_theme,
            commands::launch::initial_launch,
            commands::settings::read_settings,
            commands::settings::write_settings,
            commands::settings::merge_settings,
            commands::undo_log::read_undo_log,
            commands::undo_log::write_undo_log,
            commands::session::save_window_tabs,
            commands::session::take_last_session,
            commands::session::hold_windows,
            commands::wsl::wsl_distros,
            commands::wsl::wsl_home,
            commands::wsl::open_terminal,
            commands::wsl::wsl_running_distros,
            commands::transfer::transfer_conflicts,
            commands::transfer::start_transfer,
            commands::transfer::cancel_transfer,
            commands::transfer::remove_moved_originals,
            commands::transfer::remove_emptied_folders,
            commands::transfer::restore_from_trash,
            commands::transfer::undo_replace,
            commands::transfer::replace_no_bin,
            commands::transfer::bin_readable,
            commands::transfer::clipboard_write_paths,
            commands::transfer::clipboard_write_paths_text,
            commands::transfer::clipboard_write_text,
            commands::transfer::drag_out,
            commands::transfer::drop_modifiers,
            commands::transfer::same_volume,
            commands::transfer::folder_space,
            commands::transfer::clipboard_read_paths,
            commands::archive::archive_conflicts,
            commands::archive::start_extract,
            commands::archive::start_extract_here,
            commands::archive::start_compress,
            commands::archive::read_archive_dir,
            commands::archive::start_open_inner,
            commands::watch::watch_path,
            commands::watch::unwatch_path,
            commands::search::start_search,
            commands::search::cancel_search,
            commands::props::file_props,
            commands::props::set_file_attributes,
            commands::props::start_folder_totals,
            commands::props::cancel_folder_totals,
            commands::props::folder_drive_kind,
            commands::props::start_folder_sizes,
            commands::preview::read_text_head,
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::pty::pty_follow,
            commands::default_handler::default_handler_status,
            commands::default_handler::default_handler_info,
            commands::default_handler::default_handler_apply,
            commands::default_handler::default_handler_revert,
            commands::tray::set_resident,
            commands::tray::is_resident,
            commands::startup::set_start_with_windows,
            commands::startup::start_with_windows,
            commands::spotlight::register_hotkey,
            commands::spotlight::set_hotkey_recording,
            commands::spotlight::toggle_palette,
            commands::spotlight::hide_palette,
            commands::spotlight::resize_palette,
            commands::spotlight::show_main,
            commands::spotlight::launch_app,
            commands::spotlight::spotlight_apps,
            commands::spotlight::spotlight_files,
            commands::index::index_search,
            commands::index::index_progress,
            commands::index::index_wsl,
            commands::index_settings::index_drives,
            commands::index_settings::index_disk_size,
            commands::index_settings::index_forget,
            commands::gallery::gallery_items,
            commands::shell_verbs::shell_verbs,
            commands::shell_verbs::run_shell_verb,
            commands::shell_verbs::run_custom_command,
            commands::shell_verbs::resolve_custom_program,
            commands::shell_verbs::detect_common_commands,
            commands::shell_verbs::shell_menu,
            commands::shell_verbs::shell_menu_invoke,
            commands::windows::open_window,
            commands::windows::show_window,
            commands::window_layout::snap_window,
            commands::window_layout::arrange_windows,
            commands::recycle::recycle_list,
            commands::recycle::recycle_restore,
            commands::recycle::recycle_purge,
            commands::recycle::recycle_empty,
            commands::recycle::open_in_explorer,
            commands::uninstall::uninstall_list,
            commands::uninstall::uninstall_app,
            commands::uninstall::open_apps_settings,
            commands::updater::update_ready,
            commands::updater::update_restart
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(on_run_event);
}

/// macOS: the menu bar, whose ⌘W closes a tab rather than the window (`commands::app_menu`).
/// Windows and Linux have no app menu, and Tauri sets none there.
fn with_app_menu<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(commands::app_menu::build)
        .on_menu_event(commands::app_menu::on_menu_event);
    builder
}

/// What the run loop's end writes: a move still in the debounce, and the index's unsaved
/// changes so the next start loads them instead of walking. Also called before an update
/// installs (`commands::updater`): on Windows the installer ends Trove with
/// `std::process::exit`, which never reaches the run loop's end.
pub(crate) fn save_on_the_way_out<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    commands::session::save_all_bounds(app);
    if let Some(index) = app.try_state::<core::index::Index>() {
        index.save_all();
    }
}

/// The run loop. `Builder::run` is exactly `build(ctx)?.run(|_, _| {})`, so off a Mac nothing
/// changes; on a Mac the Dock and Finder talk to the app here (`commands::dock`).
fn on_run_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: tauri::RunEvent) {
    // `app.exit(code)` (the tray's Quit, the last window closing) asks with a code: the windows
    // it is about to destroy are the session to restore, not windows closed one by one.
    if let tauri::RunEvent::ExitRequested { code: Some(_), .. } = &event {
        commands::session::quitting(app);
    }
    // the run loop ending, however it was asked to (a Mac's ⌘Q asks nothing): a move still in
    // the debounce is saved before the windows go
    if let tauri::RunEvent::Exit = &event {
        save_on_the_way_out(app);
    }
    #[cfg(target_os = "macos")]
    {
        // Mac convention: the last window closing leaves the app in the Dock. Only a request
        // with no code is the "every window closed" one; `app.exit` (the tray's Quit) carries a
        // code, and ⌘Q goes through `applicationWillTerminate`, which does not ask at all.
        if let tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } = &event
        {
            log::info!("every window closed — staying in the Dock (⌘Q quits)");
            api.prevent_exit();
        }
        commands::dock::on_run_event(app, &event);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

#[cfg(test)]
mod tests {
    use super::{cors_allowed_origin, icon_ok_response};
    use crate::core::icons::IconBody;

    #[test]
    fn icon_responses_carry_exactly_their_content_type() {
        let svg = icon_ok_response(Some((IconBody::Svg(b"<svg/>".to_vec()), true)));
        assert_eq!(svg.status(), 200);
        assert_eq!(svg.headers()["Content-Type"], "image/svg+xml");
        assert_eq!(svg.headers()["X-Content-Type-Options"], "nosniff");
        assert!(svg.headers()["Content-Security-Policy"]
            .to_str()
            .unwrap()
            .starts_with("default-src 'none'"));
        assert_eq!(svg.body(), b"<svg/>");

        let png = icon_ok_response(Some((IconBody::Png(b"png".to_vec().into()), true)));
        assert_eq!(png.headers()["Content-Type"], "image/png");
        assert!(png.headers().get("Content-Security-Policy").is_none());

        // a good image keeps its day of caching; a failed answer is never cached (B.5.5)
        assert_eq!(png.headers()["Cache-Control"], "max-age=86400");
        let failed = icon_ok_response(None);
        assert_eq!(failed.status(), 404);
        assert_eq!(failed.headers()["Cache-Control"], "no-store");
        // a stand-in picture is drawn now but never kept
        let stand_in = icon_ok_response(Some((IconBody::Png(b"png".to_vec().into()), false)));
        assert_eq!(stand_in.status(), 200);
        assert_eq!(stand_in.headers()["Cache-Control"], "no-store");
    }

    #[test]
    fn only_the_apps_own_origin_may_read_preview_answers() {
        assert_eq!(
            cors_allowed_origin(Some("tauri://localhost")),
            Some("tauri://localhost")
        );
        assert_eq!(cors_allowed_origin(Some("https://evil.example")), None);
        assert_eq!(cors_allowed_origin(Some("null")), None);
        assert_eq!(cors_allowed_origin(None), None);
    }
}

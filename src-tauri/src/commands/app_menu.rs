//! macOS only: the menu bar. Tauri's default Mac menu has "Close Window ⌘W", and a menu key
//! equivalent wins over the webview's keydown — so ⌘W closed the whole window instead of the
//! tab. This menu keeps the standard App, Edit, View, Window and Help menus (the predefined
//! Edit items are what make ⌘C / ⌘V / ⌘A work in text fields) and gives File its own items:
//!
//! - **New Tab ⌘T, New Window ⌘N, Close Tab ⌘W** are sent to the focused explorer window as
//!   `MENU_EVENT`, and its frontend runs the same action its keydown table has for the chord
//!   (`menuCommandFor` in `src/lib/data/shortcuts.ts`). Once the menu owns a chord the webview
//!   never sees its keydown, so there is one path and no double fire.
//! - **Close Window ⇧⌘W** closes the focused explorer window, as ⌘W used to.
//! - **Window ▸ Cascade Windows / Stack Windows / Windows Side by Side** (plan 20) arrange every
//!   explorer window on the focused one's monitor (`commands::window_layout::menu_arrange`).
//!
//! Nothing is sent to the Spotlight strip (`palette`): a menu chord while it is focused acts
//! on no explorer window, so ⌘W can no longer close the session-long strip.
//!
//! Windows and Linux never compile this file; they have no app menu.

use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::window_layout::{
    arrange, menu_arrange, MENU_CASCADE, MENU_SIDE_BY_SIDE, MENU_STACKED,
};
use crate::commands::windows::is_explorer_label;

/// Event the focused explorer window receives a menu command on; the payload is the command
/// (`close-tab`, `new-tab`, `new-window`). Mirrors `src/lib/api/menu.ts`.
pub const MENU_EVENT: &str = "menu:command";

// Prefixed: the tray's menu has a `new-tab` item, and menu events are app-wide.
const NEW_TAB: &str = "app-menu:new-tab";
const NEW_WINDOW: &str = "app-menu:new-window";
const CLOSE_TAB: &str = "app-menu:close-tab";
const CLOSE_WINDOW: &str = "app-menu:close-window";

/// What a click on one of our menu items does.
#[derive(Debug, PartialEq)]
pub enum Action<'a> {
    /// Send this command to that explorer window's frontend.
    Emit {
        label: &'a str,
        command: &'static str,
    },
    /// Close that explorer window (its close goes through `CloseRequested` as before).
    CloseWindow(&'a str),
    /// No explorer window is focused: bring one back, as a Dock click does.
    Reopen,
}

/// The action for a menu item id, given the label of the focused window (if any). Not one of
/// ours (a predefined item, the tray) → `None`.
pub fn route<'a>(id: &str, focused: Option<&'a str>) -> Option<Action<'a>> {
    let explorer = focused.filter(|l| is_explorer_label(l));
    let emit = |command| explorer.map(|label| Action::Emit { label, command });
    match id {
        CLOSE_TAB => emit("close-tab"),
        CLOSE_WINDOW => explorer.map(Action::CloseWindow),
        NEW_TAB => emit("new-tab").or(Some(Action::Reopen)),
        NEW_WINDOW => emit("new-window").or(Some(Action::Reopen)),
        _ => None,
    }
}

/// The menu bar, for `Builder::menu`.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let app_menu = SubmenuBuilder::new(app, pkg.name.clone())
        .about(Some(about))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let item = |id: &str, text: &str, accel: &str| {
        MenuItemBuilder::with_id(id, text)
            .accelerator(accel)
            .build(app)
    };
    let file = SubmenuBuilder::new(app, "File")
        .item(&item(NEW_TAB, "New Tab", "Cmd+T")?)
        .item(&item(NEW_WINDOW, "New Window", "Cmd+N")?)
        .separator()
        .item(&item(CLOSE_TAB, "Close Tab", "Cmd+W")?)
        .item(&item(CLOSE_WINDOW, "Close Window", "Shift+Cmd+W")?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&MenuItemBuilder::with_id(MENU_CASCADE, "Cascade Windows").build(app)?)
        .item(&MenuItemBuilder::with_id(MENU_STACKED, "Stack Windows").build(app)?)
        .item(&MenuItemBuilder::with_id(MENU_SIDE_BY_SIDE, "Windows Side by Side").build(app)?)
        .separator()
        .bring_all_to_front()
        .build()?;
    let help = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help").build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window, &help])
        .build()
}

/// `Builder::on_menu_event`: our items only; predefined items act on their own.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let windows = app.webview_windows();
    let focused = windows
        .iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label.as_str());
    if let Some((label, layout)) = menu_arrange(event.id().as_ref(), focused) {
        if let Err(e) = arrange(app, label, layout) {
            log::warn!("menu: could not arrange the windows: {e}");
        }
        return;
    }
    match route(event.id().as_ref(), focused) {
        Some(Action::Emit { label, command }) => {
            if let Err(e) = app.emit_to(label, MENU_EVENT, command) {
                log::warn!("menu: could not send {command} to {label}: {e}");
            }
        }
        Some(Action::CloseWindow(label)) => {
            if let Some(Err(e)) = windows.get(label).map(|w| w.close()) {
                log::warn!("menu: could not close {label}: {e}");
            }
        }
        Some(Action::Reopen) => crate::commands::dock::reopen(app),
        None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_tab_goes_to_the_focused_explorer_window() {
        assert_eq!(
            route(CLOSE_TAB, Some("main-2")),
            Some(Action::Emit {
                label: "main-2",
                command: "close-tab"
            })
        );
        assert_eq!(
            route(NEW_TAB, Some("main")),
            Some(Action::Emit {
                label: "main",
                command: "new-tab"
            })
        );
        assert_eq!(
            route(NEW_WINDOW, Some("main")),
            Some(Action::Emit {
                label: "main",
                command: "new-window"
            })
        );
    }

    #[test]
    fn close_window_closes_the_focused_explorer_window() {
        assert_eq!(
            route(CLOSE_WINDOW, Some("main-3")),
            Some(Action::CloseWindow("main-3"))
        );
    }

    #[test]
    fn the_spotlight_strip_and_no_window_get_no_close() {
        for focused in [Some("palette"), None] {
            assert_eq!(route(CLOSE_TAB, focused), None);
            assert_eq!(route(CLOSE_WINDOW, focused), None);
            // a new tab or window with nothing to put it in brings a window back
            assert_eq!(route(NEW_TAB, focused), Some(Action::Reopen));
            assert_eq!(route(NEW_WINDOW, focused), Some(Action::Reopen));
        }
    }

    #[test]
    fn other_menus_ids_are_not_ours() {
        // the tray's own item, and an unprefixed id
        assert_eq!(route("new-tab", Some("main")), None);
        assert_eq!(route("quit", Some("main")), None);
    }
}

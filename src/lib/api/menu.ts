// The only place the "menu:command" event appears. Mirrors MENU_EVENT in
// src-tauri/src/commands/app_menu.rs: on a Mac the menu bar owns ⌘T, ⌘N and ⌘W (a menu key
// equivalent wins over the webview's keydown), and sends the chosen command to the focused
// explorer window. Other systems have no app menu and never send it.
import { listen } from '@tauri-apps/api/event';

/** A File-menu command for this window. Returns the unlisten fn. */
export const onMenuCommand = (cb: (command: string) => void) =>
  listen<string>('menu:command', (e) => cb(e.payload));

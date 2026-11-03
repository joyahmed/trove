// The only place the tray / startup commands and the tray's event appear. Mirrors
// src-tauri/src/commands/tray.rs and commands/startup.rs.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Create the tray icon and hide-on-close (true) or drop them (false). */
export const setResident = (on: boolean) => invoke<void>('set_resident', { on });
export const isResident = () => invoke<boolean>('is_resident');

/** Write or remove the HKCU `Run` entry that starts the app hidden at logon. */
export const setStartWithWindows = (on: boolean) => invoke<void>('set_start_with_windows', { on });
export const startWithWindows = () => invoke<boolean>('start_with_windows');

/** The tray's "New tab" item was clicked (the window is already shown). Returns the unlisten fn. */
export const onTrayNewTab = (cb: () => void) => listen('tray:new-tab', () => cb());

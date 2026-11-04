// The only place the update commands and event appear (plan 22.5). Mirrors
// src-tauri/src/commands/updater.rs and the event in core/updater.rs.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** The version downloaded and waiting for "Restart to update", or null. */
export const updateReady = () => invoke<string | null>('update_ready');

/** Install the waiting update and start Trove again. Only ever on the person's click. */
export const updateRestart = () => invoke<void>('update_restart');

/** An update finished downloading in the background. Returns the unlisten fn. */
export const onUpdateReady = (cb: (version: string) => void) =>
  listen<string>('update:ready', (e) => cb(e.payload));

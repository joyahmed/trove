// The only place the watch commands and the "fs:changed" event appear. Mirrors
// src-tauri/src/commands/watch.rs.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { FsChanged } from '$lib/types/watch';

/** Start (or keep) watching a folder; refcounted per path on the Rust side. */
export const watchPath = (path: string) => invoke<void>('watch_path', { path });
export const unwatchPath = (path: string) => invoke<void>('unwatch_path', { path });

/** A watched folder changed (debounced 200 ms by Rust). Returns the unlisten fn. */
export const onFsChanged = (cb: (change: FsChanged) => void) =>
  listen<FsChanged>('fs:changed', (e) => cb(e.payload));

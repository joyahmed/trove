// The only place the settings commands appear. Mirrors src-tauri/src/commands/settings.rs.
// The value is the frontend's own shape (see state/settings.svelte.ts); Rust stores it opaquely.
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';

export const readSettings = () => invoke<unknown>('read_settings');
export const writeSettings = (value: unknown) => invoke<void>('write_settings', { value });
/** Write only these fields, keeping the rest of the file — how a window other than `main` saves. */
export const mergeSettings = (patch: unknown) => invoke<void>('merge_settings', { patch });

/** A window changed some settings; every other window applies them (state/settings `applyRemote`). */
const CHANGED = 'settings:changed';
interface ChangedPayload {
  from: string;
  patch: unknown;
}

export const emitSettingsChanged = (from: string, patch: unknown) =>
  emit(CHANGED, { from, patch } satisfies ChangedPayload);

/** Other windows' changes only: an event reaches its own sender too, so `self` is filtered out. */
export const onSettingsChanged = (self: string, cb: (patch: unknown) => void) =>
  listen<ChangedPayload>(CHANGED, (e) => {
    if (e.payload.from !== self) cb(e.payload.patch);
  });

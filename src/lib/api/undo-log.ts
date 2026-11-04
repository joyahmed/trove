// The only place the undo-history commands appear. Mirrors src-tauri/src/commands/undo_log.rs.
// The value is the frontend's own shape (`types/undo.ts`); Rust stores it opaquely, so what
// comes back is `unknown` until `utils/undo-records.ts` has checked it.
import { invoke } from '@tauri-apps/api/core';
import type { SavedUndoLog } from '$lib/types/undo';

export const readUndoLog = () => invoke<unknown>('read_undo_log');
export const writeUndoLog = (value: SavedUndoLog) => invoke<void>('write_undo_log', { value });

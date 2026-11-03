// The only place `invoke` appears for the OS clipboard. Mirrors src-tauri/src/commands/transfer.rs
// (CF_HDROP with Explorer's cut / copy flag, so both directions interoperate with Explorer).
import { invoke } from '@tauri-apps/api/core';
import type { ClipboardPaths } from '$lib/types/transfer';

export const clipboardWritePaths = (paths: string[], cut: boolean) =>
  invoke<void>('clipboard_write_paths', { paths, cut });

/** "Copy as path": the paths as quoted lines of plain text (the OS clipboard's text slot) */
export const clipboardWritePathsText = (paths: string[]) =>
  invoke<void>('clipboard_write_paths_text', { paths });

/** any text on the clipboard's text slot — the palette's calculator answer, today */
export const clipboardWriteText = (text: string) => invoke<void>('clipboard_write_text', { text });

/** null when the clipboard holds no files */
export const clipboardReadPaths = () => invoke<ClipboardPaths | null>('clipboard_read_paths');

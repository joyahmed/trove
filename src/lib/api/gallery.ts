// The only place `invoke` appears for the Gallery. Mirrors src-tauri/src/commands/gallery.rs.
import { invoke } from '@tauri-apps/api/core';
import type { FileEntry } from '$lib/types/fs';

/** Photos and videos under the Pictures folders, newest first, at most `max`. */
export const galleryItems = (max?: number) =>
  invoke<FileEntry[]>('gallery_items', { max: max ?? null });

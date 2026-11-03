// The only place `invoke` appears for image dimensions. Mirrors src-tauri/src/commands/image_dims.rs.
import { invoke } from '@tauri-apps/api/core';

/** `[width, height]` per path, in order; `null` for a file the header reader cannot place. */
export const imageDimensions = (paths: string[]) =>
  invoke<([number, number] | null)[]>('image_dimensions', { paths });

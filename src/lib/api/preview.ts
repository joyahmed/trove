// The only place `invoke` appears for the preview domain, plus the URL of the `preview` custom
// protocol registered in lib.rs (on Windows Tauri maps `preview://` to this origin). Mirrors
// src-tauri/src/commands/preview.rs.
import { invoke } from '@tauri-apps/api/core';
import type { TextHead } from '$lib/types/preview';
import { protocolOrigin } from '$lib/utils/platform';

export const PREVIEW_ORIGIN = protocolOrigin('preview');

/** The first 64 KB of a text file. */
export const readTextHead = (path: string) => invoke<TextHead>('read_text_head', { path });

/** Pure URL building: the file's bytes for an <img> / <video> / <iframe>. */
export const previewUrl = (path: string): string =>
  `${PREVIEW_ORIGIN}/file/${encodeURIComponent(path)}`;

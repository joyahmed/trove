// What the preview pane renders for an extension. The image / video / audio / pdf sets mirror
// the content-type table in src-tauri/src/core/preview.rs — change both or neither; the text
// set is frontend-only (Rust reads any file as text when asked).
//
// ⚠️ This map does NOT decide what the grid thumbnails, and must never be wired to it. That
// decision lives in `src/lib/utils/tile-icon.ts`, and it consults no list at all: it asks the
// shell for every file and lets `GetImage`'s own icon fallback answer. The two questions look
// alike and are not: `video` here means "WebView2 can decode it in a `<video>` and preview.rs
// has a content type to serve it with", which rules out `.mkv`, `.avi`, `.wmv` and the rest of
// the Matroska/ASF/MPEG-PS family however happily the shell thumbnails them. Widening `video`
// to fix a grid thumbnail would trade an honest "no preview" for a black `<video>` box; pinned
// by `containers WebView2 cannot decode are not video…` in preview-kinds.test.ts, and from the
// other side by `keeps the thumbnail decision independent…` in tile-icon.test.ts.
import type { FileEntry } from '$lib/types/fs';
import type { PreviewKind } from '$lib/types/preview';

const KINDS: Record<Exclude<PreviewKind, 'none'>, readonly string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'],
  video: ['mp4', 'webm', 'mov'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a'],
  pdf: ['pdf'],
  text: [
    'txt',
    'md',
    'json',
    'js',
    'ts',
    'rs',
    'py',
    'toml',
    'yaml',
    'yml',
    'xml',
    'html',
    'css',
    'svelte',
    'csv',
    'log',
    'ini',
    'cfg',
    'sh',
    'ps1',
    'bat',
    'c',
    'h',
    'cpp',
    'cs',
    'java',
    'go',
    'sql',
  ],
};

const BY_EXT: Record<string, PreviewKind> = Object.fromEntries(
  (Object.entries(KINDS) as [PreviewKind, readonly string[]][]).flatMap(([kind, exts]) =>
    exts.map((e) => [e, kind]),
  ),
);

/** A folder previews as nothing; an extensionless file as text; unknown extensions as none. */
export const previewKindOf = (entry: FileEntry): PreviewKind => {
  if (entry.isDir) return 'none';
  if (entry.ext === null || entry.ext === '') return 'text';
  return BY_EXT[entry.ext] ?? 'none';
};

import { describe, expect, it } from 'vitest';
import { previewKindOf } from './preview-kinds';
import type { FileEntry } from '$lib/types/fs';

const entry = (name: string, ext: string | null, isDir = false): FileEntry => ({
  name,
  path: `C:\\x\\${name}`,
  isDir,
  size: 1,
  modifiedMs: null,
  createdMs: null,
  ext,
  isHidden: false,
  iconKey: isDir ? 'folder' : `ext/${ext ?? ''}`,
  typeName: 'File',
});

describe('previewKindOf', () => {
  it('maps extensions to their kind', () => {
    expect(previewKindOf(entry('a.png', 'png'))).toBe('image');
    expect(previewKindOf(entry('a.mp4', 'mp4'))).toBe('video');
    expect(previewKindOf(entry('a.mp3', 'mp3'))).toBe('audio');
    expect(previewKindOf(entry('a.pdf', 'pdf'))).toBe('pdf');
    expect(previewKindOf(entry('a.rs', 'rs'))).toBe('text');
  });

  // ⚠️ Deliberately absent, and it must stay absent. This map decides which component the
  // preview pane mounts, and `video` mounts a `<video>` element in WebView2 — which ships no
  // Matroska / ASF demuxer, and whose only source is `preview.rs::content_type`, which has no
  // arm for these either (it would serve application/octet-stream). Adding them here to fix a
  // grid *thumbnail* would trade an honest "no preview" for a black box. The shell thumbnails
  // them anyway: that decision lives in `src/lib/utils/tile-icon.ts`, on its own list.
  it('containers WebView2 cannot decode are not video, however well the shell thumbnails them', () => {
    for (const ext of ['mkv', 'avi', 'wmv', 'asf', 'mpg', 'mpeg', 'm2ts', 'mts', 'vob']) {
      expect(previewKindOf(entry(`a.${ext}`, ext)), ext).toBe('none');
    }
    // `.ts` is claimed by TypeScript here, not by MPEG-TS, and stays text on purpose.
    expect(previewKindOf(entry('a.ts', 'ts'))).toBe('text');
  });

  // The kinds here mirror `src-tauri/src/core/preview.rs::content_type` exactly — every
  // extension the pane claims it can render must have a content type to be served with.
  it('every image/video/audio/pdf extension is one preview.rs has a content type for', () => {
    const served = [
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'bmp',
      'svg',
      'ico',
      'mp4',
      'webm',
      'mov',
      'mp3',
      'wav',
      'ogg',
      'flac',
      'm4a',
      'pdf',
    ];
    for (const ext of served) {
      expect(['image', 'video', 'audio', 'pdf'], ext).toContain(
        previewKindOf(entry(`a.${ext}`, ext)),
      );
    }
  });

  it('folders and unknown extensions are none; no extension is text', () => {
    expect(previewKindOf(entry('dir', null, true))).toBe('none');
    expect(previewKindOf(entry('a.exe', 'exe'))).toBe('none');
    expect(previewKindOf(entry('LICENSE', null))).toBe('text');
  });
});

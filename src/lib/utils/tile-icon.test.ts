import { describe, expect, it } from 'vitest';
import type { FileEntry } from '$lib/types/fs';
import { previewKindOf } from '$lib/data/preview-kinds';
import { tileIconUrl, tilePlaceholderUrl } from './tile-icon';

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  name: 'photo.jpg',
  path: 'C:\\pics\\photo.jpg',
  isDir: false,
  size: 1,
  modifiedMs: null,
  createdMs: null,
  ext: 'jpg',
  isHidden: false,
  iconKey: 'ext/jpg',
  typeName: 'JPG File',
  ...over,
});

/** A file entry for `a.<ext>` at `C:\a.<ext>`, the shape the per-extension sweeps want. */
const file = (ext: string): FileEntry =>
  entry({ name: `a.${ext}`, path: `C:\\a.${ext}`, ext, iconKey: `ext/${ext}` });

const ORIGIN = 'http://icon.localhost';

/** `C:\a.txt` → `C%3A%5Ca.txt`, what `encodeURIComponent` does to a Windows path. */
const thumb = (path: string, size: number, stamp = '1-0') =>
  `${ORIGIN}/thumb/${encodeURIComponent(path)}?size=${size}&v=${stamp}`;
const big = (path: string, size: number) =>
  `${ORIGIN}/big/${encodeURIComponent(path)}?size=${size}`;

describe('tileIconUrl inside an archive', () => {
  it('draws the extension icon: a row path holds a NUL and has no file to thumbnail', () => {
    const row = entry({ path: 'C:\\x\\a.zip\u0000photo.jpg' });
    expect(tileIconUrl(row, 96)).toBe(`${ORIGIN}/ext/jpg?size=32`);
  });
});

describe('tileIconUrl stamp', () => {
  // B.5.5: a PNG listed while still being written got a URL with no stamp, so its failed
  // answer was cached for a day and survived F5.
  it('carries size-mtime so a grown or touched file is a new URL', () => {
    const a = tileIconUrl(entry({ size: 100, modifiedMs: 5 }), 96);
    expect(a).toBe(thumb('C:\\pics\\photo.jpg', 96, '100-5'));
    expect(tileIconUrl(entry({ size: 200, modifiedMs: 5 }), 96)).not.toBe(a);
    expect(tileIconUrl(entry({ size: 100, modifiedMs: 6 }), 96)).not.toBe(a);
    expect(tileIconUrl(entry({ size: 100, modifiedMs: 5 }), 96)).toBe(a);
  });
});

describe('tileIconUrl', () => {
  // ⭐ The bug Joy reported: at Medium the grid asked for `ext/jpg`, one icon shared by every
  // .jpg in the folder, so no tile could ever show its own picture. Real Explorer at Medium
  // icons draws the thumbnail (measured), so Trove must too.
  it('asks for the file\u2019s own thumbnail at Medium, not the per-extension icon', () => {
    expect(tileIconUrl(entry(), 48)).toBe(thumb('C:\\pics\\photo.jpg', 48));
  });

  it('keeps asking per file at Large and Extra large', () => {
    expect(tileIconUrl(entry(), 96)).toBe(thumb('C:\\pics\\photo.jpg', 96));
    expect(tileIconUrl(entry(), 256)).toBe(thumb('C:\\pics\\photo.jpg', 256));
  });

  // ⭐ The contract after the allow-list was deleted: there is no list. Every FILE asks the
  // shell for its own picture and the shell decides — `GetImage(SIIGBF_THUMBNAILONLY)` falls
  // back to `SIIGBF_ICONONLY` inside the same call, so a file with no registered provider gets
  // the association icon from the `thumb/` route, byte-identical to what `big/` would have
  // returned (`thumbs.rs::a_file_with_no_thumbnail_falls_back_to_its_icon` pins the equality).
  // A wrong *inclusion* therefore costs one cheap shell call and is invisible; a wrong
  // *exclusion* put a generic glyph where a picture belonged, which is the bug this replaced.
  it('routes every file through thumb/, provider or no provider', () => {
    for (const ext of [
      'jpg', // provider, via PerceivedType=image
      'mkv', // provider, shell32's Property Thumbnail Handler
      'docx', // provider, Office
      'pdf', // no provider on this machine — takes the icon fallback, as it has since d48f650
      'svg', // no provider here; renders in the pane, which is a different question
      'txt',
      'zip',
      'rs',
      'json',
      'svelte',
      'exe',
      'zzqq', // an extension nothing on earth registers
    ]) {
      expect(tileIconUrl(file(ext), 48), ext).toBe(thumb(`C:\\a.${ext}`, 48));
    }
  });

  // ⛔ The one exception, and it is a COST rule rather than a correctness one. `.ts` measured at
  // 137 ms per cold `GetImage(SIIGBF_THUMBNAILONLY)` over 150 real `.ts` files in this repo —
  // the shell reads it as an MPEG-2 transport stream and lets the demuxer scan the whole file
  // for sync bytes before failing. A provider-LESS extension costs ~1.8 ms by comparison. At
  // ~154 tiles on a Medium screen that is ~21 s of serialized shell calls for one screen of a
  // TypeScript source tree, so this one extension does not get asked.
  it('does not ask for a thumbnail on .ts, the one measured-too-slow extension', () => {
    expect(tileIconUrl(file('ts'), 48)).toBe(big('C:\\a.ts', 48));
    expect(tileIconUrl(file('ts'), 96)).toBe(big('C:\\a.ts', 96));
    expect(tileIconUrl(file('ts'), 256)).toBe(big('C:\\a.ts', 256));
  });

  // ⚠️ The deny-list is exactly one entry wide and must stay that way without a measurement to
  // widen it. The rest of the MPEG family is just as slow to FAIL, but a file named `.mpg` or
  // `.m2ts` really is a video, so the call succeeds and buys a real first frame — only `.ts`
  // collides with a non-media use common enough to matter.
  it('still asks for the rest of the MPEG family, which really is video', () => {
    for (const ext of ['mpg', 'mpeg', 'm2ts', 'mts', 'm2t', 'vob', 'm1v', 'm2v', 'mpe', 'ogv']) {
      expect(tileIconUrl(file(ext), 48), ext).toBe(thumb(`C:\\a.${ext}`, 48));
    }
  });

  // ⭐ Album art comes free with the deletion: mp3/wav/ogg/flac/m4a/wma all carry
  // {9DBD2C50-62AD-11D0-B806-00C04FD706EC}, shell32's Property Thumbnail Handler, which reads
  // the embedded picture frame. The old allow-list had no audio in it at all, so a music folder
  // could only ever draw the media-player association icon.
  it('asks for embedded album art on an audio file', () => {
    for (const ext of ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'wma']) {
      expect(tileIconUrl(file(ext), 96), ext).toBe(thumb(`C:\\a.${ext}`, 96));
    }
  });

  // An extensionless file is still a file: the shell may have a provider by content type, and
  // if it does not, the fallback is the icon. Nothing about `ext === null` says "folder".
  it('routes an extensionless file through thumb/ as well', () => {
    const readme = entry({ name: 'LICENSE', path: 'C:\\r\\LICENSE', ext: null, iconKey: 'ext/' });
    expect(tileIconUrl(readme, 48)).toBe(thumb('C:\\r\\LICENSE', 48));
  });

  // ⚠️ Folders keep the icon route, and that is not an optimisation — it is the right answer.
  // A folder's image is an ICON question: the shell's folder glyph, or whatever `desktop.ini`
  // themes it into. `SIIGBF_THUMBNAILONLY` on a directory is a different and unwanted question
  // (Explorer's old "folder with a peek at its contents"), and `big/` is what honours
  // desktop.ini. `icon_png_cached` maps `big/<path>` to `ImageMode::IconOnly`.
  it('keeps folders on the big-icon route', () => {
    const plain = entry({
      name: 'docs',
      path: 'C:\\docs',
      isDir: true,
      ext: null,
      iconKey: 'folder',
    });
    expect(tileIconUrl(plain, 48)).toBe(big('C:\\docs', 48));
    expect(tileIconUrl(plain, 96)).toBe(big('C:\\docs', 96));
    expect(tileIconUrl(plain, 256)).toBe(big('C:\\docs', 256));
  });

  // A themed folder (desktop.ini) is `file/<path>` and not `folder` — `fs.rs` swaps the key
  // when `path.join("desktop.ini").exists()` — so it is the folder case that actually reaches
  // `<img>` at 48, where `FileTile.svelte` draws `FolderIcon.svelte` for a bare one instead.
  // It must stay on `big/`, which is the route that honours IconResource.
  it('draws a themed folder through the big-icon route', () => {
    const themed = entry({
      name: 'themed',
      path: 'C:\\themed',
      isDir: true,
      ext: null,
      iconKey: 'file/C:\\themed',
    });
    expect(tileIconUrl(themed, 48)).toBe(big('C:\\themed', 48));
  });

  // The gate keys off `isDir` ALONE and must never fall back to reading `ext`. `fs.rs` sets
  // `ext: None` for every directory, so this shape does not come off the backend today — the
  // pin exists so that if it ever does (a dotted folder name someone decides to parse), the
  // folder still takes the folder's route instead of being thumbnailed as a `.bak` file.
  it('keeps a dotted folder on the big-icon route even with an ext set', () => {
    const dotted = entry({
      name: 'node_modules.bak',
      path: 'C:\\node_modules.bak',
      isDir: true,
      ext: 'bak',
      iconKey: 'folder',
    });
    expect(tileIconUrl(dotted, 48)).toBe(big('C:\\node_modules.bak', 48));
  });

  // ⭐ The pin that keeps the two decisions apart, carried over from 095ee06 and still load
  // bearing now that the thumbnail list is gone: `preview-kinds.ts` answers what the preview
  // PANE can render, and nothing here may consult it. `.mkv` thumbnails (the shell has a
  // provider) but must NOT reach the pane's <video>: WebView2 has no Matroska demuxer and
  // `preview.rs::content_type` has no arm for it, so a pane would be a black box where an
  // honest "no preview" belongs. Re-coupling them breaks one or the other.
  it('keeps the thumbnail decision independent of the preview-pane decision', () => {
    const mkv = entry({ name: 'b.mkv', path: 'C:\\v\\b.mkv', ext: 'mkv', iconKey: 'ext/mkv' });
    expect(previewKindOf(mkv)).toBe('none');
    expect(tileIconUrl(mkv, 48)).toBe(thumb('C:\\v\\b.mkv', 48));
    // And the reverse: `previewKindOf` says 'none' for a .zip, which says nothing at all about
    // whether the tile should ask the shell — it asks, and takes the icon fallback.
    const zip = file('zip');
    expect(previewKindOf(zip)).toBe('none');
    expect(tileIconUrl(zip, 48)).toBe(thumb('C:\\a.zip', 48));
  });
});

describe('tilePlaceholderUrl', () => {
  it('is the cheap extension icon, never a thumbnail', () => {
    expect(tilePlaceholderUrl(entry())).toBe('http://icon.localhost/ext/jpg?size=32');
  });
  it('is nothing for a per-file icon key', () => {
    expect(tilePlaceholderUrl(entry({ iconKey: String.raw`file/C:\a.exe` }))).toBeUndefined();
  });
});

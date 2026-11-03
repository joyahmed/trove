import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '$lib/types/fs';
import { iconUrl } from '$lib/api/icons';
import { drawnFileIcons } from './platform';
import {
  DECODED_THUMBNAIL_EXTS,
  QUICKLOOK_THUMBNAIL_EXTS,
  fileIconKind,
  isDecodedThumbnail,
  keyedIcon,
} from './file-icon';
import { tileIconUrl } from './tile-icon';
import { thumbStamp } from './thumb-stamp';

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  name: 'data.csv',
  path: '/Users/alex/Downloads/data.csv',
  isDir: false,
  size: 1,
  modifiedMs: null,
  createdMs: null,
  ext: 'csv',
  isHidden: false,
  iconKey: 'ext/csv',
  typeName: 'CSV File',
  ...over,
});

describe('drawnFileIcons — the platform switch', () => {
  it('is off on Windows, and off when nothing was injected (tests, a plain browser)', () => {
    expect(drawnFileIcons({ os: 'windows', thisPcLabel: 'This PC' })).toBe(false);
    expect(drawnFileIcons(undefined)).toBe(false);
  });

  it('is on for macOS and Linux', () => {
    expect(drawnFileIcons({ os: 'macos', thisPcLabel: 'This Mac' })).toBe(true);
    expect(drawnFileIcons({ os: 'linux', thisPcLabel: 'This Computer' })).toBe(true);
  });
});

describe('fileIconKind', () => {
  it('Windows: unchanged — the shell icon for every file, the SVG for a bare folder', () => {
    expect(fileIconKind(entry(), false)).toBe('shell');
    expect(fileIconKind(entry({ isDir: true, iconKey: 'folder' }), false)).toBe('folder');
    // a themed folder (desktop.ini) keeps asking the shell, as it did
    expect(fileIconKind(entry({ isDir: true, iconKey: 'file/C:\\x' }), false)).toBe('shell');
    expect(fileIconKind(entry({ iconKey: 'file/C:\\a.exe' }), false)).toBe('shell');
  });

  it('off Windows: every folder draws the SVG, every non-picture file is drawn', () => {
    expect(fileIconKind(entry(), true)).toBe('drawn');
    expect(fileIconKind(entry({ iconKey: 'file//x/a.exe' }), true)).toBe('drawn');
    expect(fileIconKind(entry({ isDir: true, iconKey: 'folder' }), true)).toBe('folder');
    expect(fileIconKind(entry({ isDir: true, iconKey: 'file//x/themed' }), true)).toBe('folder');
  });

  it('off Windows: a picture inside an archive draws its glyph, it has no file to thumbnail', () => {
    const photo = entry({ name: 'a.png', ext: 'png', iconKey: 'ext/png' });
    expect(fileIconKind(photo, true)).toBe('thumb');
    expect(fileIconKind({ ...photo, path: '/Users/alex/a.zip\u0000a.png' }, true)).toBe('drawn');
  });

  it('defaults to Windows behaviour in tests, where no platform is injected', () => {
    expect(fileIconKind(entry())).toBe('shell');
  });

  it('the Windows path still yields the icon:// URLs it always did', () => {
    const e = entry({ path: 'C:\\a.csv', iconKey: 'ext/csv' });
    expect(fileIconKind(e)).toBe('shell');
    expect(iconUrl(e.iconKey, 16)).toBe('http://icon.localhost/ext/csv?size=16');
    expect(tileIconUrl(e, 48)).toBe(
      `http://icon.localhost/thumb/${encodeURIComponent('C:\\a.csv')}?size=48&v=${thumbStamp(e)}`,
    );
  });
});

describe('a Mac build, through the module-level switch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('draws every file and folder when Rust says macOS', async () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'macos', thisPcLabel: 'This Mac' } });
    vi.resetModules();
    const mod = await import('./file-icon');
    expect(mod.DRAWN_FILE_ICONS).toBe(true);
    expect(mod.fileIconKind(entry())).toBe('drawn');
    expect(mod.fileIconKind(entry({ isDir: true, iconKey: 'folder' }))).toBe('folder');
  });

  it('keeps the shell when Rust says Windows', async () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'windows', thisPcLabel: 'This PC' } });
    vi.resetModules();
    const mod = await import('./file-icon');
    expect(mod.DRAWN_FILE_ICONS).toBe(false);
    expect(mod.fileIconKind(entry())).toBe('shell');
  });
});

describe('decoded thumbnails off Windows (plan 14.2)', () => {
  const pic = (name: string, over: Partial<FileEntry> = {}) =>
    entry({ name, path: `/home/alex/Pictures/${name}`, iconKey: 'ext/x', ...over });

  it('a picture Rust can decode asks for its thumbnail, any case', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.BMP', 'IMG_0001.Jpg']) {
      expect(fileIconKind(pic(name), true)).toBe('thumb');
    }
  });

  it('a picture it cannot decode keeps its glyph, and so does everything else', () => {
    for (const name of [
      'a.heic',
      'a.avif',
      'a.svg',
      'a.tiff',
      'a.psd',
      'a.mp4',
      'a.csv',
      'README',
    ]) {
      expect(fileIconKind(pic(name), true)).toBe('drawn');
    }
    // a dotfile is extension-less to Rust's `Path::extension`, so it is not a picture
    expect(isDecodedThumbnail('.png')).toBe(false);
    expect(isDecodedThumbnail('archive.png.zip')).toBe(false);
  });

  it('a folder named like a picture is still a folder', () => {
    expect(fileIconKind(pic('album.png', { isDir: true, iconKey: 'folder' }), true)).toBe('folder');
  });

  it('Windows and no platform never decode: the shell decides, as before', () => {
    expect(fileIconKind(pic('a.png', { iconKey: 'ext/png' }), false)).toBe('shell');
    expect(fileIconKind(pic('a.png', { iconKey: 'ext/png' }))).toBe('shell');
  });

  it('the list is exactly the one Rust decodes (image_thumbs.rs DECODABLE_EXTS)', async () => {
    const { readFileSync } = await import('node:fs');
    const rust = readFileSync('src-tauri/src/core/image_thumbs.rs', 'utf8');
    const line = rust.match(/pub const DECODABLE_EXTS: \[&str; \d+\] = \[([^\]]*)\];/);
    expect(line, 'DECODABLE_EXTS is declared on one line').not.toBeNull();
    const rustExts = [...line![1].matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
    expect([...DECODED_THUMBNAIL_EXTS].sort()).toEqual(rustExts.sort());
  });

  it('a Mac also asks for what QuickLook draws, and Linux does not', () => {
    for (const name of [
      'a.heic',
      'A.HEIF',
      'a.avif',
      'a.tif',
      'a.tiff',
      'a.mov',
      'a.MP4',
      'a.m4v',
    ]) {
      expect(isDecodedThumbnail(name, true), name).toBe(true);
      expect(isDecodedThumbnail(name, false), name).toBe(false);
    }
    for (const name of ['a.webm', 'a.mkv', 'a.avi', 'a.svg', 'a.psd', 'README', '.heic']) {
      expect(isDecodedThumbnail(name, true), name).toBe(false);
    }
    expect(isDecodedThumbnail('a.png', true)).toBe(true);
  });

  it('the QuickLook list is exactly the Rust one (quicklook.rs QUICKLOOK_EXTS)', async () => {
    const { readFileSync } = await import('node:fs');
    const rust = readFileSync('src-tauri/src/core/quicklook.rs', 'utf8');
    const line = rust.match(/pub const QUICKLOOK_EXTS: \[&str; \d+\] = \[([^\]]*)\];/);
    expect(line, 'QUICKLOOK_EXTS is declared on one line').not.toBeNull();
    const rustExts = [...line![1].matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
    expect([...QUICKLOOK_THUMBNAIL_EXTS].sort()).toEqual(rustExts.sort());
  });
});

describe('keyedIcon — palette and Recycle Bin rows (plan 14.1.5)', () => {
  it('Windows: the shell URL as before, the SVG for a folder', () => {
    expect(keyedIcon('ext/txt', 16, undefined, false)).toEqual({
      kind: 'shell',
      src: 'http://icon.localhost/ext/txt?size=16',
    });
    expect(keyedIcon('app/Calc!App', 16, undefined, false).kind).toBe('shell');
    expect(keyedIcon('folder', 16, undefined, false)).toEqual({ kind: 'folder' });
  });

  it('off Windows: the glyph of the extension, the path name or the app', () => {
    expect(keyedIcon('folder', 16, undefined, true)).toEqual({ kind: 'folder' });
    expect(keyedIcon('ext/csv', 16, undefined, true)).toEqual({ kind: 'drawn', name: 'x.csv' });
    expect(keyedIcon('file//Users/alex/Notes.md', 16, undefined, true)).toEqual({
      kind: 'drawn',
      name: 'Notes.md',
    });
    expect(keyedIcon('file/C:\\Apps\\run.exe', 16, undefined, true)).toEqual({
      kind: 'drawn',
      name: 'run.exe',
    });
    expect(keyedIcon('app/org.gnome.Calc', 16, undefined, true)).toEqual({
      kind: 'drawn',
      name: 'x.app',
    });
  });

  it('off Windows an Ubuntu app row asks Rust for its theme icon', () => {
    const key = 'file//usr/share/applications/org.gnome.Calculator.desktop';
    expect(keyedIcon(key, 16, undefined, true)).toEqual({
      kind: 'shell',
      src: iconUrl(key, 16),
    });
  });

  it("on a Mac an app bundle key is the bundle's own icon (QuickLook), not the app glyph", () => {
    expect(
      keyedIcon('file//System/Applications/Calculator.app', 16, undefined, true, true),
    ).toEqual({
      kind: 'thumb',
      path: '/System/Applications/Calculator.app',
      name: 'Calculator.app',
    });
    expect(
      keyedIcon('file//Applications/Visual Studio Code.APP', 16, undefined, true, true).kind,
    ).toBe('thumb');
    // a bare `.app`, a plain file and Linux keep the glyph
    expect(keyedIcon('file//x/.app', 16, undefined, true, true).kind).toBe('drawn');
    expect(keyedIcon('file//x/Notes.md', 16, undefined, true, true).kind).toBe('drawn');
    expect(keyedIcon('file//x/Calculator.app', 16, undefined, true, false).kind).toBe('drawn');
  });

  it('off Windows a given name wins (the Recycle Bin knows the real name)', () => {
    expect(keyedIcon('ext/txt', 16, 'old.zip', true)).toEqual({ kind: 'drawn', name: 'old.zip' });
  });

  it('defaults to Windows behaviour in tests', () => {
    expect(keyedIcon('ext/txt', 16).kind).toBe('shell');
  });
});

describe('HEIC in the file list (G.57)', () => {
  const heic = entry({ name: 'IMG_1.heic', path: '/p/IMG_1.heic', iconKey: 'ext/heic' });
  it('a Mac asks QuickLook for it, Linux keeps the glyph', () => {
    expect(fileIconKind(heic, true, undefined, true)).toBe('thumb');
    expect(fileIconKind(heic, true, undefined, false)).toBe('drawn');
  });
  it('the Windows Icons view asks the shell for a thumbnail', () => {
    const win = entry({ name: 'a.heic', path: 'C:\\a.heic', iconKey: 'ext/heic' });
    expect(tileIconUrl(win, 96)).toContain('/thumb/');
  });
});

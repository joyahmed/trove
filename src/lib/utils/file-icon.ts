// What draws an entry's small icon in a listing (Details, List, the grid, the hover card).
// Windows: the shell's icon over `icon://`, exactly as before; a bare folder draws the SVG.
// Off Windows (plan 14): the shell has nothing (`icons.rs` stub → 404, a broken `<img>`), so
// every folder draws the SVG and every file draws its category's glyph — except a picture Rust
// can decode (plan 14.2), which asks for its own thumbnail and keeps the glyph until it lands.
import type { FileEntry } from '$lib/types/fs';
import { iconUrl } from '$lib/api/icons'; // a pure URL formatter, not an IPC call
import { isAppBundle } from './app-bundle';
import { isArchivePath } from './archive-location';
import { drawnFileIcons, onMac } from './platform';

export type FileIconKind = 'folder' | 'thumb' | 'drawn' | 'shell';

/** Read once: the platform is injected before any page script runs (`platform.ts`). */
export const DRAWN_FILE_ICONS = drawnFileIcons();

/** Read once, like `DRAWN_FILE_ICONS`: a Mac also asks QuickLook (`QUICKLOOK_THUMBNAIL_EXTS`). */
const ON_MAC = onMac();

/**
 * The extensions Rust decodes into a thumbnail off Windows — exactly
 * `src-tauri/src/core/image_thumbs.rs` `DECODABLE_EXTS` (a test reads that line). ⛔ This is an
 * allow-list, and unlike the one `tile-icon.ts` warns against it is the truth: off Windows the
 * decoder is ours and its codecs are fixed at build time. HEIC, AVIF, SVG, TIFF, RAW and PSD are
 * not in it and keep their glyph.
 */
export const DECODED_THUMBNAIL_EXTS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
];

/**
 * The extensions a Mac draws through QuickLook on top of those — exactly
 * `src-tauri/src/core/quicklook.rs` `QUICKLOOK_EXTS` (a test reads that line). Not WebM, MKV or
 * AVI: QuickLook gives them no thumbnail, so they keep the glyph and "no preview". Linux has no
 * QuickLook and asks for none of these.
 */
export const QUICKLOOK_THUMBNAIL_EXTS: readonly string[] = [
  'heic',
  'heif',
  'avif',
  'tif',
  'tiff',
  'mov',
  'mp4',
  'm4v',
];

/** `photo.JPG` → `jpg`; `.png` (a dotfile) and `README` → `null`, as Rust's `Path::extension`. */
export const extensionOf = (name: string): string | null => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
};

/** Whether Rust can draw this name's picture off Windows (on a Mac, QuickLook's kinds too). */
export const isDecodedThumbnail = (name: string, mac: boolean = ON_MAC): boolean => {
  const ext = extensionOf(name);
  if (ext === null) return false;
  return DECODED_THUMBNAIL_EXTS.includes(ext) || (mac && QUICKLOOK_THUMBNAIL_EXTS.includes(ext));
};

export const fileIconKind = (
  entry: Pick<FileEntry, 'isDir' | 'iconKey' | 'name'> & { path?: string },
  drawn: boolean = DRAWN_FILE_ICONS,
  platform?: Parameters<typeof isAppBundle>[1],
  mac: boolean = ON_MAC,
): FileIconKind => {
  if (!drawn) return entry.iconKey === 'folder' ? 'folder' : 'shell';
  // a Mac's `X.app` is a folder on disk but an app to the person: its own icon, which Rust asks
  // QuickLook for (`quicklook.rs`), over the app glyph until it lands or if it never does
  if (entry.isDir) return isAppBundle(entry, platform) ? 'thumb' : 'folder';
  // a row inside an archive has no file for Rust to thumbnail: its glyph
  if (entry.path !== undefined && isArchivePath(entry.path)) return 'drawn';
  return isDecodedThumbnail(entry.name, mac) ? 'thumb' : 'drawn';
};

/** What draws an icon that is known only by its shell key (palette rows, the Recycle Bin). */
export type KeyedIcon =
  | { kind: 'folder' }
  | { kind: 'drawn'; name: string }
  | { kind: 'thumb'; path: string; name: string }
  | { kind: 'shell'; src: string };

/** `/Users/alex/a.png` and `C:\a.png` → `a.png`. */
const baseName = (path: string): string => path.slice(path.search(/[^\\/]*$/));

/**
 * `folder` is the SVG everywhere. Windows: any other key is the shell's icon, as before. Off
 * Windows the shell has nothing: `ext/<e>` draws the glyph of `x.<e>`, `file/<path>` the glyph of
 * the path's name, `app/…` the app glyph — except `file/<…>.desktop`, whose theme icon Rust
 * draws (`core/apps_linux.rs`). `name` overrides what the glyph is picked from.
 * A Mac's `file/<…>.app` (a palette app row) is the bundle's own icon over the QuickLook route,
 * as a listing draws it (`fileIconKind`), not the generic app glyph.
 */
export const keyedIcon = (
  iconKey: string,
  size: 16 | 32,
  name?: string,
  drawn: boolean = DRAWN_FILE_ICONS,
  mac: boolean = ON_MAC,
): KeyedIcon => {
  if (iconKey === 'folder') return { kind: 'folder' };
  if (!drawn) return { kind: 'shell', src: iconUrl(iconKey, size) };
  // an Ubuntu app row: Rust resolves the `.desktop` file's `Icon=` in the icon theme
  if (iconKey.startsWith('file/') && iconKey.toLowerCase().endsWith('.desktop')) {
    return { kind: 'shell', src: iconUrl(iconKey, size) };
  }
  if (name !== undefined) return { kind: 'drawn', name };
  if (iconKey.startsWith('ext/')) return { kind: 'drawn', name: `x.${iconKey.slice(4)}` };
  if (iconKey.startsWith('file/')) {
    const path = iconKey.slice(5);
    const base = baseName(path);
    const app = mac && base.length > '.app'.length && base.toLowerCase().endsWith('.app');
    return app ? { kind: 'thumb', path, name: base } : { kind: 'drawn', name: base };
  }
  return { kind: 'drawn', name: 'x.app' };
};

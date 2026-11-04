// The big picture the preview pane draws for a file it cannot (or may not) play inline: the
// 256 px thumbnail Rust makes (`image_thumbs.rs` everywhere, QuickLook on a Mac). ⛔ This used to
// be missing: a Mac video drew a bare `<video>` that has no size until its data loads (a ~32 px
// control strip when it never does), and `.m4v`, which `preview-kinds.ts` does not list, fell to
// the 32 px glyph. Both now get the same large box an image gets.
import type { FileEntry } from '$lib/types/fs';
import type { PreviewKind } from '$lib/types/preview';
import { thumbUrl } from '$lib/api/icons';
import { isArchivePath } from '$lib/utils/archive-location';
import { DRAWN_FILE_ICONS, extensionOf, isDecodedThumbnail } from '$lib/utils/file-icon';
import { thumbStamp } from '$lib/utils/thumb-stamp';

const SHELL_THUMB_EXTS = ['heic', 'heif', 'tif', 'tiff', 'avif'];

/**
 * Whether the preview box should ask for the file's thumbnail: a video (as its poster, the
 * player keeps working on top) or a kind the pane has no renderer for, when Rust can make one.
 * Images, audio, PDF and text render themselves and never ask.
 */
export const wantsPosterThumb = (
  entry: Pick<FileEntry, 'name' | 'isDir'> & { path?: string },
  kind: PreviewKind,
  mac?: boolean,
  drawn: boolean = DRAWN_FILE_ICONS,
): boolean => {
  // a row inside an archive has no file for Rust to thumbnail (its path holds a NUL)
  if (entry.isDir || (entry.path !== undefined && isArchivePath(entry.path))) return false;
  if (kind !== 'video' && kind !== 'none') return false;
  // Windows draws shell icons (`drawn` false) and its shell thumbnailer reads HEIC, AVIF and
  // TIFF, which the pane has no renderer for: ask for the shell thumbnail
  if (!drawn && kind === 'none' && SHELL_THUMB_EXTS.includes(extensionOf(entry.name) ?? '')) {
    return true;
  }
  return isDecodedThumbnail(entry.name, mac);
};

/**
 * The 256 px thumbnail URL the ⌘K palette's preview card draws as a full-size picture, or '' when
 * the row has none. ⛔ The card skipped `wantsPosterThumb`, so a Mac HEIC (preview kind 'none')
 * fell to `EntryIcon` in a 64 px box: a stamp-sized picture in a big card. Same rule as the
 * explorer pane's poster, so both draw it as large as an image.
 */
export const posterThumbSrc = (
  entry: Pick<FileEntry, 'name' | 'isDir' | 'path' | 'size' | 'modifiedMs'>,
  kind: PreviewKind,
  mac?: boolean,
  drawn: boolean = DRAWN_FILE_ICONS,
): string =>
  wantsPosterThumb(entry, kind, mac, drawn) ? thumbUrl(entry.path, 256, thumbStamp(entry)) : '';

/**
 * Whether the Details (i) pane's header draws the file's 256 px thumbnail as a large picture
 * (Finder's Get Info look) instead of the 32 px icon. ⛔ It drew every file at 32 px, so on a Mac
 * a selected photo or clip.mov / .mp4 / .m4v showed a postage-stamp frame above its name
 * (installed 4351efd, 2026-10-07). Any file Rust can thumbnail asks; folders, Mac `.app` bundles
 * (isDir) and other files keep their icon. On Windows the pane draws shell icons
 * (`drawn` false), which have no decoded thumbnail, so it is unchanged there.
 */
export const wantsDetailsThumb = (
  entry: Pick<FileEntry, 'name' | 'isDir'> & { path?: string },
  drawn: boolean = DRAWN_FILE_ICONS,
  mac?: boolean,
): boolean => {
  if (entry.isDir || !drawn) return false;
  if (entry.path !== undefined && isArchivePath(entry.path)) return false;
  return isDecodedThumbnail(entry.name, mac);
};

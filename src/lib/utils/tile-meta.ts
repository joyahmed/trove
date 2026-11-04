// The muted line under a file's name in the Icons view. Off Windows a photo or clip Rust cannot
// draw (HEIC without QuickLook, WebM, MKV...) shows its glyph, so the line says so in the
// Gallery's wording instead of leaving the glyph unexplained.
import { fileCategoryOf } from '$lib/data/file-categories';
import type { FileIconKind } from './file-icon';
import { isDecodedThumbnail } from './file-icon';
import { tileLabel } from './tile-label';

/** `1.2 MB`, or the Gallery's `HEIC · no preview` for an image/video that is only drawn as a glyph. */
export const tileMetaLine = (
  name: string,
  size: string,
  kind: FileIconKind,
  mac?: boolean,
): string => {
  if (kind !== 'drawn') return size;
  const cat = fileCategoryOf(name);
  return (cat === 'image' || cat === 'video') && !isDecodedThumbnail(name, mac)
    ? tileLabel(name, true, mac)
    : size;
};

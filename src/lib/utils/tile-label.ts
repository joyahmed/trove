// The wording for a tile without a picture, shared by the Gallery and the file list's Icons view
// so "HEIC · no preview" reads the same in both (plan 15 G.57).
import { extensionOf, isDecodedThumbnail } from './file-icon';

/**
 * The words under a Gallery tile's glyph, so a tile without a picture reads as "this kind has
 * no preview here" and not as a thumbnail still on its way (Mac: two photos and a video that
 * "never" loaded, Mac 16a32d4). Off Windows Rust draws only `DECODED_THUMBNAIL_EXTS` (and on a
 * Mac QuickLook adds HEIC, TIFF and most video, `QUICKLOOK_THUMBNAIL_EXTS`); the rest keep
 * their glyph for good, so they say so. A decodable kind names only
 * its type: the label sits behind the picture and shows only if the picture never comes (too
 * big, unreadable).
 */
export const tileLabel = (name: string, drawn: boolean, mac?: boolean): string => {
  const ext = extensionOf(name)?.toUpperCase() ?? 'FILE';
  return drawn && !isDecodedThumbnail(name, mac) ? `${ext} · no preview` : ext;
};

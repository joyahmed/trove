// Which icon the preview pane and the Details (i) pane draw for their subject, decided by the
// same rules the list and the sidebar use so they never disagree.
//   'bin'    the Trash / Recycle Bin, as the place OR as its folder on disk (~/.Trash)
//   'folder' a real folder, or the generic place folder
//   'entry'  EntryIcon decides: a file's icon, or a Mac `Foo.app`'s app glyph (fileIconKind)
import type { FileEntry } from '$lib/types/fs';
import type { Location } from '$lib/types/location';
import { isAppBundle } from '$lib/utils/app-bundle';
import { fileIconKind } from '$lib/utils/file-icon';
import { onMac, onWindows } from '$lib/utils/platform';

export type PreviewIcon = 'bin' | 'folder' | 'entry';
type Platform = Parameters<typeof onMac>[0];

/**
 * The folder the OS keeps deleted files in, opened as a plain path. Mac: `~/.Trash` and a
 * volume's `.Trashes/<uid>`. Linux (freedesktop): `~/.local/share/Trash` (or its `files`) and a
 * volume's `.Trash-<uid>`. Windows: a drive's `$Recycle.Bin` (or one user's SID folder in it).
 */
export const isTrashPath = (path: string, platform?: Platform): boolean => {
  const p = path.replace(/[\\/]+$/, '');
  if (onWindows(platform)) return /\\\$Recycle\.Bin(\\S-[^\\]+)?$/i.test(p);
  if (onMac(platform)) return /\/\.Trash$/.test(p) || /\/\.Trashes\/\d+$/.test(p);
  return /\/\.local\/share\/Trash(\/files)?$/.test(p) || /\/\.Trash-\d+(\/files)?$/.test(p);
};

/** The icon for the selected entry (a bundle is NOT a plain folder just because isDir is true). */
export const previewEntryIcon = (
  entry: Pick<FileEntry, 'isDir' | 'iconKey' | 'name'> & Partial<Pick<FileEntry, 'path'>>,
  drawn?: boolean,
  platform?: Platform,
): PreviewIcon => {
  if (entry.isDir && entry.path !== undefined && isTrashPath(entry.path, platform)) return 'bin';
  return entry.isDir && fileIconKind(entry, drawn, platform) === 'folder' ? 'folder' : 'entry';
};

/** The icon for "nothing selected": the Trash place (or its folder) gets the bin, the rest the folder. */
export const previewPlaceIcon = (location: Location, platform?: Platform): PreviewIcon =>
  location.kind === 'recycle-bin' ||
  (location.kind === 'path' && isTrashPath(location.path, platform))
    ? 'bin'
    : 'folder';

/**
 * The Details (i) pane's icon for what its properties describe. ⛔ It used to test only
 * `props.isDir`, so a Mac `Calculator.app` drew the yellow folder even after the preview pane was
 * fixed (f67f5a2 fixed PreviewPane only; the Mac, 16a32d4).
 */
export const detailsIcon = (
  props: { isDir: boolean; name: string; path: string },
  platform?: Platform,
): PreviewIcon => {
  if (props.isDir && isTrashPath(props.path, platform)) return 'bin';
  return props.isDir && !isAppBundle(props, platform) ? 'folder' : 'entry';
};

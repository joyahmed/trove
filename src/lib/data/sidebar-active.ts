// Which sidebar row is highlighted: derived from where the tab is, never remembered from a click.
// A row is lit when its place or folder is the tab's current one; no match lights nothing.
import type { Location } from '$lib/types/location';
import { folderKey } from '$lib/utils/path';

type Platform = Parameters<typeof folderKey>[1];

/** Same place, or same folder after folding case (Windows only), separators and trailing slashes. */
export const isActiveLocation = (
  current: Location,
  row: Location | undefined,
  platform?: Platform,
): boolean => {
  if (!row || current.kind !== row.kind) return false;
  if (current.kind !== 'path' || row.kind !== 'path') return true;
  if (!current.path || !row.path) return false;
  return folderKey(current.path, platform) === folderKey(row.path, platform);
};

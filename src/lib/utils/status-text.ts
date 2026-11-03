// The words in the status bar, as pure functions: the left side counts and sizes the selection,
// the right side says how much room is left on the drive that holds the current folder.
import type { FileEntry } from '$lib/types/fs';
import type { DriveInfo, FolderSpace } from '$lib/types/shell';
import { fmtSize, fmtSpace } from '$lib/utils/format';
import { folderKey } from '$lib/utils/path';
import { onWindows } from '$lib/utils/platform';

type Platform = Parameters<typeof onWindows>[0];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The folded path with its trailing separator dropped: `c:\` → `c:`, `/` → `''`. */
const stem = (path: string, platform?: Platform) =>
  folderKey(path, platform).replace(/[\\/]+$/, '');

/**
 * "48 items" with nothing selected; "1 of 48 selected · 4.2 MB" with some. The size is the
 * selected files'; a folder counts as selected but adds none, and a selection of folders only
 * has no size to show. `entries` are the rows the selection can come from.
 */
export const selectionText = (
  selected: ReadonlySet<string>,
  entries: readonly FileEntry[],
  total: number,
): string => {
  if (selected.size === 0) return plural(total, 'item');
  let bytes = 0;
  let files = 0;
  for (const e of entries) {
    if (!selected.has(e.path) || e.isDir) continue;
    bytes += e.size;
    files++;
  }
  const head = `${selected.size} of ${total} selected`;
  return files > 0 ? `${head} · ${fmtSize(bytes)}` : head;
};

/** The drive holding `path`: the one with the longest path prefix; null when none does. */
export const driveHolding = (
  path: string,
  drives: readonly DriveInfo[],
  platform?: Platform,
): DriveInfo | null => {
  const sep = onWindows(platform) ? '\\' : '/';
  const key = stem(path, platform);
  let best: DriveInfo | null = null;
  let bestLen = -1;
  for (const d of drives) {
    const root = stem(d.path, platform);
    const holds = key === root || key.startsWith(root + sep);
    if (holds && root.length > bestLen) {
      best = d;
      bestLen = root.length;
    }
  }
  return best;
};

/** `G:\x\y` → `G:` (the letter keeps the case it was written in). */
const driveLetter = (path: string) => /^([A-Za-z]:)/.exec(path)?.[1] ?? null;

/**
 * "412 GB free on G:" — Windows names the drive letter, macOS the volume, Linux the mount's
 * label or else its path. '' when no drive holds the folder or its free space is unknown.
 *
 * `own` is the OS's answer for the folder itself (`folderSpace`). Off Windows it wins: its
 * free bytes, and the name of the listed drive mounted at its root — or, for a volume the list
 * leaves out (a Mac disk image, a hidden Linux mount), the mount root's last part
 * (`/Volumes/TroveTest` → `TroveTest`). The longest-prefix guess alone named the boot disk.
 */
export const freeSpaceText = (
  path: string,
  drives: readonly DriveInfo[],
  platform?: Platform,
  own?: FolderSpace | null,
): string => {
  if (own && !onWindows(platform)) {
    const root = stem(own.mountRoot, platform);
    const listed = drives.find((d) => stem(d.path, platform) === root);
    const name = listed
      ? listed.label.trim() || listed.path
      : (own.mountRoot.split('/').filter(Boolean).pop() ?? '/');
    return `${fmtSpace(own.freeBytes)} free on ${name}`;
  }
  const drive = driveHolding(path, drives, platform);
  if (drive === null || drive.freeBytes === null) return '';
  const name = onWindows(platform)
    ? (driveLetter(drive.path) ?? drive.label)
    : drive.label.trim() || drive.path;
  return `${fmtSpace(drive.freeBytes)} free on ${name}`;
};

/**
 * The bar for a place that filters its own tiles (Applications): "56 items" when every tile
 * shows, "1 of 56 items" while a filter hides some — the same "N of M" the selection line uses.
 */
export const filteredItemsText = (shown: number, total: number): string =>
  shown === total ? plural(total, 'item') : `${shown} of ${plural(total, 'item')}`;

// Explorer's per-folder view state — the half of "Group by" that makes Windows feel automatic.
//
// ⭐ Explorer's GLOBAL default is ungrouped too. What makes Downloads arrive already showing
// "Today / Yesterday / Last week" is its **folder template**: the Downloads template ships with
// *Group by: Date modified* on, and Explorer then remembers whatever you change **per folder**.
// Nobody ever turns grouping on; they just open Downloads. This file is both halves of that —
// `effectiveFolderView` seeds Downloads and nothing else, and `rememberFolderView` files a
// change under the folder it was made in.
//
// ⚠️ The seed is a DEFAULT, not a policy: an entry for the folder always wins, so turning
// Downloads' grouping off turns it off for good. A feature that kept putting the headings back
// would be a feature you fight.
//
// Pure on purpose — no state, no settings import. The store is `settings.folderViews`; the
// wiring is `state/tab.svelte.ts`.
import { isGroupKey, isSortKey, type SortKey } from '$lib/data/file-columns';
import type { IconSize, ViewMode } from '$lib/state/settings.svelte';
import { folderKey, parentOf } from '$lib/utils/path';
import type { onWindows } from '$lib/utils/platform';

type Platform = Parameters<typeof onWindows>[0];

// a copy of settings' VIEW_MODES plus `gallery`, a per-folder choice (plan 15 G.52) that is not valid
// as the global default: settings imports this file, so a value import back would cycle
const VIEW_MODES: readonly ViewMode[] = [
  'details',
  'list',
  'grid',
  'small',
  'tiles',
  'content',
  'gallery',
];
const ICON_SIZE_VALUES: IconSize[] = [48, 96, 256];

/** The sort and grouping a folder is looked at with. The three travel together because grouping
 *  detached from its sort is meaningless: "Group by date" with the rows in name order is not
 *  what anyone asked for. */
export interface FolderViewState {
  /** the column the headings divide on; `null` is Explorer's "(None)" — one flat run of rows */
  groupKey: SortKey | null;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
}

/** How a folder is laid out: Details / List / Icons and the icon size. Resolved, never null. */
export interface FolderLayout {
  view: ViewMode;
  iconSize: IconSize;
}

/**
 * One folder's remembered view. `path` is always `folderKey`-normalised. `view` and `iconSize`
 * are `null` while the layout was never changed in this folder (an older file, or only the sort
 * was touched): null means "follow the global default", so the folder keeps tracking it.
 */
export interface FolderView extends FolderViewState {
  path: string;
  view: ViewMode | null;
  iconSize: IconSize | null;
}

/**
 * How many folders keep their own view. 200, because:
 *  - an entry is a path plus three short fields — under ~120 bytes of JSON, so the cap costs at
 *    most ~20 KB in a file that is read **in full at every startup**. Uncapped, this map is the
 *    one field in `settings.json` that grows for ever;
 *  - 200 distinct folders is far more than anyone revisits and expects to find as they left it.
 *    Windows caps its own bag MRU for exactly this reason.
 * Enforced on write AND on load, so a hand-edited or an older, larger file cannot get past it.
 */
export const MAX_FOLDER_VIEWS = 200;

/** Explorer's Downloads template is the one that ships grouped, and it groups by Date modified. */
export const SEEDED_GROUP_KEY: SortKey = 'modifiedMs';

/**
 * Whether this is *the* Downloads folder.
 *
 * ⚠️ `downloads` must come from the known-folder list (`places.downloadsPath`, which is
 * `FOLDERID_Downloads` by way of `core/shell.rs`) — never from matching the folder's NAME. A
 * folder of Joy's called `D:\Downloads` is not the Downloads folder, and a Downloads folder
 * that has been moved elsewhere still is.
 */
export const isDownloadsFolder = (path: string, downloads: string | null): boolean => {
  const key = folderKey(path);
  return key !== '' && downloads !== null && key === folderKey(downloads);
};

/** The folder's own remembered view, or null when it has never been looked at differently. */
export const findFolderView = (
  views: FolderView[],
  path: string,
  platform?: Platform,
): FolderView | null => {
  const key = folderKey(path, platform);
  if (key === '') return null;
  return views.find((v) => v.path === key) ?? null;
};

/**
 * The view a folder follows: its own entry, else the entry of its NEAREST ancestor that has one
 * (plan 08 F4 - the inheritable default). `parentOf` walks the normalised key, so a drive letter,
 * backslashes and case (Windows folds it, POSIX keeps it) are handled the way every other path
 * in the app is. A folder with its own entry never looks further up: its view wins whole.
 */
export const nearestFolderView = (
  views: FolderView[],
  path: string,
  platform?: Platform,
): FolderView | null => {
  let key: string | null = folderKey(path, platform);
  while (key !== null && key !== '') {
    const hit = views.find((v) => v.path === key);
    if (hit) return hit;
    key = parentOf(key, platform);
  }
  return null;
};

/** Whether `path` lies strictly below `ancestor` (both `folderKey`-normalised on the way in). */
export const isBelow = (path: string, ancestor: string, platform?: Platform): boolean => {
  const top = folderKey(ancestor, platform);
  if (top === '') return false;
  let key = parentOf(folderKey(path, platform), platform);
  while (key !== null) {
    if (folderKey(key, platform) === top) return true;
    key = parentOf(key, platform);
  }
  return false;
};

/**
 * What this folder is shown with: its own remembered view, else the nearest ancestor's, else the
 * Downloads seed, else the
 * global defaults exactly as before this existed.
 */
export const effectiveFolderView = (
  path: string,
  views: FolderView[],
  downloads: string | null,
  defaults: FolderViewState & FolderLayout,
): FolderViewState & FolderLayout => {
  const stored = nearestFolderView(views, path);
  if (stored !== null) {
    return {
      groupKey: stored.groupKey,
      sortKey: stored.sortKey,
      sortDir: stored.sortDir,
      view: stored.view ?? defaults.view,
      iconSize: stored.iconSize ?? defaults.iconSize,
    };
  }
  if (isDownloadsFolder(path, downloads)) return { ...defaults, groupKey: SEEDED_GROUP_KEY };
  return defaults;
};

/**
 * File a folder's view, most-recently-changed first, replacing any entry it already had.
 *
 * ⚠️ The order is by last **change**, not last visit, and that is deliberate: touching the list
 * on every navigation would mean a settings write on every navigation — an IPC round trip per
 * folder you click, for nothing anyone can see. It also makes the eviction rule safe by
 * construction: the folder just changed is at the head, so the cap can never drop the one you
 * are standing in.
 *
 * A place (path `''`) has no folder to file anything under and is returned unchanged.
 */
export const rememberFolderView = (
  views: FolderView[],
  path: string,
  view: FolderViewState & Partial<FolderLayout>,
): FolderView[] => {
  const key = folderKey(path);
  if (key === '') return views;
  const old = findFolderView(views, key);
  const rest = views.filter((v) => v.path !== key);
  // a sort/group change keeps the layout the folder already had; a layout change keeps the sort
  const entry: FolderView = {
    path: key,
    groupKey: view.groupKey,
    sortKey: view.sortKey,
    sortDir: view.sortDir,
    view: view.view ?? old?.view ?? null,
    iconSize: view.iconSize ?? old?.iconSize ?? null,
  };
  return [entry, ...rest].slice(0, MAX_FOLDER_VIEWS);
};

/**
 * "Apply to subfolders": file `view` under `path` AND forget every view remembered below it, so
 * all of those folders go back to following this one (they inherit it, see `nearestFolderView`).
 * Views of unrelated folders are untouched. A place (`''`) is returned unchanged.
 */
export const applyFolderViewToSubfolders = (
  views: FolderView[],
  path: string,
  view: FolderViewState & Partial<FolderLayout>,
  platform?: Platform,
): FolderView[] => {
  if (folderKey(path, platform) === '') return views;
  const kept = views.filter((v) => !isBelow(v.path, path, platform));
  return rememberFolderView(kept, path, view);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * The stored map, checked field by field like every other setting: a hand-edited or an older
 * file must not be able to group a folder by a column that does not exist.
 *
 * An entry whose `sortKey` is unusable is DROPPED whole rather than half-honoured — the three
 * fields are one view, and a grouping applied to a sort nobody chose is worse than the folder
 * simply falling back to the global defaults. A missing or bad `groupKey` becomes `null`, which
 * is a real value here ("(None)"), not an absence. Duplicates after normalisation keep the first
 * — the file is most-recent-first, so the first is the newest.
 */
export const sanitizeFolderViews = (raw: unknown): FolderView[] => {
  if (!Array.isArray(raw)) return [];
  const out: FolderView[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length === MAX_FOLDER_VIEWS) break;
    if (!isRecord(entry) || typeof entry.path !== 'string') continue;
    const key = folderKey(entry.path);
    if (key === '' || seen.has(key) || !isSortKey(entry.sortKey)) continue;
    seen.add(key);
    out.push({
      path: key,
      groupKey: isGroupKey(entry.groupKey) ? entry.groupKey : null,
      sortKey: entry.sortKey,
      sortDir: entry.sortDir === 'desc' ? 'desc' : 'asc',
      view: VIEW_MODES.includes(entry.view as ViewMode) ? (entry.view as ViewMode) : null,
      iconSize: ICON_SIZE_VALUES.includes(entry.iconSize as IconSize)
        ? (entry.iconSize as IconSize)
        : null,
    });
  }
  return out;
};

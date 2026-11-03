import type { FileEntry } from '$lib/types/fs';
import { dimensionsText } from '$lib/state/dimensions.svelte';
import { folderSizeText } from '$lib/state/folder-sizes.svelte';
import { shownName } from '$lib/utils/app-bundle';
import { fmtDate, fmtSize } from '$lib/utils/format';
import { parentOf, toLinuxForm } from '$lib/utils/path';
import { shortKindOf } from '$lib/utils/short-kind';

/** `path` sorts by the containing folder — the Folder column of search results. */
export type SortKey = 'name' | 'modifiedMs' | 'createdMs' | 'ext' | 'size' | 'dims' | 'path';

export interface FileColumn {
  key: SortKey;
  label: string;
  /** px at 100 %, Explorer's defaults; the user's override lives in settings.columnWidths */
  defaultWidth: number;
  minWidth: number;
  align: 'left' | 'right';
  cell: (e: FileEntry) => string;
}

/**
 * Every column the details view can show, in Explorer's order. Which of them are on is
 * `settings.columns` — `state/listing` filters this list — and the header's right-click menu
 * is this array with a checkmark each. Date created and Dimensions are off by default, as in Explorer.
 */
export const fileColumns: FileColumn[] = [
  {
    key: 'name',
    label: 'Name',
    defaultWidth: 245,
    minWidth: 120,
    align: 'left',
    cell: shownName,
  },
  {
    key: 'modifiedMs',
    label: 'Date modified',
    defaultWidth: 140,
    minWidth: 80,
    align: 'left',
    cell: (e) => fmtDate(e.modifiedMs),
  },
  {
    key: 'createdMs',
    label: 'Date created',
    defaultWidth: 140,
    minWidth: 80,
    align: 'left',
    cell: (e) => fmtDate(e.createdMs),
  },
  {
    key: 'ext',
    label: 'Type',
    defaultWidth: 118,
    minWidth: 60,
    align: 'left',
    // the short kind, same on every OS; the shell's `typeName` stays on the entry for the details pane
    cell: (e) => shortKindOf(e),
  },
  {
    key: 'size',
    label: 'Size',
    defaultWidth: 80,
    minWidth: 50,
    align: 'right',
    // a folder's counted contents, filled in after the rows paint (`state/folder-sizes`)
    cell: (e) => (e.isDir ? folderSizeText(e) : fmtSize(e.size)),
  },
  {
    // images only (width × height from the file header, read lazily); blank for everything else
    key: 'dims',
    label: 'Dimensions',
    defaultWidth: 110,
    minWidth: 70,
    align: 'left',
    cell: dimensionsText,
  },
];

/** Search results only: where each hit lives. `state/listing` slots it in after Name. */
export const pathColumn: FileColumn = {
  key: 'path',
  label: 'Folder',
  defaultWidth: 240,
  minWidth: 120,
  align: 'left',
  // a WSL hit shows its folder the way the address bar does: `Ubuntu:/home/alex`
  cell: (e) => {
    const parent = parentOf(e.path) ?? '';
    return toLinuxForm(parent) ?? parent;
  },
};

/** Every column that can have a width, for `state/columns`. */
export const allColumns: FileColumn[] = [...fileColumns, pathColumn];

/** What a fresh profile shows: Explorer's four. The rest are a right-click away. */
export const DEFAULT_COLUMNS: SortKey[] = ['name', 'modifiedMs', 'ext', 'size'];

/** Name can never be turned off — a list of dates with no names is not a list. */
export const REQUIRED_COLUMN: SortKey = 'name';

/** A stored value that names a real column. Lives here, beside `allColumns`, because both the
 *  settings loader and the per-folder view loader (`utils/folder-views`) have to check it. */
export const isSortKey = (v: unknown): v is SortKey => allColumns.some((c) => c.key === v);

/** Group by offers what the details view shows, minus the two with no buckets: the Folder column
 *  is search's alone (as in `sanitizeColumns`) and Dimensions has no Explorer group. A hand-edited
 *  file naming either groups by nothing instead. */
export const isGroupKey = (v: unknown): v is SortKey =>
  isSortKey(v) && v !== 'path' && v !== 'dims';

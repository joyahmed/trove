// What the bin view shows per OS, as plain functions. Windows and Linux: Name, Original location,
// Date deleted, with Restore. The macOS Trash records no original location and no deletion date,
// so there: Name, Kind, Size, Date modified, and no Restore (S1, 2026-10-06).
import type { RecycleItem } from '$lib/types/recycle';
import { fmtSize } from '$lib/utils/format';

/** Menu and header keys that put items back or go to where they came from. */
const RESTORE_KEYS = new Set(['restore', 'restore-all', 'open-location']);

/** The column set: `bin` has an original location, `trash` (macOS) does not. */
export type RecycleLayout = 'bin' | 'trash';

export const recycleLayout = (mac: boolean): RecycleLayout => (mac ? 'trash' : 'bin');

/** Restore can be offered for these items: not on macOS, and only for items whose original
 *  folder is known. */
export const canRestore = (mac: boolean, items: readonly RecycleItem[]): boolean =>
  !mac && items.every((i) => i.originalParent !== null);

/** Drop the restore-type entries (and a divider left leading or trailing) when restore is off. */
export const withoutRestore = <T extends { key: string; kind?: string }>(
  entries: readonly T[],
  restore: boolean,
): T[] => {
  if (restore) return [...entries];
  const kept = entries.filter((e) => !RESTORE_KEYS.has(e.key));
  while (kept.length > 0 && kept[0].kind === 'divider') kept.shift();
  while (kept.length > 0 && kept[kept.length - 1].kind === 'divider') kept.pop();
  return kept;
};

/** "Folder", "PDF file", "File" — the kind column of the macOS Trash. */
export const kindText = (item: RecycleItem): string => {
  if (item.isDir) return 'Folder';
  const i = item.name.lastIndexOf('.');
  const ext = i > 0 ? item.name.slice(i + 1) : '';
  return ext && !ext.includes(' ') ? `${ext.toUpperCase()} file` : 'File';
};

/** The size column: bytes where known, "—" where not (folders are not walked). */
export const sizeText = (item: RecycleItem): string =>
  item.size === null ? '—' : fmtSize(item.size);

/** Where the item came from, or "—" when the OS does not say. */
export const originText = (item: RecycleItem): string => item.originalParent ?? '—';

/** The cell a column shows. `date` is "Date deleted" in the bin and "Date modified" in the Trash. */
export type RecycleColumnKey = 'name' | 'origin' | 'kind' | 'size' | 'date';

/** One column: its header, the narrowest it may get, and how it shares spare room.
 *  `grow: 0` holds the column at exactly `min`. */
export interface RecycleColumn {
  key: RecycleColumnKey;
  label: string;
  min: number;
  grow: number;
  align?: 'right';
}

const NAME: RecycleColumn = { key: 'name', label: 'Name', min: 160, grow: 3 };

const COLUMNS: Record<RecycleLayout, readonly RecycleColumn[]> = {
  bin: [
    NAME,
    { key: 'origin', label: 'Original location', min: 140, grow: 3 },
    { key: 'date', label: 'Date deleted', min: 160, grow: 0 },
  ],
  trash: [
    NAME,
    { key: 'kind', label: 'Kind', min: 90, grow: 2 },
    { key: 'size', label: 'Size', min: 96, grow: 0, align: 'right' },
    { key: 'date', label: 'Date modified', min: 160, grow: 0 },
  ],
};

/** Which column goes first when the list is too narrow for all of them. Name never goes:
 *  in the bin the date goes before where it came from (Restore needs the place); in the
 *  Trash the kind goes first (the name's extension says most of it), then the date, then size. */
const DROP_ORDER: Record<RecycleLayout, readonly RecycleColumnKey[]> = {
  bin: ['date', 'origin'],
  trash: ['kind', 'date', 'size'],
};

/** The columns that fit in `width` px of list, each at least its `min`. Lower-priority columns
 *  are hidden rather than squashing Name to a few letters (plan 15 A.5.10: at 800 px with the
 *  details pane open Name showed "a-r…"). A width of 0 or less means not measured yet: all. */
export const visibleColumns = (layout: RecycleLayout, width: number): RecycleColumn[] => {
  const shown = [...COLUMNS[layout]];
  if (width <= 0) return shown;
  const need = () => shown.reduce((sum, c) => sum + c.min, 0);
  for (const key of DROP_ORDER[layout]) {
    if (need() <= width) break;
    shown.splice(
      shown.findIndex((c) => c.key === key),
      1,
    );
  }
  return shown;
};

/** A column's flex: it starts at its `min` and takes spare room by `grow`. It only shrinks
 *  below `min` once nothing is left to hide (Name alone in a list narrower than 160 px). */
export const columnFlex = (col: RecycleColumn): string => `${col.grow} 1 ${col.min}px`;

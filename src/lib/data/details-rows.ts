// The Details pane's rows, as data: label + what to show, in Explorer's order. A row whose
// value is null is not rendered (a file has no "Contains", a folder no "Size on disk").
import type { Props } from '$lib/types/props';
import type { Totals } from '$lib/state/details.svelte';
import { fmtDate, fmtSize } from '$lib/utils/format';
import { archiveRowWhere, isArchivePath } from '$lib/utils/archive-location';
import { parentOf } from '$lib/utils/path';
import { onWindows } from '$lib/utils/platform';
import type { RecycleItem } from '$lib/types/recycle';
import { kindText } from '$lib/components/places/recycle-parts/recycle-columns';

export interface DetailsRow {
  key: string;
  label: string;
  value: (props: Props, totals: Totals | null) => string | null;
}

const bytes = (n: number) => `${fmtSize(n)} (${n.toLocaleString()} bytes)`;

/** "3 files, 2 folders", with an ellipsis while the count is still running. */
export const fmtContains = (t: Totals) => {
  const files = `${t.files.toLocaleString()} file${t.files === 1 ? '' : 's'}`;
  const folders = `${t.folders.toLocaleString()} folder${t.folders === 1 ? '' : 's'}`;
  return `${files}, ${folders}${t.done ? '' : '…'}`;
};

/** "1 folder not counted": a Mac media library or ~/Library, counted as an item, never sized. */
export const notCountedNote = (t: { notCounted: number }): string =>
  t.notCounted > 0
    ? ` · size not counted for ${t.notCounted.toLocaleString()} folder${t.notCounted === 1 ? '' : 's'}`
    : '';

/** Only the protected folder itself was found, nothing walked: every total is 0 and means "unknown". */
export const nothingCounted = (t: Totals): boolean =>
  t.done && t.notCounted > 0 && t.files === 0 && t.folders === 0;

/** A folder's Size: the walked bytes and the "still counting" ellipsis. What was not walked is
 *  its own row (`notCountedRow`), so the value never grows a tail the pane cuts off. */
export const folderSize = (t: Totals): string =>
  nothingCounted(t) ? 'Size not counted' : `${bytes(t.bytes)}${t.done ? '' : '…'}`;

/** "1 folder": its own row beside a counted size ("Not counted"). */
export const notCountedRow = (t: Totals): string | null =>
  t.notCounted > 0 && !nothingCounted(t)
    ? `${t.notCounted.toLocaleString()} folder${t.notCounted === 1 ? '' : 's'}`
    : null;

/** The Trash place's summary: "12 items · 340 MB", or "Empty". Size is the known sizes only. */
export const recycleSummary = (items: { size: number | null }[]): string => {
  if (items.length === 0) return 'Empty';
  const n = `${items.length.toLocaleString()} item${items.length === 1 ? '' : 's'}`;
  const known = items.filter((i) => i.size !== null);
  if (known.length === 0) return n;
  return `${n} · ${fmtSize(known.reduce((a, i) => a + (i.size ?? 0), 0))}`;
};

/** The one bin item the Details pane shows: exactly one selected and still in the bin, else
 *  null (0 or several keep the bin summary). */
export const recycleSelectedItem = (
  items: readonly RecycleItem[],
  selected: ReadonlySet<string>,
): RecycleItem | null => {
  if (selected.size !== 1) return null;
  const [id] = selected;
  return items.find((i) => i.id === id) ?? null;
};

/** A bin item's rows, as the pane shows a file: Type, Original location and Date deleted (the
 *  list hides Date deleted at narrow widths, so the pane is where it can always be read); the
 *  macOS Trash has no original location and its date is the last modified one. Size where known. */
export const recycleItemRows = (
  item: RecycleItem,
  mac: boolean,
): { key: string; label: string; value: string }[] => {
  const rows: { key: string; label: string; value: string | null }[] = [
    { key: 'type', label: 'Type', value: kindText(item) },
    { key: 'origin', label: 'Original location', value: mac ? null : item.originalParent },
    { key: 'date', label: mac ? 'Date modified' : 'Date deleted', value: fmtDate(item.deletedMs) },
    { key: 'size', label: 'Size', value: item.size === null ? null : bytes(item.size) },
  ];
  return rows.filter((r): r is { key: string; label: string; value: string } => !!r.value);
};

export const detailsRows: DetailsRow[] = [
  { key: 'type', label: 'Type', value: (p) => p.typeName },
  { key: 'location', label: 'Location', value: (p) => archiveRowWhere(p.path) ?? parentOf(p.path) },
  {
    key: 'size',
    label: 'Size',
    value: (p, t) => (p.isDir ? (t ? folderSize(t) : null) : bytes(p.size)),
  },
  {
    key: 'notCounted',
    label: 'Not counted',
    value: (p, t) => (p.isDir && t ? notCountedRow(t) : null),
  },
  {
    key: 'sizeOnDisk',
    label: 'Size on disk',
    value: (p, t) =>
      // a file inside an archive takes no disk space of its own
      isArchivePath(p.path)
        ? null
        : p.isDir
          ? t?.done && !nothingCounted(t)
            ? bytes(t.sizeOnDisk)
            : null
          : bytes(p.sizeOnDisk),
  },
  {
    key: 'contains',
    label: 'Contains',
    value: (p, t) => (p.isDir && t && !nothingCounted(t) ? fmtContains(t) : null),
  },
  { key: 'created', label: 'Created', value: (p) => fmtDate(p.createdMs) || null },
  { key: 'modified', label: 'Modified', value: (p) => fmtDate(p.modifiedMs) || null },
  { key: 'accessed', label: 'Accessed', value: (p) => fmtDate(p.accessedMs) || null },
];

export interface AttributeToggleDef {
  key: 'readOnly' | 'hidden';
  label: string;
}

/** Windows has two attribute bits. Elsewhere only the write permission is real: a dot-file is
 *  hidden by its name, not by a flag, so there is no Hidden box to flip. The box is ticked when
 *  YOU may not write the item (Rust asks `access(W_OK)`). ⛔ Not "Locked": that is Finder's
 *  own lock flag (uchg), a different thing, and next to an empty box it read as a statement
 *  (the Mac, ~/.cocoapods, 16a32d4). */
export const attributeToggles = (): AttributeToggleDef[] =>
  onWindows()
    ? [
        { key: 'readOnly', label: 'Read-only' },
        { key: 'hidden', label: 'Hidden' },
      ]
    : [{ key: 'readOnly', label: 'Read-only' }];

/** The heading over those boxes: "Attributes" is Windows' word; Mac and Linux have permissions. */
export const attributesHeading = (): string => (onWindows() ? 'Attributes' : 'Permissions');

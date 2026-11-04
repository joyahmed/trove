// The hover infotip's fields, as data: a label and what to read off one entry. Explorer's
// infotip shows Type, Size and Date modified; Date created is added because it is the field
// Joy asked for by name and the one Explorer omits.
//
// A field whose value is null is not rendered. A file reads every field off the listing; a
// folder's Size is the exception — the listing carries 0 for a directory and the real number
// needs the recursive walk `props.rs` makes a cancellable job of (`start_folder_totals`). The
// card runs that job on dwell and hands its running total in here, so Size arrives in stages
// rather than being dropped; with no walk (a file, or a card that has not started one) the
// second argument is null and a folder's row disappears exactly as before.
import { cloudStateText } from '$lib/data/cloud-states';
import { notCountedNote } from '$lib/data/details-rows';
import type { FolderSize } from '$lib/hooks/use-infotip.svelte';
import type { FileEntry } from '$lib/types/fs';
import { fmtDate, fmtSize } from '$lib/utils/format';

export interface InfotipField {
  key: string;
  label: string;
  /** null = this entry has nothing to say here, so the row is dropped */
  value: (entry: FileEntry, folder: FolderSize | null) => string | null;
}

/**
 * The walk, in words. "Calculating…" until the first batch, then the number with the Details
 * pane's trailing ellipsis while it is still climbing (`data/details-rows.ts` marks an unfinished
 * count the same way), then the plain number once the walk is done.
 */
const folderSizeText = (folder: FolderSize | null): string | null => {
  if (!folder) return null;
  if (folder.bytes === null) return 'Calculating…';
  if (folder.done && folder.notCounted > 0 && folder.items === 0) return 'Size not counted';
  return `${fmtSize(folder.bytes)}${folder.done ? '' : '…'}${notCountedNote(folder)}`;
};

export const infotipFields: InfotipField[] = [
  { key: 'type', label: 'Type', value: (e) => e.typeName || null },
  {
    key: 'size',
    label: 'Size',
    value: (e, folder) => (e.isDir ? folderSizeText(folder) : fmtSize(e.size)),
  },
  { key: 'created', label: 'Date created', value: (e) => fmtDate(e.createdMs) || null },
  { key: 'modified', label: 'Date modified', value: (e) => fmtDate(e.modifiedMs) || null },
  // a OneDrive file says where its bytes are, in words; the badge on its icon says it in a glyph
  { key: 'cloud', label: 'Status', value: (e) => cloudStateText(e.cloudState) },
];

export interface InfotipRow {
  key: string;
  label: string;
  value: string;
}

/** The rows the card renders for this entry, in order, with the empty ones dropped. */
export const infotipRowsFor = (entry: FileEntry, folder: FolderSize | null = null): InfotipRow[] =>
  infotipFields.flatMap((f) => {
    const value = f.value(entry, folder);
    return value === null ? [] : [{ key: f.key, label: f.label, value }];
  });

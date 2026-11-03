// The text under the folder title: "<path> · 12 items · 3.4 MB". Pure, so it is tested alone.
import type { FileEntry } from '$lib/types/fs';
import { fmtSize } from '$lib/utils/format';

/** "1 item" / "12 items"; folders count as items. */
export const itemsText = (count: number): string => `${count} ${count === 1 ? 'item' : 'items'}`;

/**
 * The counts part: "12 items · 3.4 MB". The size is only shown when it is the folder's real
 * size, i.e. the folder holds files and no folders, so it is the number the Details pane counts.
 * ⛔ A subfolder's size is not in the listing (folders carry 0), so a files-only sum beside one
 * is wrong: /System/Applications (48 .app bundles, which are folders) said "49 items · 0 B" while
 * the (i) pane said 1.2 GB (the Mac, 16a32d4). Explorer's status bar shows no size there either.
 */
export const folderCounts = (entries: readonly FileEntry[]): string => {
  let bytes = 0;
  let files = 0;
  for (const e of entries) {
    if (e.isDir) return itemsText(entries.length);
    files++;
    bytes += e.size;
  }
  const parts = [itemsText(entries.length)];
  if (files > 0) parts.push(fmtSize(bytes));
  return parts.join(' · ');
};

/** The whole meta line (the tooltip's text). */
export const folderMeta = (path: string, entries: readonly FileEntry[]): string =>
  `${path} · ${folderCounts(entries)}`;

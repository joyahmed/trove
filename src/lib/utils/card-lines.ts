// The text lines under a name in Explorer's Tiles and Content views. Pure, so the views stay
// markup and the wording is tested once.
import type { FileEntry } from '$lib/types/fs';
import { fmtDate, fmtSize } from '$lib/utils/format';
import { shortKindOf } from '$lib/utils/short-kind';

type CardEntry = Pick<FileEntry, 'name' | 'isDir' | 'ext' | 'size' | 'modifiedMs'> &
  Partial<Pick<FileEntry, 'isLink' | 'typeName'>>;

/** Tiles: the type, then the size for a file ("Spreadsheet", "12 KB"); a folder has no size. */
export const tileLines = (e: CardEntry): string[] =>
  e.isDir ? [shortKindOf(e)] : [shortKindOf(e), fmtSize(e.size)];

/** Content's right-hand column: when it changed, and how big a file is. */
export const contentFacts = (e: CardEntry): { label: string; value: string }[] => {
  const facts = [{ label: 'Date modified', value: fmtDate(e.modifiedMs) }];
  if (!e.isDir) facts.push({ label: 'Size', value: fmtSize(e.size) });
  return facts.filter((f) => f.value !== '');
};

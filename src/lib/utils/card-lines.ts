// The text lines under a name in Explorer's Tiles and Content views. Pure, so the views stay
// markup and the wording is tested once.
import type { FileEntry } from '$lib/types/fs';
import { fmtDate, fmtSize } from '$lib/utils/format';
import { shortKindOf } from '$lib/utils/short-kind';
import type { FileIconKind } from '$lib/utils/file-icon';
import { tileMetaLine } from '$lib/utils/tile-meta';

type CardEntry = Pick<FileEntry, 'name' | 'isDir' | 'ext' | 'size' | 'modifiedMs'> &
  Partial<Pick<FileEntry, 'isLink' | 'typeName'>>;

/**
 * Tiles: the type, then the size for a file ("Spreadsheet", "12 KB"); a folder has no size.
 * `kind` is how the icon is drawn: an image/video the platform cannot draw says
 * "HEIC · no preview" in place of the size, the same rule as the Icons tile (`tileMetaLine`).
 */
export const tileLines = (e: CardEntry, kind?: FileIconKind, mac?: boolean): string[] =>
  e.isDir
    ? [shortKindOf(e)]
    : [shortKindOf(e), kind ? tileMetaLine(e.name, fmtSize(e.size), kind, mac) : fmtSize(e.size)];

/** Content's right-hand column: when it changed, and how big a file is. */
export const contentFacts = (e: CardEntry): { label: string; value: string }[] => {
  const facts = [{ label: 'Date modified', value: fmtDate(e.modifiedMs) }];
  if (!e.isDir) facts.push({ label: 'Size', value: fmtSize(e.size) });
  return facts.filter((f) => f.value !== '');
};

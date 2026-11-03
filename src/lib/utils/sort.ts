// The column sort, and the buckets Explorer's "Group by" puts the rows in. One Collator for the
// whole app: `localeCompare` with options builds one per call, which on a 100k-entry folder is
// the difference between a blink and a second.
import type { SortKey } from '$lib/data/file-columns';
import { dateAfter, sizePresets } from '$lib/data/search-filters';
import type { FileEntry } from '$lib/types/fs';
import { dimensions } from '$lib/state/dimensions.svelte';
import { folderSizes } from '$lib/state/folder-sizes.svelte';
import { parentOf } from '$lib/utils/path';
import { shortKindOf } from '$lib/utils/short-kind';

const names = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Columns compared as numbers; everything else is compared as text by the collator. */
const NUMERIC: SortKey[] = ['modifiedMs', 'createdMs', 'size', 'dims'];

/**
 * Columns on which Explorer keeps folders above files. Name only — sort a Downloads folder
 * by date and Explorer interleaves the folders with the files, which is the point: pinning
 * folders to the top buries the newest downloads under every folder in there.
 */
const GROUPS_FOLDERS: SortKey[] = ['name'];

/** The text a column sorts by — the Type column sorts by what it shows, not by the extension
 *  behind it ("Archive" before "Text", whatever the extensions sort like). */
const textOf = (e: FileEntry, key: SortKey): string => {
  if (key === 'path') return parentOf(e.path) ?? '';
  if (key === 'ext') return shortKindOf(e);
  return e.name;
};

/** A missing date sorts as the epoch, so blanks group at the old end rather than scattering.
 *  Dimensions sort by pixel count; a file with none (not an image, or not read yet) is 0. A
 *  folder sorts by its counted size once known; one not counted at all (the setting is off for
 *  its drive) is 0, as before. */
const numberOf = (e: FileEntry, key: SortKey): number => {
  if (key === 'size') {
    if (!e.isDir) return e.size;
    const s = folderSizes.of(e);
    return s === null || s === 'counting' ? 0 : s.bytes;
  }
  if (key === 'dims') {
    const d = dimensions.of(e);
    return d ? d[0] * d[1] : 0;
  }
  return (e[key as 'modifiedMs' | 'createdMs'] ?? 0) as number;
};

export interface SortOptions {
  /** Force folders above files on every column — the old behaviour, now a setting. */
  foldersFirst?: boolean;
}

/** `key` ordered as Explorer orders it; ties break on name so the list never shuffles. */
export const entryComparator = (
  key: SortKey,
  dir: 'asc' | 'desc',
  { foldersFirst = false }: SortOptions = {},
) => {
  const sign = dir === 'asc' ? 1 : -1;
  const group = foldersFirst || GROUPS_FOLDERS.includes(key);
  const numeric = NUMERIC.includes(key);
  return (a: FileEntry, b: FileEntry): number => {
    if (group && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    // a folder still being counted goes last whichever way, and moves in when its size lands
    if (key === 'size') {
      const ca = a.isDir && folderSizes.of(a) === 'counting';
      const cb = b.isDir && folderSizes.of(b) === 'counting';
      if (ca !== cb) return ca ? 1 : -1;
    }
    const cmp = numeric
      ? numberOf(a, key) - numberOf(b, key)
      : names.compare(textOf(a, key), textOf(b, key));
    return cmp === 0 ? names.compare(a.name, b.name) : cmp * sign;
  };
};

/**
 * Which way a column opens when it is clicked for the first time. Explorer opens the dates
 * and the size newest/largest first — a folder sorted by date is asked "what is new?" — and
 * the text columns A→Z.
 */
export const firstDirectionFor = (key: SortKey): 'asc' | 'desc' =>
  NUMERIC.includes(key) ? 'desc' : 'asc';

/** What a bucket cannot place: a date the OS never recorded, a folder's absent size, a blank Type. */
const UNSPECIFIED = 'Unspecified';

/** Explorer's relative date buckets, newest first; the last one is the catch-all. */
const DATE_BUCKETS = [
  'Today',
  'Yesterday',
  'Earlier this week',
  'Last week',
  'Earlier this month',
  'Last month',
  'Earlier this year',
  'A long time ago',
];

/**
 * The seven timestamps the buckets divide on, parallel to `DATE_BUCKETS` — a row belongs to the
 * first bucket whose edge it is not older than. Computed once per `now` rather than once per row:
 * grouping a 100k-entry folder asks for these the same 100k times with the same answer.
 */
let edgesAt = NaN;
let edges: number[] = [];

const dateEdges = (now: Date): number[] => {
  const at = now.getTime();
  if (at === edgesAt) return edges;
  const y = now.getFullYear();
  const m = now.getMonth();
  const week = new Date(dateAfter('thisweek', now));
  edges = [
    dateAfter('today', now),
    // built from the calendar rather than by subtracting 86_400_000, so a DST change does not
    // slide "Yesterday" an hour into the day before it
    new Date(y, m, now.getDate() - 1).getTime(),
    week.getTime(),
    new Date(week.getFullYear(), week.getMonth(), week.getDate() - 7).getTime(),
    dateAfter('thismonth', now),
    new Date(y, m - 1, 1).getTime(),
    dateAfter('thisyear', now),
  ];
  edgesAt = at;
  return edges;
};

/** A date in the future sits under "Today" — Explorer has no bucket ahead of it either. */
const dateBucket = (ms: number, now: Date): string => {
  const at = dateEdges(now);
  for (let i = 0; i < at.length; i++) if (ms >= at[i]) return DATE_BUCKETS[i];
  return DATE_BUCKETS[DATE_BUCKETS.length - 1];
};

/**
 * The first band that reaches the size. `sizePresets` overlaps at the edges — its `max` is
 * inclusive, so the search filter's `16 KB` matches both Tiny and Small — and a header has to
 * pick one: the smaller band, the one Explorer names first.
 */
const sizeBucket = (bytes: number): string =>
  sizePresets.find((b) => b.max === null || bytes <= b.max)!.label;

/**
 * Explorer groups names under single letters, not A-H ranges. Accents fold onto their base
 * letter (NFD splits "É" into "E" plus a mark), so Éclair files land under E rather than in a
 * header of their own; a script with no case of its own keeps its character.
 */
const nameBucket = (name: string): string => {
  const first = name.codePointAt(0);
  if (first === undefined) return 'Other';
  const c = String.fromCodePoint(first).normalize('NFD').charAt(0).toUpperCase();
  if (c >= '0' && c <= '9') return '0-9';
  return /\p{L}/u.test(c) ? c : 'Other';
};

/**
 * The header text `e` falls under when the list is grouped by `key`. `now` is an argument so a
 * test can pin the relative date buckets; the UI leaves it alone.
 */
export const groupLabelFor = (e: FileEntry, key: SortKey, now: Date = new Date()): string => {
  switch (key) {
    case 'name':
      return nameBucket(e.name);
    case 'ext':
      return shortKindOf(e);
    case 'size':
      // Explorer shows no size for a folder, so it has no size band either
      return e.isDir ? UNSPECIFIED : sizeBucket(e.size);
    case 'modifiedMs':
    case 'createdMs': {
      const ms = e[key];
      return ms === null ? UNSPECIFIED : dateBucket(ms, now);
    }
    case 'path':
    case 'dims':
      // neither is one of Explorer's "Group by" choices
      return '';
  }
};

const DATE_ORDER = [...DATE_BUCKETS, UNSPECIFIED];
const SIZE_ORDER = [...sizePresets.map((b) => b.label), UNSPECIFIED];

/**
 * The order the headers appear in, for the columns whose buckets do not order themselves:
 * "Yesterday" comes after "Today" and "Huge" after "Large" whichever way the column is sorted.
 * `null` where the labels are the sort itself — a letter, a type name.
 */
export const groupOrder = (key: SortKey): string[] | null => {
  if (key === 'modifiedMs' || key === 'createdMs') return DATE_ORDER;
  if (key === 'size') return SIZE_ORDER;
  return null;
};

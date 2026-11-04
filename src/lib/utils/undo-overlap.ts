// Out-of-order undo (plan 08 F): which paths an undo record touches, and whether a LATER entry
// touches any of the same ones. An older entry may be undone on its own only when nothing done
// after it touched its paths — undo a rename under a later move of that file and the move's
// record points at a name that no longer exists. Pure: `state/undo.svelte.ts` and the Edit ▸
// History panel (`state/undo-history.svelte.ts`) both read it.
import type { UndoRecord } from '$lib/types/undo';
import { folderKey, nameOf, pathSep } from '$lib/utils/path';
import type { TrovePlatform } from '$lib/utils/platform';

type Platform = TrovePlatform | undefined;

/**
 * Every path `record` touches: a rename's both names, a move's both ends, what a copy made (its
 * sources are only read), what went to the bin, the new item, a permanent delete's paths. `null`
 * for an `other` — Trove cannot say what it touched, so it blocks every older entry.
 */
export const recordPaths = (record: UndoRecord): string[] | null => {
  switch (record.kind) {
    case 'rename':
      return [record.from, record.to];
    case 'move':
      return record.pairs.flatMap((p) => [p.from, p.to]);
    case 'copy':
      return [...record.created];
    case 'trash':
    case 'deleteForever':
      return [...record.paths];
    case 'newFolder':
    case 'newFile':
      return [record.path];
    case 'other':
      return null;
  }
};

/**
 * Do two paths touch: the same path, or one inside the other (a folder renamed, a file in it
 * moved later). Compared by `folderKey`, so case and a trailing separator fold as the OS does.
 */
export const pathsTouch = (a: string, b: string, platform?: Platform): boolean => {
  const ka = folderKey(a, platform);
  const kb = folderKey(b, platform);
  if (ka === '' || kb === '') return false;
  if (ka === kb) return true;
  const sep = pathSep(platform);
  const under = (child: string, parent: string) =>
    child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  return under(ka, kb) || under(kb, ka);
};

/** The first path of `later` that touches one of `mine`, or null when none does. */
export const firstTouch = (mine: string[], later: string[], platform?: Platform): string | null => {
  for (const theirs of later) if (mine.some((m) => pathsTouch(m, theirs, platform))) return theirs;
  return null;
};

/** One entry as the overlap check sees it: its record, or null when it has none. */
export interface OverlapEntry {
  label: string;
  record: UndoRecord | null;
}

/** The newest later entry that touches the picked one, and how many others also do. */
export interface Blocker {
  /** its index in the stack (oldest first) */
  index: number;
  /** the path of the blocker that touches the picked entry's; null when its paths are unknown */
  path: string | null;
  /** further later entries that touch it too */
  more: number;
}

const pathsOf = (e: OverlapEntry) => (e.record ? recordPaths(e.record) : null);

/**
 * What stops `entries[index]` (oldest first) being undone on its own: the NEWEST later entry
 * that touches any of its paths — the one to undo first — or null when none does. An entry
 * whose own paths are unknown is blocked by any later entry; a later entry whose paths are
 * unknown blocks it too.
 */
export const blockerOf = (
  entries: OverlapEntry[],
  index: number,
  platform?: Platform,
): Blocker | null => {
  const target = entries[index];
  if (!target) return null;
  const mine = pathsOf(target);
  const hits: { index: number; path: string | null }[] = [];
  for (let i = entries.length - 1; i > index; i--) {
    const later = pathsOf(entries[i]);
    if (mine === null || later === null) {
      hits.push({ index: i, path: null });
      continue;
    }
    const path = firstTouch(mine, later, platform);
    if (path !== null) hits.push({ index: i, path });
  }
  const [newest] = hits;
  return newest ? { ...newest, more: hits.length - 1 } : null;
};

const count = (n: number, one: string) => (n === 1 ? `"${nameOf(one)}"` : `${n} items`);

/**
 * The row's title: the label with what it acted on — `Move 3 items`, `Rename "a.txt"`. An entry
 * with no record keeps its bare label.
 */
export const entryTitle = (label: string, record: UndoRecord | null): string => {
  if (!record) return label;
  switch (record.kind) {
    case 'rename':
      return `${label} "${nameOf(record.from)}"`;
    case 'move':
      return record.pairs.length > 0
        ? `${label} ${count(record.pairs.length, record.pairs[0].from)}`
        : label;
    case 'copy':
      return record.created.length > 0
        ? `${label} ${count(record.created.length, record.created[0])}`
        : label;
    case 'trash':
    case 'deleteForever':
      return record.paths.length > 0
        ? `${label} ${count(record.paths.length, record.paths[0])}`
        : label;
    case 'newFolder':
    case 'newFile':
      return `${label} "${nameOf(record.path)}"`;
    case 'other':
      return label;
  }
};

/** What the blocker did to the path: `it moved report.txt`. */
const didTo = (record: UndoRecord | null, path: string | null): string => {
  if (!record || path === null || record.kind === 'other')
    return "Trove can't tell which files it touched";
  const name = nameOf(path);
  switch (record.kind) {
    case 'rename':
      return `it renamed ${name}`;
    case 'move':
      return `it moved ${name}`;
    case 'copy':
      return `it made ${name}`;
    case 'trash':
      return `it deleted ${name}`;
    case 'deleteForever':
      return `it permanently deleted ${name}`;
    case 'newFolder':
    case 'newFile':
      return `it made ${name}`;
  }
};

/**
 * `Undo Move 3 items first — it moved report.txt` (bare, as `Can't undo Delete — …` is: the
 * title has quotes of its own), and how many more stand in the way. `mine`
 * is the picked entry's record: when it is the one whose files are unknown, the text says so.
 */
export const blockedText = (
  blocker: OverlapEntry,
  at: Blocker,
  mine: UndoRecord | null = null,
): string => {
  const more =
    at.more === 0 ? '' : ` (and ${at.more} more newer action${at.more === 1 ? '' : 's'})`;
  const unknownMine = at.path === null && (mine === null || mine.kind === 'other');
  const why = unknownMine
    ? "Trove can't tell which files this one touched"
    : didTo(blocker.record, at.path);
  return `Undo ${entryTitle(blocker.label, blocker.record)} first — ${why}${more}`;
};

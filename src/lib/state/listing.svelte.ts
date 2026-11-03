// What the file list shows right now: the active tab's folder, or the search results when a
// search is on. Everything that acts on "the rows" — the list, the keyboard, the actions, the
// menus, the status bar — reads this, so a hit in the results can be opened, renamed, cut or
// deleted like a row in a folder.
import { fileColumns, pathColumn, type FileColumn } from '$lib/data/file-columns';
import { search } from '$lib/state/search.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { FileEntry } from '$lib/types/fs';
import { entryComparator, groupLabelFor, groupOrder } from '$lib/utils/sort';

/** One of Explorer's group headings, standing in the list where its bucket begins. */
export interface GroupHeader {
  kind: 'header';
  /** the bucket text: "Today", "Large", "A" */
  label: string;
  /** rows beneath it, which the heading shows the way Explorer does — the bucket's full
   *  count, folded or not, so collapsing does not make the number lie */
  count: number;
  /** folded shut: the heading is rendered, its rows are not */
  collapsed: boolean;
}

/**
 * A position in the rendered list. Flat on purpose: `use-virtual-rows` measures one index per
 * rendered line, and a 100k-entry folder cannot afford a nested shape. A `FileEntry` has no
 * `kind`, which is what tells the two apart — and what lets the ungrouped list be the row
 * array itself rather than 100k wrappers around it.
 */
export type ListItem = GroupHeader | FileEntry;

export const isHeader = (item: ListItem): item is GroupHeader => 'kind' in item;

/** Two arrays already in `compare` order, as one; ties keep `a` first, as a stable sort would. */
export const mergeSorted = <T>(a: T[], b: T[], compare: (x: T, y: T) => number): T[] => {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const out: T[] = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = compare(b[j], a[i]) < 0 ? b[j++] : a[i++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
};

class ListingState {
  isSearch = $derived(search.active);

  /** The columns the person has on, in their order (`settings.columns`, G.59). */
  #shown = $derived(settings.columns.flatMap((k) => fileColumns.find((c) => c.key === k) ?? []));

  /**
   * What the last sort covered: which array, how many of its hits, under which ordering. A
   * search appends to one array for its whole life, so while the ordering is unchanged only the
   * hits that arrived since need sorting, and they are merged into the sorted prefix — a full
   * re-sort of 200k hits on every flush is what this replaces. Plain fields, not state: they
   * are read and written inside the derived below and must not make it depend on itself.
   */
  #sortCache: { source: FileEntry[]; count: number; order: string; sorted: FileEntry[] } | null =
    null;

  /** Results follow the tab's sort so a header click works on them too. */
  #sortedResults = $derived.by(() => {
    const source = search.results;
    const { sortKey, sortDir } = tabs.active;
    const foldersFirst = settings.foldersFirst;
    const order = `${sortKey}|${sortDir}|${foldersFirst}`;
    const compare = entryComparator(sortKey, sortDir, { foldersFirst });
    const cache = this.#sortCache;
    const sorted =
      cache && cache.source === source && cache.order === order && cache.count <= source.length
        ? mergeSorted(cache.sorted, source.slice(cache.count).sort(compare), compare)
        : [...source].sort(compare);
    this.#sortCache = { source, count: source.length, order, sorted };
    return sorted;
  });

  /** The sorted rows before grouping. */
  #sorted = $derived<FileEntry[]>(this.isSearch ? this.#sortedResults : tabs.active.visible);

  /**
   * Grouping is off in the sideways list alone. Details and the grid both group: a heading is
   * planned as a chunk of its own (`utils/virtual` → `planChunks`), so the grid's tiles start
   * a fresh row under each one. The list scrolls sideways, where a heading would be a column
   * of rotated text — Explorer does not group it either.
   */
  groupKey = $derived(tabs.active.view === 'list' ? null : tabs.active.groupKey);

  /**
   * The rows in bucket order, the ones a folded heading leaves on screen, and the same rows
   * with the headings threaded in. Built together because the three disagree only by the
   * headings and the folds, and walking 100k entries three times to find that out is two
   * walks too many.
   */
  #grouped = $derived.by((): { rows: FileEntry[]; shown: FileEntry[]; items: ListItem[] } => {
    const key = this.groupKey;
    const sorted = this.#sorted;
    if (key === null) return { rows: sorted, shown: sorted, items: sorted };
    // one `now` for the whole list: the relative date buckets must not move mid-walk
    const now = new Date();
    const buckets: { label: string; entries: FileEntry[] }[] = [];
    const at: Record<string, number | undefined> = Object.create(null);
    for (const e of sorted) {
      const label = groupLabelFor(e, key, now);
      const i = at[label];
      if (i === undefined) {
        at[label] = buckets.length;
        buckets.push({ label, entries: [e] });
      } else buckets[i].entries.push(e);
    }
    // The headings follow the group key's own order, never the order the walk met them in:
    // folders sort first, so their letters would be met first (S, Z, A, B…). `groupOrder` fixes
    // the ladder where the labels do not order themselves ("Yesterday" after "Today"); where it
    // is null the labels run A–Z. The sort direction flips either ladder while the list is
    // sorted by the group key; the trailing "Other"/unspecified bucket stays last. Rows inside
    // a bucket keep the list's own sort, folders first.
    const { sortKey, sortDir } = tabs.active;
    const flip = sortKey === key && sortDir === 'desc';
    const fixed = groupOrder(key);
    let ordered: typeof buckets;
    if (fixed) {
      const present = fixed
        .map((l) => at[l])
        .filter((i) => i !== undefined)
        .map((i) => buckets[i]);
      // dates run newest first in the ladder, sizes smallest first: the other direction flips it
      const reverse = key === 'size' ? flip : sortKey === key && !flip;
      const tail =
        present.length > 0 && present[present.length - 1].label === fixed[fixed.length - 1];
      const last = tail ? present.pop() : undefined;
      if (reverse) present.reverse();
      ordered = last ? [...present, last] : present;
    } else {
      const dir = flip ? -1 : 1;
      ordered = [...buckets].sort(
        (a, b) =>
          Number(a.label === 'Other') - Number(b.label === 'Other') ||
          dir * a.label.localeCompare(b.label, undefined, { numeric: true }),
      );
    }
    const shut = tabs.active.collapsedGroups;
    const rows: FileEntry[] = [];
    const items: ListItem[] = [];
    let folded = false;
    for (const bucket of ordered) {
      const collapsed = shut.has(bucket.label);
      items.push({
        kind: 'header',
        label: bucket.label,
        count: bucket.entries.length,
        collapsed,
      });
      folded ||= collapsed;
      for (const e of bucket.entries) {
        // A folded bucket's rows are still rows of the folder — the count, Ctrl+A, a delete of
        // something selected before the fold — they are only not on screen.
        rows.push(e);
        if (!collapsed) items.push(e);
      }
    }
    // Nothing folded: `shown` is `rows`, the same array, not a copy of 100k entries
    const shown = folded ? (items.filter((i) => !isHeader(i)) as FileEntry[]) : rows;
    return { rows, shown, items };
  });

  /**
   * Every row of the folder, in the order the buckets put them — a folded one included, so a
   * count, a Select all and a delete all mean what they meant before the fold. Grouping
   * reorders them, so the flat `FileEntry[]` every consumer expects still follows the eye.
   */
  rows = $derived<FileEntry[]>(this.#grouped.rows);

  /**
   * The rows actually on screen: `rows` without the folded buckets. What the keyboard walks
   * and what type-to-select matches, because Down must not land on a row you cannot see.
   */
  shown = $derived<FileEntry[]>(this.#grouped.shown);

  /** `rows` with the group headings in place: what the list renders and the virtualizer counts. */
  items = $derived<ListItem[]>(this.#grouped.items);

  /** Name, then Folder, then the rest — Explorer's order for results. */
  columns = $derived<FileColumn[]>(
    this.isSearch ? [this.#shown[0], pathColumn, ...this.#shown.slice(1)] : this.#shown,
  );
}

export const listing = new ListingState();

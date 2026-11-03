import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isHeader, listing, mergeSorted } from './listing.svelte';
import { settings } from './settings.svelte';
import { search } from './search.svelte';
import { tabs } from './tabs.svelte';
import type { FileEntry } from '$lib/types/fs';
import { pathLocation } from '$lib/utils/location';

vi.mock('$lib/api/search', () => ({
  startSearch: vi.fn(async () => 1),
  cancelSearch: vi.fn(async () => {}),
  onSearchResults: vi.fn(async () => () => {}),
}));
vi.mock('$lib/api/fs', () => ({ readDir: vi.fn(async (path: string) => ({ path, entries: [] })) }));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
}));
vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => null),
  writeSettings: vi.fn(async () => {}),
}));

const entry = (path: string): FileEntry => ({
  name: path.slice(path.lastIndexOf('\\') + 1),
  path,
  isDir: false,
  size: 1,
  modifiedMs: null,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: 'ext/',
  typeName: 'File',
});

describe('listing', () => {
  beforeEach(() => {
    search.clear();
    tabs.active.location = pathLocation('C:\\scratch');
    tabs.active.entries = [entry('C:\\scratch\\b.txt'), entry('C:\\scratch\\a.txt')];
    tabs.active.groupBy(null);
  });

  it('shows the folder, then the results while a search is on, then the folder again', async () => {
    expect(listing.isSearch).toBe(false);
    expect(listing.rows.map((e) => e.name)).toEqual(['a.txt', 'b.txt']);
    await search.start('txt');
    search.apply({
      searchId: 1,
      entries: [entry('C:\\scratch\\z\\hit.txt'), entry('C:\\scratch\\a\\hit.txt')],
      done: true,
      cancelled: false,
      error: null,
      scanned: 3,
    });
    expect(listing.isSearch).toBe(true);
    // the tab's sort applies to the results too: by name, then stable
    expect(listing.rows.map((e) => e.path)).toEqual([
      'C:\\scratch\\z\\hit.txt',
      'C:\\scratch\\a\\hit.txt',
    ]);
    tabs.active.sortBy('path');
    expect(listing.rows.map((e) => e.path)).toEqual([
      'C:\\scratch\\a\\hit.txt',
      'C:\\scratch\\z\\hit.txt',
    ]);
    search.clear();
    tabs.active.sortBy('name');
    expect(listing.rows.map((e) => e.name)).toEqual(['a.txt', 'b.txt']);
  });

  it('keeps results sorted as later batches arrive, and re-sorts when the order changes', async () => {
    await search.start('txt');
    const batchOf = (names: string[]) => ({
      searchId: 1,
      entries: names.map((n) => entry(['C:', 'scratch', n].join(String.fromCharCode(92)))),
      done: true,
      cancelled: false,
      error: null,
      scanned: 1,
    });
    search.apply(batchOf(['m.txt', 'c.txt']));
    expect(listing.rows.map((e) => e.name)).toEqual(['c.txt', 'm.txt']);
    search.apply(batchOf(['a.txt', 'z.txt', 'd.txt']));
    expect(listing.rows.map((e) => e.name)).toEqual(['a.txt', 'c.txt', 'd.txt', 'm.txt', 'z.txt']);
    tabs.active.sortBy('name');
    expect(listing.rows.map((e) => e.name)).toEqual(['z.txt', 'm.txt', 'd.txt', 'c.txt', 'a.txt']);
  });

  it('gains the Folder column after Name while searching', async () => {
    expect(listing.columns.map((c) => c.key)).toEqual(['name', 'modifiedMs', 'ext', 'size']);
    await search.start('x');
    expect(listing.columns.map((c) => c.key)).toEqual([
      'name',
      'path',
      'modifiedMs',
      'ext',
      'size',
    ]);
    expect(listing.columns[1].cell(entry('C:\\scratch\\sub\\x.txt'))).toBe('C:\\scratch\\sub');
  });

  it('threads the group headings in, in Explorer’s bucket order', () => {
    tabs.active.entries = [
      { ...entry('C:\\scratch\\big.bin'), size: 200 * 1024 * 1024 },
      entry('C:\\scratch\\a.txt'),
      { ...entry('C:\\scratch\\empty.txt'), size: 0 },
    ];
    tabs.active.sortBy('name');
    tabs.active.setSortDir('asc');
    tabs.active.groupBy('size');
    // the rows come back in bucket order, not name order, so the keyboard follows the eye
    expect(listing.rows.map((e) => e.name)).toEqual(['empty.txt', 'a.txt', 'big.bin']);
    expect(listing.items.map((i) => (isHeader(i) ? `${i.label} (${i.count})` : i.name))).toEqual([
      'Empty (0 KB) (1)',
      'empty.txt',
      'Tiny (0 – 16 KB) (1)',
      'a.txt',
      'Large (128 MB – 1 GB) (1)',
      'big.bin',
    ]);
  });

  it('headings run A–Z when the list is sorted by another column', () => {
    tabs.active.entries = [
      { ...entry('C:\\scratch\\q.txt'), size: 1 },
      { ...entry('C:\\scratch\\a.txt'), size: 2 },
      { ...entry('C:\\scratch\\m.txt'), size: 3 },
    ];
    tabs.active.sortBy('size');
    tabs.active.setSortDir('asc');
    tabs.active.groupBy('name');
    const labels = listing.items.filter(isHeader).map((h) => h.label);
    expect(labels).toEqual(['A', 'M', 'Q']);
    tabs.active.groupBy(null);
  });

  it('orders the headings by the group key when sorted by it, folders first inside a group', () => {
    const dir = (n: string): FileEntry => ({ ...entry(`C:\\scratch\\${n}`), isDir: true });
    tabs.active.entries = [
      entry('C:\\scratch\\m.txt'),
      dir('Z'),
      entry('C:\\scratch\\a.txt'),
      dir('S'),
      entry('C:\\scratch\\c.txt'),
      entry('C:\\scratch\\b.txt'),
      entry('C:\\scratch\\sample.txt'),
    ];
    settings.foldersFirst = true;
    tabs.active.sortBy('name');
    tabs.active.setSortDir('asc');
    tabs.active.groupBy('name');
    const labels = () => listing.items.filter(isHeader).map((h) => h.label);
    expect(labels()).toEqual(['A', 'B', 'C', 'M', 'S', 'Z']);
    const inS = listing.items.map((i) => (isHeader(i) ? `#${i.label}` : i.name));
    expect(inS.slice(inS.indexOf('#S'), inS.indexOf('#Z'))).toEqual(['#S', 'S', 'sample.txt']);
    tabs.active.setSortDir('desc');
    expect(labels()).toEqual(['Z', 'S', 'M', 'C', 'B', 'A']);
    tabs.active.groupBy(null);
    settings.foldersFirst = false;
  });

  it('inside a name group sorted by date, folders come first only with the setting on', () => {
    const dir = { ...entry('C:\\scratch\\alpha'), isDir: true, modifiedMs: 1 };
    tabs.active.entries = [{ ...entry('C:\\scratch\\apple.txt'), modifiedMs: 9 }, dir];
    tabs.active.groupBy('name');
    tabs.active.sortBy('modifiedMs');
    tabs.active.setSortDir('desc');
    const names = () => listing.items.map((i) => (isHeader(i) ? `#${i.label}` : i.name));
    settings.foldersFirst = true;
    expect(names()).toEqual(['#A', 'alpha', 'apple.txt']);
    settings.foldersFirst = false;
    expect(names()).toEqual(['#A', 'apple.txt', 'alpha']);
    tabs.active.groupBy(null);
    tabs.active.sortBy('name');
  });

  it('groups by type in alphabetical type order when sorted by name', () => {
    tabs.active.entries = [
      { ...entry('C:\\scratch\\a.zip'), typeName: 'ZIP File', ext: 'zip' },
      { ...entry('C:\\scratch\\b.txt'), typeName: 'Text Document', ext: 'txt' },
      { ...entry('C:\\scratch\\c.png'), typeName: 'PNG File', ext: 'png' },
    ];
    tabs.active.sortBy('name');
    tabs.active.setSortDir('asc');
    tabs.active.groupBy('ext');
    const labels = listing.items.filter(isHeader).map((h) => h.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(labels).toHaveLength(3);
    tabs.active.groupBy(null);
  });

  it('groups the results of a search as well as a folder', async () => {
    await search.start('txt');
    search.apply({
      searchId: 1,
      entries: [entry('C:\\scratch\\z\\beta.txt'), entry('C:\\scratch\\a\\alpha.txt')],
      done: true,
      cancelled: false,
      error: null,
      scanned: 2,
    });
    tabs.active.groupBy('name');
    expect(listing.items.map((i) => (isHeader(i) ? i.label : i.name))).toEqual([
      'A',
      'alpha.txt',
      'B',
      'beta.txt',
    ]);
  });

  it('without a grouping the rendered list is the rows, headingless', () => {
    expect(listing.items.some(isHeader)).toBe(false);
    expect(listing.items).toEqual(listing.rows);
  });

  it('groups the grid too, and only the sideways list goes flat', () => {
    tabs.active.groupBy('name');
    expect(listing.groupKey).toBe('name');
    settings.view = 'grid';
    expect(listing.groupKey).toBe('name');
    expect(listing.items.some(isHeader)).toBe(true);
    // the list scrolls sideways: a heading there would be a column of rotated text
    settings.view = 'list';
    expect(listing.groupKey).toBeNull();
    expect(listing.items.some(isHeader)).toBe(false);
  });
});

describe('listing group folds', () => {
  beforeEach(() => {
    search.clear();
    settings.view = 'details';
    tabs.active.location = pathLocation('C:\\scratch');
    tabs.active.entries = [
      entry('C:\\scratch\\apple.txt'),
      entry('C:\\scratch\\avocado.txt'),
      entry('C:\\scratch\\banana.txt'),
    ];
    tabs.active.groupBy('name');
  });

  afterEach(() => {
    tabs.active.groupBy(null);
    settings.view = 'details';
  });

  it('keeps the heading and its full count when a bucket is folded, and drops its rows', () => {
    tabs.active.toggleGroup('A');
    expect(listing.items.map((i) => (isHeader(i) ? `${i.label} (${i.count})` : i.name))).toEqual([
      'A (2)',
      'B (1)',
      'banana.txt',
    ]);
    // a folded row is not one the keyboard should land on
    expect(listing.shown.map((e) => e.name)).toEqual(['banana.txt']);
    // …but it is still a row of the folder: the count, Ctrl+A and a delete still see it
    expect(listing.rows.map((e) => e.name)).toEqual(['apple.txt', 'avocado.txt', 'banana.txt']);
  });

  it('marks the folded heading and leaves the others open', () => {
    tabs.active.toggleGroup('A');
    const headers = listing.items.filter(isHeader);
    expect(headers.map((h) => [h.label, h.collapsed])).toEqual([
      ['A', true],
      ['B', false],
    ]);
  });

  it('opens a folded bucket again on a second toggle', () => {
    tabs.active.toggleGroup('A');
    tabs.active.toggleGroup('A');
    expect(listing.shown).toHaveLength(3);
    expect(listing.shown).toEqual(listing.rows); // nothing folded: every row is on screen
    expect(listing.items.filter(isHeader).every((h) => !h.collapsed)).toBe(true);
  });

  it('throws the folds away when the group column changes — the labels are a new ladder', () => {
    tabs.active.toggleGroup('A');
    expect(listing.shown).toHaveLength(1);
    tabs.active.groupBy('ext');
    expect(tabs.active.collapsedGroups.size).toBe(0);
    expect(listing.shown).toHaveLength(3);
  });

  it('folds the same bucket in the grid, where the heading is its own chunk', () => {
    settings.view = 'grid';
    tabs.active.toggleGroup('A');
    expect(listing.items.map((i) => (isHeader(i) ? i.label : i.name))).toEqual([
      'A',
      'B',
      'banana.txt',
    ]);
  });
});

describe('mergeSorted', () => {
  it('equals sorting the concatenation, ties keeping the earlier array first', () => {
    const cmp = (x: { k: number }, y: { k: number }) => x.k - y.k;
    const a = [1, 3, 3, 9].map((k, i) => ({ k, from: `a${i}` }));
    const b = [0, 3, 4, 9, 10].map((k, i) => ({ k, from: `b${i}` }));
    expect(mergeSorted(a, b, cmp)).toEqual([...a, ...b].sort(cmp));
    expect(mergeSorted(a, [], cmp)).toBe(a);
    expect(mergeSorted([], b, cmp)).toBe(b);
  });
});

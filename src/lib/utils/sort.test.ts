import { describe, expect, it } from 'vitest';
import type { FileEntry } from '$lib/types/fs';
import { entryComparator, firstDirectionFor, groupLabelFor, groupOrder } from './sort';

const file = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `C:\\x\\${name}`,
  isDir: false,
  size: 0,
  modifiedMs: null,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: 'ext/',
  typeName: 'File',
  ...extra,
});

describe('entryComparator', () => {
  it('keeps folders first on Name, in both directions', () => {
    const list = [file('a.txt'), file('Z', { isDir: true }), file('b.txt')];
    expect(list.sort(entryComparator('name', 'asc')).map((e) => e.name)).toEqual([
      'Z',
      'a.txt',
      'b.txt',
    ]);
    expect(list.sort(entryComparator('name', 'desc')).map((e) => e.name)).toEqual([
      'Z',
      'b.txt',
      'a.txt',
    ]);
  });

  it('sorts names case-insensitively and numerically, like Explorer', () => {
    const list = [file('file10'), file('File2'), file('file1')];
    expect(list.sort(entryComparator('name', 'asc')).map((e) => e.name)).toEqual([
      'file1',
      'File2',
      'file10',
    ]);
  });

  it('sorts numbers by value, nulls as zero', () => {
    const list = [file('c', { size: 300 }), file('a', { size: 5 }), file('b', { size: 20 })];
    expect(list.sort(entryComparator('size', 'asc')).map((e) => e.name)).toEqual(['a', 'b', 'c']);
    const dates = [file('x', { modifiedMs: 10 }), file('y', { modifiedMs: null })];
    expect(dates.sort(entryComparator('modifiedMs', 'asc')).map((e) => e.name)).toEqual(['y', 'x']);
  });

  it('interleaves folders with files on the date columns, as Explorer does', () => {
    // the bug testers hit: a Downloads folder sorted newest-first showed every folder above
    // the file that had just landed
    const list = [
      file('old-folder', { isDir: true, modifiedMs: 10 }),
      file('installer.exe', { modifiedMs: 900 }),
      file('new-folder', { isDir: true, modifiedMs: 500 }),
    ];
    expect(list.sort(entryComparator('modifiedMs', 'desc')).map((e) => e.name)).toEqual([
      'installer.exe',
      'new-folder',
      'old-folder',
    ]);
  });

  it('pins folders on every column when the setting asks for it', () => {
    const list = [
      file('old-folder', { isDir: true, modifiedMs: 10 }),
      file('installer.exe', { modifiedMs: 900 }),
    ];
    const sorted = list.sort(entryComparator('modifiedMs', 'desc', { foldersFirst: true }));
    expect(sorted.map((e) => e.name)).toEqual(['old-folder', 'installer.exe']);
  });

  it('sorts Date created like Date modified', () => {
    const list = [file('a', { createdMs: 1 }), file('b', { createdMs: 9 })];
    expect(list.sort(entryComparator('createdMs', 'desc')).map((e) => e.name)).toEqual(['b', 'a']);
  });

  it('sorts the Type column by the short kind it shows, not by the extension', () => {
    // `xlsx` < `zip` < `docx` is not the order; "Archive" < "Document" < "Spreadsheet" is
    const list = [
      file('b.xlsx', { ext: 'xlsx', typeName: 'Microsoft Excel Worksheet' }),
      file('a.docx', { ext: 'docx', typeName: 'Microsoft Word Document' }),
      file('c.zip', { ext: 'zip', typeName: 'Compressed (zipped) Folder' }),
    ];
    expect(list.sort(entryComparator('ext', 'asc')).map((e) => e.name)).toEqual([
      'c.zip',
      'a.docx',
      'b.xlsx',
    ]);
  });

  it('breaks ties on the name so equal rows never shuffle', () => {
    const list = [file('b.txt', { size: 5 }), file('a.txt', { size: 5 })];
    expect(list.sort(entryComparator('size', 'desc')).map((e) => e.name)).toEqual([
      'a.txt',
      'b.txt',
    ]);
  });
});

describe('firstDirectionFor', () => {
  it('opens the dates and the size newest / largest first, the text columns A to Z', () => {
    expect(firstDirectionFor('modifiedMs')).toBe('desc');
    expect(firstDirectionFor('createdMs')).toBe('desc');
    expect(firstDirectionFor('size')).toBe('desc');
    expect(firstDirectionFor('name')).toBe('asc');
    expect(firstDirectionFor('ext')).toBe('asc');
  });
});

// Thursday 17 September 2026, 15:30 — mid-week and mid-month, so every relative bucket has
// room: this week starts Monday the 14th, last week Monday the 7th.
const NOW = new Date(2026, 8, 17, 15, 30);
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();
const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

describe('groupLabelFor dates', () => {
  it('puts a date in Explorer’s relative bucket', () => {
    const cases: [number, string][] = [
      [at(2026, 8, 17, 0), 'Today'],
      [at(2026, 8, 16), 'Yesterday'],
      [at(2026, 8, 15), 'Earlier this week'],
      [at(2026, 8, 14, 0), 'Earlier this week'],
      [at(2026, 8, 13), 'Last week'],
      [at(2026, 8, 7, 0), 'Last week'],
      [at(2026, 8, 6), 'Earlier this month'],
      [at(2026, 8, 1, 0), 'Earlier this month'],
      [at(2026, 7, 31), 'Last month'],
      [at(2026, 7, 1, 0), 'Last month'],
      [at(2026, 6, 31), 'Earlier this year'],
      [at(2026, 0, 1, 0), 'Earlier this year'],
      [at(2025, 11, 31), 'A long time ago'],
      [at(1999, 0, 1), 'A long time ago'],
    ];
    for (const [ms, label] of cases) {
      expect(groupLabelFor(file('x', { modifiedMs: ms }), 'modifiedMs', NOW)).toBe(label);
    }
  });

  it('splits Today from Yesterday at midnight, not at the hour of the call', () => {
    const midnight = at(2026, 8, 17, 0);
    expect(groupLabelFor(file('x', { modifiedMs: midnight }), 'modifiedMs', NOW)).toBe('Today');
    expect(groupLabelFor(file('x', { modifiedMs: midnight - 1 }), 'modifiedMs', NOW)).toBe(
      'Yesterday',
    );
  });

  it('keeps a clock-skewed future date under Today, the newest bucket there is', () => {
    expect(groupLabelFor(file('x', { modifiedMs: at(2027, 0, 1) }), 'modifiedMs', NOW)).toBe(
      'Today',
    );
  });

  it('groups Date created by the created time, not the modified one', () => {
    const e = file('x', { modifiedMs: at(2026, 8, 17), createdMs: at(2020, 3, 2) });
    expect(groupLabelFor(e, 'createdMs', NOW)).toBe('A long time ago');
    expect(groupLabelFor(e, 'modifiedMs', NOW)).toBe('Today');
  });

  it('calls a date the filesystem never recorded Unspecified', () => {
    expect(groupLabelFor(file('x'), 'modifiedMs', NOW)).toBe('Unspecified');
    expect(groupLabelFor(file('x'), 'createdMs', NOW)).toBe('Unspecified');
  });
});

// The boundaries, each against a `now` chosen to put one of them under strain. Never the real
// clock: a test that passes only in the middle of a month is not a test.
describe('groupLabelFor date boundaries', () => {
  const bucket = (ms: number, now: Date) =>
    groupLabelFor(file('x', { modifiedMs: ms }), 'modifiedMs', now);

  it('keeps a file from earlier today under Today, minutes old or hours', () => {
    const now = new Date(2026, 8, 17, 15, 30);
    expect(bucket(new Date(2026, 8, 17, 15, 29, 59).getTime(), now)).toBe('Today');
    expect(bucket(new Date(2026, 8, 17, 0, 0, 0).getTime(), now)).toBe('Today');
  });

  it('splits the day at midnight to the millisecond', () => {
    const now = new Date(2026, 8, 17, 0, 0, 1);
    const midnight = new Date(2026, 8, 17).getTime();
    expect(bucket(midnight, now)).toBe('Today');
    expect(bucket(midnight - 1, now)).toBe('Yesterday'); // 23:59:59.999 the day before
    expect(bucket(new Date(2026, 8, 16, 23, 59).getTime(), now)).toBe('Yesterday');
    expect(bucket(new Date(2026, 8, 16, 0, 0).getTime(), now)).toBe('Yesterday');
    expect(bucket(new Date(2026, 8, 15, 23, 59).getTime(), now)).toBe('Earlier this week');
  });

  it('on a Monday has no Earlier this week to fall into', () => {
    // Monday 14 September 2026: this week began this morning, so yesterday is already Last week
    const monday = new Date(2026, 8, 14, 9, 0);
    expect(monday.getDay()).toBe(1);
    expect(bucket(new Date(2026, 8, 14, 8).getTime(), monday)).toBe('Today');
    expect(bucket(new Date(2026, 8, 13, 23).getTime(), monday)).toBe('Yesterday');
    expect(bucket(new Date(2026, 8, 12).getTime(), monday)).toBe('Last week');
  });

  it('on the first of a month puts last night in Yesterday, not in Last month', () => {
    // Tuesday 1 September 2026: yesterday and this week both reach back into August
    const first = new Date(2026, 8, 1, 10, 0);
    expect(bucket(new Date(2026, 8, 1, 0).getTime(), first)).toBe('Today');
    expect(bucket(new Date(2026, 7, 31, 23, 59).getTime(), first)).toBe('Yesterday');
    // Monday 31 August is this week's start, so Sunday the 30th is Last week — checked before
    // any month bucket, exactly as Explorer checks it
    expect(bucket(new Date(2026, 7, 30).getTime(), first)).toBe('Last week');
    expect(bucket(new Date(2026, 7, 20).getTime(), first)).toBe('Last month');
    expect(bucket(new Date(2026, 6, 20).getTime(), first)).toBe('Earlier this year');
  });

  it('in January calls December last month, and has no Earlier this year left', () => {
    // Friday 15 January 2027. "This year" starts on the 1st, which the month buckets already
    // cover, so nothing can land in Earlier this year — and December is the year before.
    const jan = new Date(2027, 0, 15, 12, 0);
    expect(bucket(new Date(2027, 0, 2).getTime(), jan)).toBe('Earlier this month');
    expect(bucket(new Date(2027, 0, 1, 0).getTime(), jan)).toBe('Earlier this month');
    expect(bucket(new Date(2026, 11, 31, 23, 59).getTime(), jan)).toBe('Last month');
    expect(bucket(new Date(2026, 11, 1, 0).getTime(), jan)).toBe('Last month');
    expect(bucket(new Date(2026, 10, 30, 23, 59).getTime(), jan)).toBe('A long time ago');
    const labels = [
      new Date(2027, 0, 15, 11).getTime(),
      new Date(2027, 0, 14).getTime(),
      new Date(2027, 0, 13).getTime(),
      new Date(2027, 0, 5).getTime(),
      new Date(2027, 0, 2).getTime(),
      new Date(2026, 11, 10).getTime(),
      new Date(2026, 5, 10).getTime(),
    ].map((ms) => bucket(ms, jan));
    expect(labels).not.toContain('Earlier this year');
  });

  it('crosses a year on the 1st of January without losing yesterday', () => {
    const newYear = new Date(2027, 0, 1, 9, 0);
    expect(bucket(new Date(2027, 0, 1, 0).getTime(), newYear)).toBe('Today');
    expect(bucket(new Date(2026, 11, 31, 23, 59, 59, 999).getTime(), newYear)).toBe('Yesterday');
    expect(bucket(new Date(2026, 11, 1).getTime(), newYear)).toBe('Last month');
    expect(bucket(new Date(2026, 9, 1).getTime(), newYear)).toBe('A long time ago');
  });

  it('is decided by the calendar, not by 86 400 000 ms — a DST day is still one day', () => {
    // 2 November 2026, the Monday after the US clocks went back: the 25-hour Sunday must not
    // slide "Yesterday" into the day before it.
    const after = new Date(2026, 10, 2, 9, 0);
    expect(bucket(new Date(2026, 10, 1, 12).getTime(), after)).toBe('Yesterday');
    expect(bucket(new Date(2026, 10, 1, 0, 30).getTime(), after)).toBe('Yesterday');
    expect(bucket(new Date(2026, 9, 31, 23, 30).getTime(), after)).toBe('Last week');
  });

  it('recomputes the edges when `now` moves, rather than serving the cached ones', () => {
    const ms = new Date(2026, 8, 16, 12).getTime();
    expect(bucket(ms, new Date(2026, 8, 17, 15, 30))).toBe('Yesterday');
    expect(bucket(ms, new Date(2026, 8, 16, 15, 30))).toBe('Today');
    expect(bucket(ms, new Date(2026, 8, 18, 15, 30))).toBe('Earlier this week');
  });
});

describe('groupLabelFor size', () => {
  it('puts a file in Explorer’s size band', () => {
    const cases: [number, string][] = [
      [0, 'Empty (0 KB)'],
      [1, 'Tiny (0 – 16 KB)'],
      [40 * KB, 'Small (16 KB – 1 MB)'],
      [9 * MB, 'Medium (1 – 128 MB)'],
      [500 * MB, 'Large (128 MB – 1 GB)'],
      [2 * GB, 'Huge (1 – 4 GB)'],
      [9 * GB, 'Gigantic (> 4 GB)'],
    ];
    for (const [size, label] of cases) {
      expect(groupLabelFor(file('x', { size }), 'size', NOW)).toBe(label);
    }
  });

  it('lands a size sitting on a band edge in the smaller band', () => {
    expect(groupLabelFor(file('x', { size: 16 * KB }), 'size', NOW)).toBe('Tiny (0 – 16 KB)');
    expect(groupLabelFor(file('x', { size: MB }), 'size', NOW)).toBe('Small (16 KB – 1 MB)');
    expect(groupLabelFor(file('x', { size: 4 * GB }), 'size', NOW)).toBe('Huge (1 – 4 GB)');
  });

  it('gives a folder no band — Explorer shows it no size either', () => {
    expect(groupLabelFor(file('Docs', { isDir: true, size: 0 }), 'size', NOW)).toBe('Unspecified');
  });
});

describe('groupLabelFor name and type', () => {
  it('groups a name under its own letter, upper-cased', () => {
    expect(groupLabelFor(file('report.docx'), 'name', NOW)).toBe('R');
    expect(groupLabelFor(file('Report.docx'), 'name', NOW)).toBe('R');
  });

  it('folds an accent onto its base letter instead of opening a header for it', () => {
    expect(groupLabelFor(file('Éclair.jpg'), 'name', NOW)).toBe('E');
  });

  it('collects digits under 0-9 and everything else under Other', () => {
    expect(groupLabelFor(file('2026 taxes.pdf'), 'name', NOW)).toBe('0-9');
    expect(groupLabelFor(file('_notes.txt'), 'name', NOW)).toBe('Other');
    expect(groupLabelFor(file('.gitignore'), 'name', NOW)).toBe('Other');
    expect(groupLabelFor(file('🎁 gift.png'), 'name', NOW)).toBe('Other');
  });

  it('groups Type by the short kind the column shows', () => {
    expect(groupLabelFor(file('a.md', { typeName: 'Markdown Source File' }), 'ext', NOW)).toBe(
      'Text',
    );
    expect(groupLabelFor(file('x.bin', { ext: 'bin' }), 'ext', NOW)).toBe('BIN file');
    expect(groupLabelFor(file('src', { isDir: true }), 'ext', NOW)).toBe('Folder');
  });

  it('has no bucket for the Folder column — Explorer does not offer it', () => {
    expect(groupLabelFor(file('a.txt'), 'path', NOW)).toBe('');
  });
});

describe('groupOrder', () => {
  it('holds the date buckets in Explorer’s order, newest first, Unspecified last', () => {
    expect(groupOrder('modifiedMs')).toEqual([
      'Today',
      'Yesterday',
      'Earlier this week',
      'Last week',
      'Earlier this month',
      'Last month',
      'Earlier this year',
      'A long time ago',
      'Unspecified',
    ]);
    expect(groupOrder('createdMs')).toEqual(groupOrder('modifiedMs'));
  });

  it('holds the size bands smallest first', () => {
    expect(groupOrder('size')).toEqual([
      'Empty (0 KB)',
      'Tiny (0 – 16 KB)',
      'Small (16 KB – 1 MB)',
      'Medium (1 – 128 MB)',
      'Large (128 MB – 1 GB)',
      'Huge (1 – 4 GB)',
      'Gigantic (> 4 GB)',
      'Unspecified',
    ]);
  });

  it('leaves the columns whose labels sort themselves without an order', () => {
    expect(groupOrder('name')).toBeNull();
    expect(groupOrder('ext')).toBeNull();
    expect(groupOrder('path')).toBeNull();
  });

  it('names every bucket the labeller can produce, so no row falls off the end', () => {
    const labels = [
      groupLabelFor(file('x', { modifiedMs: at(2026, 8, 17) }), 'modifiedMs', NOW),
      groupLabelFor(file('x', { modifiedMs: at(1999, 0, 1) }), 'modifiedMs', NOW),
      groupLabelFor(file('x'), 'modifiedMs', NOW),
    ];
    for (const label of labels) expect(groupOrder('modifiedMs')).toContain(label);
    for (const size of [0, 1, 9 * GB]) {
      expect(groupOrder('size')).toContain(groupLabelFor(file('x', { size }), 'size', NOW));
    }
    expect(groupOrder('size')).toContain(groupLabelFor(file('d', { isDir: true }), 'size', NOW));
  });
});

import { describe, expect, it } from 'vitest';
import type { RecycleItem } from '$lib/types/recycle';
import {
  canRestore,
  columnFlex,
  kindText,
  originText,
  recycleLayout,
  sizeText,
  visibleColumns,
  withoutRestore,
} from './recycle-columns';

const bin = (name: string): RecycleItem => ({
  id: `id-${name}`,
  name,
  originalParent: 'D:\\scratch',
  deletedMs: 1,
  isDir: false,
  size: null,
});

const trash = (name: string, over: Partial<RecycleItem> = {}): RecycleItem => ({
  id: `/Users/me/.Trash/${name}`,
  name,
  originalParent: null,
  deletedMs: 1,
  isDir: false,
  size: 2048,
  ...over,
});

const menu = [
  { kind: 'item', key: 'restore' },
  { kind: 'item', key: 'open-location' },
  { kind: 'divider', key: 'd1' },
  { kind: 'item', key: 'purge' },
];

describe('recycle bin columns per OS', () => {
  it('keeps the Windows / Linux bin as it was: original location and restore', () => {
    expect(recycleLayout(false)).toBe('bin');
    expect(canRestore(false, [bin('a.txt'), bin('b.txt')])).toBe(true);
    expect(withoutRestore(menu, true).map((m) => m.key)).toEqual([
      'restore',
      'open-location',
      'd1',
      'purge',
    ]);
    expect(originText(bin('a.txt'))).toBe('D:\\scratch');
  });

  it('turns restore off on macOS and drops the entries, leaving no stray divider', () => {
    expect(recycleLayout(true)).toBe('trash');
    expect(canRestore(true, [trash('a.txt')])).toBe(false);
    expect(withoutRestore(menu, false).map((m) => m.key)).toEqual(['purge']);
    expect(
      withoutRestore([{ key: 'empty' }, { key: 'restore-all' }], false).map((m) => m.key),
    ).toEqual(['empty']);
  });

  it('offers no restore for an item whose original folder is unknown, on any OS', () => {
    expect(canRestore(false, [bin('a.txt'), trash('b.txt')])).toBe(false);
    expect(originText(trash('b.txt'))).toBe('—');
  });

  it('says kind and size for the macOS Trash, a dash for an unknown size', () => {
    expect(kindText(trash('report.pdf'))).toBe('PDF file');
    expect(kindText(trash('Old Photos', { isDir: true, size: null }))).toBe('Folder');
    expect(kindText(trash('README'))).toBe('File');
    expect(sizeText(trash('report.pdf'))).toBe('2 KB');
    expect(sizeText(trash('Old Photos', { isDir: true, size: null }))).toBe('—');
  });
});

describe('visibleColumns', () => {
  const keys = (layout: 'bin' | 'trash', w: number) => visibleColumns(layout, w).map((c) => c.key);

  it('shows every column before the list is measured', () => {
    expect(keys('bin', 0)).toEqual(['name', 'origin', 'date']);
    expect(keys('trash', 0)).toEqual(['name', 'kind', 'size', 'date']);
  });

  it('shows every bin column when they all fit at their minimum', () => {
    expect(keys('bin', 460)).toEqual(['name', 'origin', 'date']);
    expect(keys('bin', 1300)).toEqual(['name', 'origin', 'date']);
  });

  // A.5.10: at 800 px with the details pane open the list is ~330 px wide.
  it('hides Date deleted before squashing Name in the 800 px + pane list', () => {
    expect(keys('bin', 459)).toEqual(['name', 'origin']);
    expect(keys('bin', 330)).toEqual(['name', 'origin']);
  });

  it('keeps Name alone when even the original location does not fit', () => {
    expect(keys('bin', 299)).toEqual(['name']);
    expect(keys('bin', 100)).toEqual(['name']);
  });

  it('drops the Trash columns kind, then date, then size', () => {
    expect(keys('trash', 506)).toEqual(['name', 'kind', 'size', 'date']);
    expect(keys('trash', 505)).toEqual(['name', 'size', 'date']);
    expect(keys('trash', 415)).toEqual(['name', 'size']);
    expect(keys('trash', 255)).toEqual(['name']);
  });

  it('never gives Name less than 160 px while another column is shown', () => {
    for (const layout of ['bin', 'trash'] as const) {
      for (let w = 1; w <= 1400; w++) {
        const cols = visibleColumns(layout, w);
        const sum = cols.reduce((s, c) => s + c.min, 0);
        expect(cols[0].key).toBe('name');
        if (cols.length > 1) expect(sum).toBeLessThanOrEqual(w);
      }
    }
  });
});

describe('columnFlex', () => {
  it('starts at the minimum and grows by its share', () => {
    expect(columnFlex({ key: 'name', label: 'Name', min: 160, grow: 3 })).toBe('3 1 160px');
    expect(columnFlex({ key: 'date', label: 'Date deleted', min: 160, grow: 0 })).toBe('0 1 160px');
  });
});

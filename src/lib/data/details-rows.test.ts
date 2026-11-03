import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attributesHeading,
  attributeToggles,
  detailsRows,
  folderSize,
  notCountedRow,
  recycleItemRows,
  recycleSelectedItem,
  recycleSummary,
} from './details-rows';
import { fmtDate, fmtSize } from '$lib/utils/format';
import type { RecycleItem } from '$lib/types/recycle';

const on = (os: string) =>
  vi.stubGlobal('window', { __TROVE_PLATFORM__: { os, thisPcLabel: 'This PC' } });

describe('attribute wording per platform', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Windows keeps Attributes with Read-only and Hidden', () => {
    on('windows');
    expect(attributesHeading()).toBe('Attributes');
    expect(attributeToggles().map((t) => t.label)).toEqual(['Read-only', 'Hidden']);
  });

  it.each(['macos', 'linux'])('%s says Permissions and has no Hidden box', (os) => {
    on(os);
    expect(attributesHeading()).toBe('Permissions');
    expect(attributeToggles().map((t) => t.key)).toEqual(['readOnly']);
    // not "Locked": that is Finder's uchg flag, and it read as a statement beside an empty box
    expect(attributeToggles().map((t) => t.label)).toEqual(['Read-only']);
  });
});

describe('folderSize', () => {
  const t = { files: 2, folders: 5, bytes: 9, sizeOnDisk: 9, notCounted: 0, done: true };

  it('shows the walked bytes when nothing was skipped', () => {
    expect(folderSize(t)).toBe(`${fmtSize(9)} (9 bytes)`);
  });

  it('keeps the not-counted note out of the Size value and in its own row', () => {
    expect(folderSize({ ...t, notCounted: 2 })).toBe(`${fmtSize(9)} (9 bytes)`);
    expect(notCountedRow({ ...t, notCounted: 2 })).toBe('2 folders');
    expect(notCountedRow({ ...t, notCounted: 1 })).toBe('1 folder');
    expect(notCountedRow(t)).toBeNull();
  });

  it('hides Size on disk and Contains when nothing was counted', () => {
    const p = { isDir: true, path: '/Users/x/Library', typeName: 'Folder' } as never;
    const empty = { ...t, files: 0, folders: 0, bytes: 0, notCounted: 1 };
    const val = (key: string, totals: typeof t) =>
      detailsRows.find((r) => r.key === key)!.value(p, totals);
    expect(val('sizeOnDisk', empty)).toBeNull();
    expect(val('contains', empty)).toBeNull();
    expect(val('notCounted', empty)).toBeNull();
    expect(val('sizeOnDisk', { ...t, notCounted: 1 })).not.toBeNull();
    expect(val('contains', { ...t, notCounted: 1 })).not.toBeNull();
    expect(val('notCounted', { ...t, notCounted: 1 })).toBe('1 folder');
  });

  it('says only "Size not counted" when the protected folder itself was all there was', () => {
    expect(folderSize({ ...t, files: 0, folders: 0, bytes: 0, notCounted: 1 })).toBe(
      'Size not counted',
    );
  });
});

describe('recycleSummary', () => {
  it('says Empty for an empty bin', () => expect(recycleSummary([])).toBe('Empty'));
  it('counts items and sums the known sizes', () => {
    expect(recycleSummary([{ size: 1000 }, { size: null }, { size: 500 }])).toBe(
      `3 items · ${fmtSize(1500)}`,
    );
    expect(recycleSummary([{ size: 10 }])).toBe(`1 item · ${fmtSize(10)}`);
  });
  it('gives only the count when no size is known', () =>
    expect(recycleSummary([{ size: null }, { size: null }])).toBe('2 items'));
});

describe('one selected Trash item in the Details pane (plan 15 A.5.10)', () => {
  const item = (id: string, over: Partial<RecycleItem> = {}): RecycleItem => ({
    id,
    name: `${id}-a-really-long-trashed-file-name.txt`,
    originalParent: '/home/alex/Documents',
    deletedMs: Date.UTC(2026, 9, 21, 9, 30),
    isDir: false,
    size: null,
    ...over,
  });
  const items = [item('a'), item('b')];

  it('picks the item when exactly one is selected', () =>
    expect(recycleSelectedItem(items, new Set(['b']))).toBe(items[1]));
  it('keeps the summary (null) for none, several, or an id no longer in the bin', () => {
    expect(recycleSelectedItem(items, new Set())).toBeNull();
    expect(recycleSelectedItem(items, new Set(['a', 'b']))).toBeNull();
    expect(recycleSelectedItem(items, new Set(['gone']))).toBeNull();
  });
  it('shows Type, Original location and Date deleted in the bin', () =>
    expect(recycleItemRows(items[0], false)).toEqual([
      { key: 'type', label: 'Type', value: 'TXT file' },
      { key: 'origin', label: 'Original location', value: '/home/alex/Documents' },
      { key: 'date', label: 'Date deleted', value: fmtDate(items[0].deletedMs) },
    ]));
  it('adds Size where known and drops an unknown origin', () => {
    const rows = recycleItemRows(item('c', { originalParent: null, size: 2048 }), false);
    expect(rows.map((r) => r.label)).toEqual(['Type', 'Date deleted', 'Size']);
    expect(rows[2].value).toBe(`${fmtSize(2048)} (2,048 bytes)`);
  });
  it('says Date modified and no origin in the macOS Trash', () =>
    expect(recycleItemRows(items[0], true).map((r) => r.label)).toEqual(['Type', 'Date modified']));
});

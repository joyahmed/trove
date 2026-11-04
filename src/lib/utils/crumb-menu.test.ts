import { describe, expect, it, vi } from 'vitest';
import { NO_SUBFOLDERS, crumbMenuItems, subfoldersOf } from './crumb-menu';
import type { FileEntry } from '$lib/types/fs';

const entry = (name: string, o: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `/r/${name}`,
  isDir: true,
  size: 0,
  modifiedMs: null,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: 'folder',
  typeName: 'File folder',
  ...o,
});

describe('subfoldersOf', () => {
  it('keeps only folders, sorted with digits as numbers', () => {
    const list = [entry('b10'), entry('a.txt', { isDir: false }), entry('b2'), entry('A')];
    expect(subfoldersOf(list, false).map((e) => e.name)).toEqual(['A', 'b2', 'b10']);
  });
  it('drops hidden folders unless hidden items are shown', () => {
    const list = [entry('.git', { isHidden: true }), entry('src')];
    expect(subfoldersOf(list, false).map((e) => e.name)).toEqual(['src']);
    expect(subfoldersOf(list, true).map((e) => e.name)).toEqual(['.git', 'src']);
  });
  it('keeps the hidden folder the path continues into even when hidden items are off', () => {
    const list = [entry('.hid', { isHidden: true }), entry('.other', { isHidden: true })];
    expect(subfoldersOf(list, false, '/r/.hid').map((e) => e.name)).toEqual(['.hid']);
  });
});

describe('crumbMenuItems', () => {
  it('gives one row per folder and navigates to its path on run', () => {
    const go = vi.fn();
    const rows = crumbMenuItems([entry('a'), entry('b')], { showHidden: false, current: null, go });
    expect(rows.map((r) => r.key)).toEqual(['/r/a', '/r/b']);
    const first = rows[0];
    if (first?.kind === 'item') first.run();
    expect(go).toHaveBeenCalledWith('/r/a');
  });
  it('checks the folder the path continues into', () => {
    const rows = crumbMenuItems([entry('a'), entry('b')], {
      showHidden: false,
      current: '/r/b',
      go: vi.fn(),
    });
    const checked = rows.map((r) => (r.kind === 'item' ? (r.checked?.() ?? false) : null));
    expect(checked).toEqual([false, true]);
  });
  it('lists and checks the hidden folder you are in, with hidden items off', () => {
    const rows = crumbMenuItems([entry('.hid', { isHidden: true })], {
      showHidden: false,
      current: '/r/.hid',
      go: vi.fn(),
    });
    expect(rows.map((r) => r.key)).toEqual(['/r/.hid']);
    const first = rows[0];
    expect(first?.kind === 'item' && first.checked?.()).toBe(true);
  });
  it('shows one quiet disabled row when there is nothing to list', () => {
    const rows = crumbMenuItems([entry('f', { isDir: false })], {
      showHidden: false,
      current: null,
      go: vi.fn(),
    });
    expect(rows).toEqual([NO_SUBFOLDERS]);
    expect(NO_SUBFOLDERS.kind === 'item' && NO_SUBFOLDERS.enabled?.()).toBe(false);
  });
});

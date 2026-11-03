// G.59: reordering the details columns — the drop line, and the order landing in settings
// (saved with the rest of settings, as the widths are).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SortKey } from '$lib/data/file-columns';

vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(),
  writeSettings: vi.fn(),
  mergeSettings: vi.fn(),
}));

const { markerFor } = await import('./use-column-drag.svelte');
const { columns } = await import('$lib/state/columns.svelte');
const { settings, sanitize } = await import('$lib/state/settings.svelte');

const FOUR: SortKey[] = ['name', 'modifiedMs', 'ext', 'size'];

describe('markerFor: where the drop line goes', () => {
  it('on the left edge of the column at the gap, the right edge of the last for the end', () => {
    expect(markerFor(FOUR, 'size', 1, 'modifiedMs')).toBe('before');
    expect(markerFor(FOUR, 'size', 1, 'ext')).toBeNull();
    expect(markerFor(FOUR, 'modifiedMs', 4, 'size')).toBe('after');
  });

  it('nothing when not dragging, or when the drop would leave the column where it is', () => {
    expect(markerFor(FOUR, null, 1, 'modifiedMs')).toBeNull();
    expect(markerFor(FOUR, 'ext', 2, 'ext')).toBeNull();
    expect(markerFor(FOUR, 'ext', 3, 'size')).toBeNull();
  });

  it('a gap before Name is drawn after Name (Name stays first)', () => {
    expect(markerFor(FOUR, 'size', 0, 'name')).toBeNull();
    expect(markerFor(FOUR, 'size', 0, 'modifiedMs')).toBe('before');
  });
});

describe('columns.moveTo / shift write settings.columns', () => {
  afterEach(() => {
    settings.columns = [...FOUR];
  });

  it('a move writes the new order, which survives a save and load', () => {
    settings.columns = [...FOUR];
    expect(columns.moveTo('size', 1)).toBe(true);
    expect(settings.columns).toEqual(['name', 'size', 'modifiedMs', 'ext']);
    expect(sanitize(JSON.parse(JSON.stringify({ columns: settings.columns }))).columns).toEqual([
      'name',
      'size',
      'modifiedMs',
      'ext',
    ]);
  });

  it('a no-op move writes nothing', () => {
    settings.columns = [...FOUR];
    const before = settings.columns;
    expect(columns.moveTo('ext', 2)).toBe(false);
    expect(columns.shift('name', 1)).toBe(false);
    expect(settings.columns).toBe(before);
  });

  it('Alt+→ / Alt+← move one place', () => {
    settings.columns = [...FOUR];
    expect(columns.shift('modifiedMs', 1)).toBe(true);
    expect(settings.columns).toEqual(['name', 'ext', 'modifiedMs', 'size']);
    expect(columns.shift('modifiedMs', -1)).toBe(true);
    expect(settings.columns).toEqual(FOUR);
  });

  it('turning a column on and off keeps a dragged order', () => {
    settings.columns = ['name', 'size', 'modifiedMs', 'ext'];
    settings.toggleColumn('createdMs');
    expect(settings.columns).toEqual(['name', 'size', 'modifiedMs', 'createdMs', 'ext']);
    settings.toggleColumn('modifiedMs');
    expect(settings.columns).toEqual(['name', 'size', 'createdMs', 'ext']);
  });
});

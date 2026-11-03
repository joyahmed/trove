import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unwatchPath, watchPath } from '$lib/api/watch';
import type { FileEntry } from '$lib/types/fs';

const galleryItems = vi.fn<() => Promise<FileEntry[]>>();
vi.mock('$lib/api/gallery', () => ({ galleryItems: () => galleryItems() }));
vi.mock('$lib/api/shell', () => ({
  userProfile: vi.fn(async () => 'C:\\Users\\a'),
  knownFolders: vi.fn(async () => [{ key: 'pictures', path: 'C:\\Users\\a\\Pictures' }]),
  oneDriveRoot: vi.fn(async () => null),
}));
vi.mock('$lib/api/watch', () => ({
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
}));

import {
  GALLERY_REFRESH_MS,
  columnsFor,
  gallery,
  groupByMonth,
  linesInView,
  planGallery,
  tileLabel,
} from './gallery.svelte';

describe('tileLabel', () => {
  it('says a kind Linux cannot draw has no preview, and only names a drawable one', () => {
    expect(tileLabel('IMG_0001.HEIC', true)).toBe('HEIC · no preview');
    expect(tileLabel('clip.mov', true)).toBe('MOV · no preview');
    expect(tileLabel('scan.tiff', true)).toBe('TIFF · no preview');
    expect(tileLabel('photo.jpg', true)).toBe('JPG');
    expect(tileLabel('photo.WEBP', true)).toBe('WEBP');
    // Windows: the shell draws every kind, so nothing is called unpreviewable
    expect(tileLabel('clip.mov', false)).toBe('MOV');
    expect(tileLabel('README', true)).toBe('FILE · no preview');
  });

  it('on a Mac QuickLook draws HEIC, TIFF and most video, so only WebM-like kinds say so', () => {
    expect(tileLabel('IMG_0001.HEIC', true, true)).toBe('HEIC');
    expect(tileLabel('clip.mov', true, true)).toBe('MOV');
    expect(tileLabel('scan.tiff', true, true)).toBe('TIFF');
    expect(tileLabel('clip.webm', true, true)).toBe('WEBM · no preview');
    expect(tileLabel('clip.mkv', true, true)).toBe('MKV · no preview');
  });
});

const entry = (name: string, modifiedMs: number | null): FileEntry => ({
  name,
  path: `C:\\Pictures\\${name}`,
  isDir: false,
  size: 1,
  modifiedMs,
  createdMs: modifiedMs,
  ext: name.split('.').pop() ?? null,
  isHidden: false,
  iconKey: 'ext/jpg',
  typeName: 'JPG File',
});

const sep = new Date(2026, 8, 20).getTime();
const aug = new Date(2026, 7, 3).getTime();

describe('groupByMonth', () => {
  it('groups newest-first items by month in order, undated last', () => {
    const groups = groupByMonth([
      entry('c.jpg', sep + 1000),
      entry('b.jpg', sep),
      entry('a.jpg', aug),
      entry('x.jpg', null),
    ]);
    expect(groups.map((g) => [g.key, g.label, g.items.map((i) => i.name)])).toEqual([
      ['2026-09', 'September 2026', ['c.jpg', 'b.jpg']],
      ['2026-08', 'August 2026', ['a.jpg']],
      ['unknown', 'Unknown date', ['x.jpg']],
    ]);
  });
});

describe('gallery state', () => {
  beforeEach(() => {
    galleryItems.mockReset();
    gallery.items = [];
    gallery.loaded = false;
    gallery.error = null;
  });

  it('load fills the items once; reload asks again', async () => {
    galleryItems.mockResolvedValue([entry('a.jpg', sep)]);
    await gallery.load();
    await gallery.load();
    expect(galleryItems).toHaveBeenCalledTimes(1);
    expect(gallery.items.map((i) => i.name)).toEqual(['a.jpg']);
    expect(gallery.groups[0]?.label).toBe('September 2026');
    galleryItems.mockResolvedValue([entry('b.jpg', aug)]);
    await gallery.reload();
    expect(galleryItems).toHaveBeenCalledTimes(2);
    expect(gallery.items.map((i) => i.name)).toEqual(['b.jpg']);
    expect(gallery.loading).toBe(false);
  });

  // F5 while the first scan of Pictures is still walking it, or F5 twice: the older scan must not
  // answer last with the photos it found, nor lower the spinner the live scan is still under.
  it('a listing overtaken by a newer one writes nothing', async () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    galleryItems.mockImplementationOnce(async () => {
      await delay(20);
      return [entry('old.jpg', aug)];
    });
    galleryItems.mockImplementationOnce(async () => [entry('new.jpg', sep)]);
    const first = gallery.reload();
    const second = gallery.reload();
    await second;
    expect(gallery.items.map((i) => i.name)).toEqual(['new.jpg']);
    expect(gallery.loading).toBe(false);
    await first;
    expect(gallery.items.map((i) => i.name)).toEqual(['new.jpg']);
  });

  it('an overtaken failure does not clear the live listing or its rows', async () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    galleryItems.mockImplementationOnce(async () => {
      await delay(20);
      throw new Error('drive went away');
    });
    galleryItems.mockImplementationOnce(async () => [entry('new.jpg', sep)]);
    const first = gallery.reload();
    const second = gallery.reload();
    await Promise.all([first, second]);
    expect(gallery.error).toBeNull();
    expect(gallery.items.map((i) => i.name)).toEqual(['new.jpg']);
  });

  it('a failed load keeps the old items and sets the error', async () => {
    galleryItems.mockResolvedValue([entry('a.jpg', sep)]);
    await gallery.reload();
    galleryItems.mockRejectedValue(new Error('no pictures'));
    await gallery.reload();
    expect(gallery.error).toContain('no pictures');
    expect(gallery.items).toHaveLength(1);
  });
});

describe('gallery windowing', () => {
  const many = Array.from({ length: 5000 }, (_, i) => entry(`p${i}.jpg`, sep - i));

  it('fits as many 160 px squares, 4 px apart, as the width allows, at least one', () => {
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(160)).toBe(1);
    expect(columnsFor(324)).toBe(2);
    expect(columnsFor(1000)).toBe(6);
  });

  it('lays a month out as a heading then rows of `cols`, with every thumbnail placed once', () => {
    const { lines, height } = planGallery(groupByMonth(many), 6);
    expect(lines[0]).toMatchObject({ kind: 'header', top: 0 });
    const placed = lines.flatMap((l) => (l.kind === 'photos' ? l.items : []));
    expect(placed).toHaveLength(5000);
    const last = lines.at(-1)!;
    expect(height).toBe(last.top + last.height);
  });

  it('mounts only the lines near the viewport, however many photos there are', () => {
    const { lines } = planGallery(groupByMonth(many), 6);
    const near = linesInView(lines, 40_000, 800);
    const mounted = near.reduce((n, l) => n + (l.kind === 'photos' ? l.items.length : 0), 0);
    expect(mounted).toBeLessThan(120);
    expect(mounted).toBeGreaterThan(0);
    // and what is returned really covers the viewport
    expect(near[0].top).toBeLessThanOrEqual(40_000);
    const tail = near.at(-1)!;
    expect(tail.top + tail.height).toBeGreaterThanOrEqual(40_800);
  });

  it('shows the top of the list at scroll 0 and nothing for an empty gallery', () => {
    const { lines } = planGallery(groupByMonth(many), 6);
    expect(linesInView(lines, 0, 800)[0]).toBe(lines[0]);
    expect(linesInView([], 0, 800)).toEqual([]);
  });
});

describe('gallery refresh on change', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    galleryItems.mockReset();
    galleryItems.mockResolvedValue([]);
    vi.mocked(watchPath).mockClear();
    vi.mocked(unwatchPath).mockClear();
  });
  afterEach(() => {
    gallery.unwatch();
    vi.useRealTimers();
  });

  it('watches the Pictures folder once, however many places name it', async () => {
    await gallery.watch();
    expect(vi.mocked(watchPath).mock.calls.map((c) => c[0])).toEqual(['C:\\Users\\a\\Pictures']);
  });

  it('reloads once, after the burst settles, when a root changes', async () => {
    await gallery.watch();
    gallery.changed('c:\\users\\a\\pictures');
    gallery.changed('C:\\Users\\a\\Pictures');
    await vi.advanceTimersByTimeAsync(GALLERY_REFRESH_MS - 1);
    expect(galleryItems).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(galleryItems).toHaveBeenCalledTimes(1);
  });

  it('ignores a folder that is not one of its roots, and stops after unwatch', async () => {
    await gallery.watch();
    gallery.changed('C:\\Users\\a\\Documents');
    await vi.advanceTimersByTimeAsync(GALLERY_REFRESH_MS * 2);
    expect(galleryItems).not.toHaveBeenCalled();
    gallery.changed('C:\\Users\\a\\Pictures');
    gallery.unwatch();
    await vi.advanceTimersByTimeAsync(GALLERY_REFRESH_MS * 2);
    expect(galleryItems).not.toHaveBeenCalled();
    expect(unwatchPath).toHaveBeenCalledWith('C:\\Users\\a\\Pictures');
  });
});

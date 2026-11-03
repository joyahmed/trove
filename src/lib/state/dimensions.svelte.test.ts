import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '$lib/types/fs';

vi.mock('$lib/api/image-dims', () => ({
  imageDimensions: vi.fn(async (paths: string[]) =>
    paths.map((p): [number, number] | null => (p.includes('broken') ? null : [1920, 1080])),
  ),
}));
vi.mock('$lib/api/log', () => ({ logError: vi.fn() }));

const { imageDimensions } = await import('$lib/api/image-dims');
const { dimensions, dimensionsText, hasDimensions } = await import('./dimensions.svelte');
const { fileColumns, DEFAULT_COLUMNS, isGroupKey, isSortKey } =
  await import('$lib/data/file-columns');
const { entryComparator } = await import('$lib/utils/sort');
const { groupKeyItems, columnsMenu, sortKeyItems } = await import('$lib/data/menus');

const entry = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `/p/${name}`,
  isDir: false,
  size: 10,
  modifiedMs: 1,
  createdMs: null,
  ext: name.split('.').pop() ?? null,
  isHidden: false,
  iconKey: 'ext/',
  typeName: 'File',
  ...extra,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  dimensions.reset();
  vi.mocked(imageDimensions).mockClear();
});

describe('Dimensions column', () => {
  it('is in the chooser and the sort menu, off by default, and not a group', () => {
    expect(fileColumns.map((c) => c.key)).toContain('dims');
    expect(columnsMenu.some((m) => m.key === 'col-dims')).toBe(true);
    expect(sortKeyItems.some((m) => m.key === 'dims')).toBe(true);
    expect(groupKeyItems.some((m) => m.key === 'group-dims')).toBe(false);
    expect(DEFAULT_COLUMNS).not.toContain('dims');
    expect(isSortKey('dims')).toBe(true);
    expect(isGroupKey('dims')).toBe(false);
  });

  it('shows width × height for an image once the header is read, blank before and for others', async () => {
    const photo = entry('a.jpg');
    expect(dimensionsText(photo)).toBe('');
    await settle();
    expect(dimensionsText(photo)).toBe('1920 × 1080');
    expect(dimensionsText(entry('notes.txt'))).toBe('');
    expect(dimensionsText(entry('d', { isDir: true, ext: null }))).toBe('');
    expect(imageDimensions).toHaveBeenCalledTimes(1);
    expect(imageDimensions).toHaveBeenCalledWith(['/p/a.jpg']);
  });

  it('asks once for a file however often it is drawn, and batches the rows it meets together', async () => {
    const a = entry('a.png');
    const b = entry('b.webp');
    for (let i = 0; i < 3; i++) {
      dimensions.of(a);
      dimensions.of(b);
    }
    await settle();
    expect(imageDimensions).toHaveBeenCalledTimes(1);
    expect(vi.mocked(imageDimensions).mock.calls[0][0]).toEqual(['/p/a.png', '/p/b.webp']);
  });

  it('keeps a file it could not read blank and does not ask again; a changed file is asked again', async () => {
    const bad = entry('broken.gif');
    dimensions.of(bad);
    await settle();
    expect(dimensionsText(bad)).toBe('');
    dimensions.of(bad);
    await settle();
    expect(imageDimensions).toHaveBeenCalledTimes(1);
    dimensions.of(entry('broken.gif', { modifiedMs: 2 }));
    await settle();
    expect(imageDimensions).toHaveBeenCalledTimes(2);
  });

  it('only images the header reader knows are asked about', () => {
    expect(hasDimensions(entry('a.PNG', { ext: 'png' }))).toBe(true);
    expect(hasDimensions(entry('a.heic'))).toBe(true);
    expect(hasDimensions(entry('a.heif'))).toBe(true);
    expect(hasDimensions(entry('a.avif'))).toBe(true);
    expect(hasDimensions(entry('a.tif'))).toBe(true);
    expect(hasDimensions(entry('a.tiff'))).toBe(true);
    // SVG has no pixel size of its own, so it stays blank
    expect(hasDimensions(entry('a.svg'))).toBe(false);
  });

  it('sorts by pixel count, files without a size first ascending', async () => {
    vi.mocked(imageDimensions).mockImplementationOnce(async (paths) =>
      paths.map((p): [number, number] | null =>
        p.endsWith('big.png') ? [4000, 3000] : p.endsWith('small.png') ? [10, 10] : null,
      ),
    );
    const list = [entry('big.png'), entry('doc.txt'), entry('small.png')];
    list.sort(entryComparator('dims', 'asc')); // first pass queues the reads
    await settle();
    expect(list.sort(entryComparator('dims', 'asc')).map((e) => e.name)).toEqual([
      'doc.txt',
      'small.png',
      'big.png',
    ]);
    expect(list.sort(entryComparator('dims', 'desc')).map((e) => e.name)).toEqual([
      'big.png',
      'small.png',
      'doc.txt',
    ]);
  });
});

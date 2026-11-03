import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '$lib/types/fs';
import type { DriveKind, FolderSizeEvent } from '$lib/types/props';

let heard: ((s: FolderSizeEvent) => void) | null = null;
let kind: DriveKind = 'local';
let nextJob = 1;

vi.mock('$lib/api/props', () => ({
  folderDriveKind: vi.fn(async () => kind),
  startFolderSizes: vi.fn(async () => nextJob++),
  cancelFolderTotals: vi.fn(async () => {}),
  onFolderSize: vi.fn(async (cb: (s: FolderSizeEvent) => void) => {
    heard = cb;
    return () => {};
  }),
}));
vi.mock('$lib/api/log', () => ({ logError: vi.fn() }));

const { cancelFolderTotals, startFolderSizes } = await import('$lib/api/props');
const { countsOn, folderSizes, folderSizeText } = await import('./folder-sizes.svelte');
const { fileColumns } = await import('$lib/data/file-columns');
const { entryComparator } = await import('$lib/utils/sort');

const FOLDER = 'C:\\p';

const entry = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `${FOLDER}\\${name}`,
  isDir: true,
  size: 0,
  modifiedMs: 1,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: 'folder',
  typeName: 'File folder',
  ...extra,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Rust answering one folder of the job. */
const answer = (path: string, bytes: number, capped = false) =>
  heard?.({ jobId: 1, path, bytes, capped });

const sizeCell = fileColumns.find((c) => c.key === 'size')!.cell;

/** Show the folder and wait for its drive kind. */
const open = async (
  folder = FOLDER,
  choice: 'off' | 'local' | 'everywhere' = 'local',
): Promise<void> => {
  folderSizes.show(folder, choice);
  await settle();
};

beforeEach(() => {
  folderSizes.reset();
  heard = null;
  kind = 'local';
  nextJob = 1;
  vi.mocked(startFolderSizes).mockClear();
  vi.mocked(cancelFolderTotals).mockClear();
});

describe('folder sizes in the Size column', () => {
  it('shows "…" while counting, then the counted size; a capped walk reads "≥"', async () => {
    await open();
    const a = entry('a');
    const big = entry('big');
    expect(sizeCell(a)).toBe('…');
    expect(sizeCell(big)).toBe('…');
    await settle();
    expect(startFolderSizes).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startFolderSizes).mock.calls[0][0]).toEqual([a.path, big.path]);
    answer(a.path, 2048);
    answer(big.path, 5 * 1024 ** 3, true);
    expect(sizeCell(a)).toBe('2 KB');
    expect(sizeCell(big)).toBe('≥ 5.0 GB');
  });

  it('a file keeps its own size and is never counted', async () => {
    await open();
    const file = entry('notes.txt', { isDir: false, size: 11, ext: 'txt' });
    expect(sizeCell(file)).toBe('11 B');
    await settle();
    expect(startFolderSizes).not.toHaveBeenCalled();
  });

  it('a link to a folder and a row of another folder (a search hit) stay blank', async () => {
    await open();
    expect(sizeCell(entry('linked', { isLink: true }))).toBe('');
    expect(sizeCell(entry('deep', { path: 'C:\\p\\sub\\deep' }))).toBe('');
    await settle();
    expect(startFolderSizes).not.toHaveBeenCalled();
  });

  it('re-opening a folder is instant; a changed mtime counts it again', async () => {
    await open();
    const a = entry('a');
    folderSizeText(a);
    await settle();
    answer(a.path, 4096);
    await open('C:\\q');
    await open(FOLDER);
    vi.mocked(startFolderSizes).mockClear();
    expect(sizeCell(a)).toBe('4 KB');
    expect(sizeCell(entry('a', { modifiedMs: 2 }))).toBe('…');
    await settle();
    expect(startFolderSizes).toHaveBeenCalledTimes(1);
  });

  it('leaving the folder cancels its job and drops what was still counting', async () => {
    await open();
    const a = entry('a');
    folderSizeText(a);
    await settle();
    await settle();
    await open('C:\\q');
    expect(cancelFolderTotals).toHaveBeenCalledWith(1);
    // a size from the cancelled walk that still arrives is not kept
    answer(a.path, 999);
    await open(FOLDER);
    expect(sizeCell(a)).toBe('…');
  });
});

describe('which drives are counted', () => {
  it('the setting against the drive kind: local drives only by default', () => {
    expect(countsOn('local', 'local')).toBe(true);
    for (const k of ['network', 'removable', 'wsl'] as const) {
      expect(countsOn('local', k)).toBe(false);
      expect(countsOn('everywhere', k)).toBe(true);
    }
    expect(countsOn('off', 'local')).toBe(false);
  });

  for (const k of ['network', 'removable', 'wsl'] as const) {
    it(`a ${k} folder stays blank on "Local drives" and asks Rust for nothing`, async () => {
      kind = k;
      await open();
      expect(sizeCell(entry('a'))).toBe('');
      await settle();
      expect(startFolderSizes).not.toHaveBeenCalled();
    });
  }

  it('"Everywhere" counts a network folder; "Off" counts nothing, even on a local drive', async () => {
    kind = 'network';
    await open(FOLDER, 'everywhere');
    expect(sizeCell(entry('a'))).toBe('…');
    await settle();
    expect(startFolderSizes).toHaveBeenCalledTimes(1);
    folderSizes.reset();
    kind = 'local';
    await open(FOLDER, 'off');
    expect(sizeCell(entry('b'))).toBe('');
    await settle();
    expect(startFolderSizes).toHaveBeenCalledTimes(1);
  });
});

describe('sorting by size with folders being counted', () => {
  const names = (rows: FileEntry[]) => rows.map((e) => e.name);

  it('known folders sort by their size among the files; counting ones go last both ways', async () => {
    await open();
    const small = entry('small');
    const huge = entry('huge');
    const pending = entry('pending');
    const file = entry('file.bin', { isDir: false, size: 1000, ext: 'bin' });
    const rows = [pending, small, file, huge];
    [...rows].sort(entryComparator('size', 'desc'));
    await settle();
    answer(small.path, 10);
    answer(huge.path, 1_000_000);
    expect(names([...rows].sort(entryComparator('size', 'desc')))).toEqual([
      'huge',
      'file.bin',
      'small',
      'pending',
    ]);
    expect(names([...rows].sort(entryComparator('size', 'asc')))).toEqual([
      'small',
      'file.bin',
      'huge',
      'pending',
    ]);
    // its size lands: it moves in
    answer(pending.path, 5000);
    expect(names([...rows].sort(entryComparator('size', 'desc')))).toEqual([
      'huge',
      'pending',
      'file.bin',
      'small',
    ]);
  });

  it('with sizes off a folder sorts as 0, as before', async () => {
    await open(FOLDER, 'off');
    const dir = entry('dir');
    const file = entry('file.bin', { isDir: false, size: 1, ext: 'bin' });
    expect(names([dir, file].sort(entryComparator('size', 'desc')))).toEqual(['file.bin', 'dir']);
    expect(names([file, dir].sort(entryComparator('size', 'asc')))).toEqual(['dir', 'file.bin']);
  });
});

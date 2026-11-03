import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelSearch, startSearch } from '$lib/api/search';
import { indexSearch } from '$lib/api/palette';
import { wslRunningDistros } from '$lib/api/wsl';
import { RESULTS_FLUSH_MS, search } from './search.svelte';
import { tabs } from './tabs.svelte';
import type { FileEntry } from '$lib/types/fs';
import type { SearchBatch } from '$lib/types/search';
import { THIS_PC, pathLocation } from '$lib/utils/location';
import { places } from './places.svelte';

vi.mock('$lib/api/search', () => ({
  startSearch: vi.fn(),
  cancelSearch: vi.fn(async () => {}),
  onSearchResults: vi.fn(async () => () => {}),
}));
vi.mock('$lib/api/palette', () => ({ indexSearch: vi.fn() }));
vi.mock('$lib/api/fs', () => ({ readDir: vi.fn(async (path: string) => ({ path, entries: [] })) }));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
}));
const running = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('$lib/api/wsl', () => ({
  wslDistros: vi.fn(async () => []),
  wslHome: vi.fn(async () => ''),
  wslRunningDistros: vi.fn(async () => running.names),
}));
vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => null),
  writeSettings: vi.fn(async () => {}),
}));

const hit = (name: string): FileEntry => ({
  name,
  path: `C:\\scratch\\sub\\${name}`,
  isDir: false,
  size: 1,
  modifiedMs: null,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: 'ext/',
  typeName: 'File',
});

const batch = (
  searchId: number,
  names: string[],
  extra: Partial<SearchBatch> = {},
): SearchBatch => ({
  searchId,
  entries: names.map(hit),
  done: false,
  cancelled: false,
  error: null,
  scanned: 10,
  ...extra,
});

describe('search', () => {
  let nextId = 1;
  beforeEach(() => {
    search.clear();
    nextId = 1;
    vi.mocked(startSearch).mockImplementation(async () => nextId++);
    vi.mocked(cancelSearch).mockClear();
    vi.mocked(startSearch).mockClear();
    vi.mocked(indexSearch).mockReset();
    vi.mocked(indexSearch).mockResolvedValue({ ready: false, roots: [], hits: [], total: 0 });
    tabs.active.location = pathLocation('C:\\scratch');
  });

  it('start records the root and query and takes the id', async () => {
    await search.start('*.txt report');
    expect(search.active).toBe(true);
    expect(search.running).toBe(true);
    expect(search.roots).toEqual(['C:\\scratch']);
    expect(search.belongsTo(pathLocation('c:\\SCRATCH'))).toBe(true);
    expect(search.query).toMatchObject({ text: 'report', ext: 'txt' });
    expect(search.searchId).toBe(1);
    expect(startSearch).toHaveBeenCalledWith(['C:\\scratch'], search.query, false);
  });

  it('a place searches every drive and belongs to that place', async () => {
    tabs.active.location = THIS_PC;
    places.drives = [
      { path: 'C:\\', label: 'OS', totalBytes: 1, freeBytes: 1 },
      { path: 'D:\\', label: 'CODE', totalBytes: 1, freeBytes: 1 },
    ];
    await search.start('report');
    expect(search.roots).toEqual(['C:\\', 'D:\\']);
    expect(startSearch).toHaveBeenCalledWith(['C:\\', 'D:\\'], search.query, false);
    expect(search.belongsTo(THIS_PC)).toBe(true);
    expect(search.belongsTo(pathLocation('C:\\'))).toBe(false);
  });

  it('a place never searches a network share the person did not open', async () => {
    tabs.active.location = THIS_PC;
    places.drives = [
      { path: '/', label: 'Mac', totalBytes: 1, freeBytes: 1 },
      { path: '/Volumes/media', label: 'media', totalBytes: null, freeBytes: null, network: true },
      { path: '/Volumes/Stick', label: 'Stick', totalBytes: 1, freeBytes: 1, network: false },
    ];
    await search.start('report');
    expect(search.roots).toEqual(['/', '/Volumes/Stick']);
    expect(startSearch).toHaveBeenCalledWith(['/', '/Volumes/Stick'], search.query, false);
  });

  it('a place also searches the WSL distros that are running, never a stopped one', async () => {
    tabs.active.location = THIS_PC;
    places.drives = [{ path: 'C:\\', label: 'OS', totalBytes: 1, freeBytes: 1 }];
    running.names = ['Ubuntu'];
    await search.start('report');
    expect(search.roots).toEqual(['C:\\', '\\\\wsl.localhost\\Ubuntu\\']);
    running.names = [];
    await search.start('report');
    expect(search.roots).toEqual(['C:\\']);
  });

  it('a new start cancels the running search first', async () => {
    await search.start('a');
    await search.start('b');
    expect(cancelSearch).toHaveBeenCalledWith(1);
    expect(search.searchId).toBe(2);
    expect(search.text).toBe('b');
  });

  it('batches append only for the current id; done ends running', async () => {
    await search.start('a');
    search.apply(batch(1, ['x', 'y']));
    search.apply(batch(99, ['stale']));
    expect(search.results.map((e) => e.name)).toEqual(['x', 'y']);
    expect(search.scanned).toBe(10);
    search.apply(batch(1, ['z'], { done: true, scanned: 50 }));
    expect(search.results.map((e) => e.name)).toEqual(['x', 'y', 'z']);
    expect(search.running).toBe(false);
    expect(search.scanned).toBe(50);
  });

  it('a late batch or done of the replaced search is ignored while the new one starts', async () => {
    await search.start('a');
    expect(search.searchId).toBe(1);
    let resolveId: (id: number) => void = () => {};
    vi.mocked(startSearch).mockImplementationOnce(
      () => new Promise<number>((r) => (resolveId = r)),
    );
    const restarting = search.start('b');
    await vi.waitFor(() => expect(startSearch).toHaveBeenCalledTimes(2));
    search.apply(batch(1, ['old'], { done: true }));
    expect(search.running).toBe(true);
    expect(search.results).toEqual([]);
    resolveId(2);
    await restarting;
    expect(search.running).toBe(true);
    expect(search.results).toEqual([]);
  });

  it('a late batch of a cleared search lands nowhere', async () => {
    await search.start('a');
    search.clear();
    search.apply(batch(1, ['late']));
    expect(search.results).toEqual([]);
  });

  it('while running, a burst of batches shares one flush timer; done flushes at once', async () => {
    vi.useFakeTimers();
    try {
      await search.start('a');
      expect(vi.getTimerCount()).toBe(0);
      for (let i = 0; i < 50; i++) search.apply(batch(1, [`n${i}`]));
      expect(vi.getTimerCount()).toBe(1);
      expect(search.results).toHaveLength(50);
      vi.advanceTimersByTime(RESULTS_FLUSH_MS);
      expect(vi.getTimerCount()).toBe(0);
      search.apply(batch(1, ['more']));
      expect(vi.getTimerCount()).toBe(1);
      search.apply(batch(1, ['last'], { done: true }));
      expect(vi.getTimerCount()).toBe(0);
      expect(search.results).toHaveLength(52);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a batch that lands before the id does is kept, not dropped', async () => {
    let resolveId: (id: number) => void = () => {};
    vi.mocked(startSearch).mockImplementationOnce(
      () => new Promise<number>((r) => (resolveId = r)),
    );
    const starting = search.start('a');
    await vi.waitFor(() => expect(startSearch).toHaveBeenCalled());
    search.apply(batch(7, ['early']));
    resolveId(7);
    await starting;
    expect(search.results.map((e) => e.name)).toEqual(['early']);
  });

  it('an error batch is reported and clear resets everything', async () => {
    await search.start('a');
    search.apply(batch(1, [], { error: 'denied', done: true }));
    expect(search.error).toBe('denied');
    search.clear();
    expect(search.active).toBe(false);
    expect(search.text).toBe('');
    expect(search.results).toEqual([]);
    expect(search.chips).toEqual({ kind: null, modified: null, size: null });
  });

  it('a start overtaken while it walks the drive roots never touches the live search', async () => {
    tabs.active.location = THIS_PC;
    places.drives = [{ path: 'C:\\', label: 'OS', totalBytes: 1, freeBytes: 1 }];
    // the first search's WSL probe hangs; the chip's search overtakes it and lands first
    let releaseRoots: () => void = () => {};
    vi.mocked(wslRunningDistros).mockImplementationOnce(
      () => new Promise<string[]>((r) => (releaseRoots = () => r([]))),
    );

    const overtaken = search.start('a');
    await vi.waitFor(() => expect(wslRunningDistros).toHaveBeenCalled());
    search.chips.kind = 'folder';
    await search.start('b');
    expect(search.searchId).toBe(1);
    search.apply(batch(1, ['live'], { error: 'denied' }));
    expect(search.results.map((e) => e.name)).toEqual(['live']);

    releaseRoots();
    await overtaken;

    expect(search.text).toBe('b');
    expect(search.searchId).toBe(1);
    expect(search.results.map((e) => e.name)).toEqual(['live']);
    expect(search.error).toBe('denied');
    expect(startSearch).toHaveBeenCalledTimes(1);
    // and the live search keeps rendering
    search.apply(batch(1, ['more'], { done: true }));
    expect(search.results.map((e) => e.name)).toEqual(['live', 'more']);
    expect(search.running).toBe(false);
  });

  it('an id that arrives after a newer search took over is cancelled, not adopted', async () => {
    let resolveOldId: (id: number) => void = () => {};
    vi.mocked(startSearch).mockImplementationOnce(
      () => new Promise<number>((r) => (resolveOldId = r)),
    );

    const overtaken = search.start('a');
    await vi.waitFor(() => expect(startSearch).toHaveBeenCalledTimes(1));
    await search.start('b');
    expect(search.searchId).toBe(1);

    resolveOldId(7);
    await overtaken;

    expect(search.searchId).toBe(1);
    expect(cancelSearch).toHaveBeenCalledWith(7);
    search.apply(batch(1, ['live']));
    expect(search.results.map((e) => e.name)).toEqual(['live']);
    expect(search.running).toBe(true);
  });

  it('restart searches the same text again with the chips', async () => {
    await search.start('a');
    search.chips.kind = 'folder';
    search.restart();
    await vi.waitFor(() => expect(startSearch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(startSearch).mock.calls[1][1]).toMatchObject({ kind: 'folder', text: 'a' });
  });

  it('search state uses index for name-only query, walker for filters', async () => {
    const ready = {
      ready: true,
      roots: ['C:\\scratch'],
      hits: [hit('report.txt'), { ...hit('elsewhere.txt'), path: 'C:\\other\\elsewhere.txt' }],
      total: 2,
    };
    vi.mocked(indexSearch).mockResolvedValue(ready);

    // name only: the index answers, scoped to the folder; the walker is not started
    await search.start('report');
    expect(indexSearch).toHaveBeenCalledWith('report', 500);
    expect(startSearch).not.toHaveBeenCalled();
    expect(search.active).toBe(true);
    expect(search.running).toBe(false);
    expect(search.results.map((e) => e.name)).toEqual(['report.txt']);

    // any filter: the walker, the index untouched
    vi.mocked(indexSearch).mockClear();
    await search.start('report *.txt');
    expect(indexSearch).not.toHaveBeenCalled();
    expect(startSearch).toHaveBeenCalledTimes(1);
    search.clear();
    search.chips = { ...search.chips, kind: 'folder' };
    await search.start('report');
    expect(startSearch).toHaveBeenCalledTimes(2);
    search.clear();

    // index not ready: the walker
    vi.mocked(indexSearch).mockResolvedValue({ ready: false, roots: [], hits: [], total: 0 });
    await search.start('report');
    expect(startSearch).toHaveBeenCalledTimes(3);
    expect(search.running).toBe(true);
    search.clear();

    // index call fails: the walker
    vi.mocked(indexSearch).mockRejectedValue(new Error('boom'));
    await search.start('report');
    expect(startSearch).toHaveBeenCalledTimes(4);
  });

  it('a cut index answer (total above hits) falls back to the walker', async () => {
    vi.mocked(indexSearch).mockResolvedValue({
      ready: true,
      roots: ['C:\\scratch'],
      hits: [hit('report.txt')],
      total: 900,
    });
    await search.start('report');
    expect(startSearch).toHaveBeenCalledTimes(1);
    expect(search.running).toBe(true);
  });
});

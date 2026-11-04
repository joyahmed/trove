import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabState } from './tab.svelte';
import { gallery } from './gallery.svelte';
import { places } from './places.svelte';
import { recycle } from './recycle.svelte';
import { recent } from './recent.svelte';
import { settings } from './settings.svelte';
import {
  APPLICATIONS,
  GALLERY,
  HOME,
  RECYCLE_BIN,
  THIS_PC,
  pathLocation,
} from '$lib/utils/location';

import { pathKind, readDir } from '$lib/api/fs';
import { readArchiveDir } from '$lib/api/archive';
import { wslListings } from './wsl-listing-cache';
import { archiveLocation } from '$lib/utils/archive-location';
import type { DirListing, FileEntry } from '$lib/types/fs';

// Places never touch the OS; the one call that does (refresh on a place) is stubbed.
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  oneDriveRoot: vi.fn(async () => null),
}));
vi.mock('$lib/api/fs', () => ({ readDir: vi.fn(), pathKind: vi.fn(async () => 'dir') }));
vi.mock('$lib/api/archive', () => ({ readArchiveDir: vi.fn() }));

const entry = (name: string): FileEntry => ({
  name,
  path: `C:\\scratch\\${name}`,
  isDir: false,
  size: 1,
  modifiedMs: null,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: 'ext/',
  typeName: 'File',
});

describe('TabState on a WSL folder (listing cache)', () => {
  const WSL = '\\\\wsl.localhost\\Ubuntu\\home\\alex';
  afterEach(() => wslListings.clear());

  it('an unchanged reload keeps the same entries array', async () => {
    const tab = new TabState();
    tab.location = pathLocation(WSL);
    const rows = [entry('a'), entry('b')];
    tab.entries = rows;
    vi.mocked(readDir).mockResolvedValueOnce({ path: WSL, entries: [entry('a'), entry('b')] });
    await tab.reload();
    expect(tab.entries).toBe(rows);
    vi.mocked(readDir).mockResolvedValueOnce({ path: WSL, entries: [entry('a')] });
    await tab.reload();
    expect(tab.entries.map((e) => e.name)).toEqual(['a']);
  });

  it('a cached folder paints before its read resolves', async () => {
    const tab = new TabState();
    wslListings.remember(WSL, [entry('cached')]);
    let resolve!: (l: DirListing) => void;
    vi.mocked(readDir).mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const going = tab.navigate(WSL);
    await Promise.resolve();
    expect(tab.path).toBe(WSL);
    expect(tab.loading).toBe(false);
    expect(tab.entries.map((e) => e.name)).toEqual(['cached']);
    resolve({ path: WSL, entries: [entry('cached'), entry('new')] });
    await going;
    expect(tab.entries.map((e) => e.name)).toEqual(['cached', 'new']);
  });
});

describe('TabState.reload', () => {
  it('swaps the listing in without raising loading', async () => {
    const tab = new TabState();
    tab.location = pathLocation('C:\\scratch');
    tab.entries = [entry('a')];
    const seen: boolean[] = [];
    vi.mocked(readDir).mockImplementationOnce(async (path) => {
      seen.push(tab.loading);
      return { path, entries: [entry('a'), entry('b')] };
    });
    await tab.reload();
    expect(seen).toEqual([false]);
    expect(tab.loading).toBe(false);
    expect(tab.entries.map((e) => e.name)).toEqual(['a', 'b']);
    expect(tab.error).toBeNull();
  });

  it('keeps the old rows and reports the error when the read fails', async () => {
    const tab = new TabState();
    tab.location = pathLocation('C:\\scratch');
    tab.entries = [entry('a')];
    vi.mocked(readDir).mockRejectedValueOnce(new Error('gone'));
    await tab.reload();
    expect(tab.entries.map((e) => e.name)).toEqual(['a']);
    expect(tab.error).toContain('gone');
    expect(tab.loading).toBe(false);
  });

  it('is a no-op on a place', async () => {
    const tab = new TabState();
    await tab.navigate(HOME, { replace: true });
    vi.mocked(readDir).mockClear();
    await tab.reload();
    expect(readDir).not.toHaveBeenCalled();
  });
});

describe('TabState.filter', () => {
  it('narrows visible by a case-insensitive name substring and clears on navigate', async () => {
    const tab = new TabState();
    tab.location = pathLocation('C:\\scratch');
    tab.entries = [entry('zed-report.txt'), entry('notes.md'), entry('Alpha-report.txt')];
    tab.filter = 'REP';
    expect(tab.visible.map((e) => e.name)).toEqual(['Alpha-report.txt', 'zed-report.txt']);
    tab.filter = '';
    expect(tab.visible).toHaveLength(3);
    tab.filter = 'zzz';
    expect(tab.visible).toHaveLength(0);
    await tab.navigate(HOME, { replace: true });
    expect(tab.filter).toBe('');
  });
});

describe('TabState on a place', () => {
  it('starts as an empty folder tab', () => {
    const tab = new TabState();
    expect(tab.isFolder).toBe(true);
    expect(tab.path).toBe('');
    expect(tab.canGoUp).toBe(false);
  });

  it('navigates to Home without a listing and derives an empty path', async () => {
    const tab = new TabState();
    await tab.navigate(HOME, { replace: true });
    expect(tab.location).toEqual(HOME);
    expect(tab.isFolder).toBe(false);
    expect(tab.path).toBe('');
    expect(tab.entries).toEqual([]);
    expect(tab.loading).toBe(false);
    expect(tab.canGoUp).toBe(false);
    expect(tab.canGoBack).toBe(false);
  });

  it('keeps places in the history stacks', async () => {
    const tab = new TabState();
    await tab.navigate(HOME, { replace: true });
    await tab.navigate(THIS_PC);
    expect(tab.canGoBack).toBe(true);
    await tab.back();
    expect(tab.location).toEqual(HOME);
    expect(tab.canGoForward).toBe(true);
    await tab.forward();
    expect(tab.location).toEqual(THIS_PC);
  });

  // A Ctrl+N window lands on its start place with a plain navigate (no `replace`). The blank
  // tab it was built as is not somewhere you went: Back from the next place must give the start
  // place, and Back on the start place must be greyed out — not a blank "New tab".
  describe.each([
    ['Home', HOME],
    ['This PC', THIS_PC],
    ['Gallery', GALLERY],
    ['Applications', APPLICATIONS],
    ['a folder', pathLocation('C:\\scratch')],
  ])('a fresh tab that starts on %s', (_, start) => {
    beforeEach(() => {
      vi.mocked(readDir).mockImplementation(async (path) => ({ path, entries: [] }));
    });
    afterEach(() => vi.mocked(readDir).mockReset());

    it('has nothing to go back to', async () => {
      const tab = new TabState();
      await tab.navigate(start);
      expect(tab.location).toEqual(start);
      expect(tab.canGoBack).toBe(false);
    });

    it('Back from the Recycle Bin returns to it, and no further', async () => {
      const tab = new TabState();
      await tab.navigate(start);
      await tab.navigate(RECYCLE_BIN);
      await tab.back();
      expect(tab.location).toEqual(start);
      expect(tab.canGoBack).toBe(false);
      await tab.back();
      expect(tab.location).toEqual(start);
    });
  });

  it('does not record a move to the same place', async () => {
    const tab = new TabState();
    await tab.navigate(HOME, { replace: true });
    await tab.navigate(HOME);
    expect(tab.canGoBack).toBe(false);
  });

  it('goes up from a drive root to This PC', async () => {
    const tab = new TabState();
    tab.location = pathLocation('C:\\');
    expect(tab.canGoUp).toBe(true);
    await tab.up();
    expect(tab.location).toEqual(THIS_PC);
    expect(tab.canGoBack).toBe(true);
  });

  it('refresh on a place re-asks the OS for the places', async () => {
    const tab = new TabState();
    await tab.navigate(THIS_PC, { replace: true });
    const reload = vi.spyOn(places, 'reload');
    await tab.refresh();
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockRestore();
  });

  // The toolbar button and the menu's Refresh call `tab.refresh`; only the view's own F5 used to
  // reload the bin, so files recycled from outside showed up after leaving and re-entering it.
  it('refresh on the Recycle Bin re-lists the bin, not the places', async () => {
    const tab = new TabState();
    await tab.navigate(RECYCLE_BIN, { replace: true });
    const bin = vi.spyOn(recycle, 'reload').mockResolvedValue();
    const placesReload = vi.spyOn(places, 'reload');
    await tab.refresh();
    expect(bin).toHaveBeenCalledTimes(1);
    expect(placesReload).not.toHaveBeenCalled();
    bin.mockRestore();
    placesReload.mockRestore();
  });

  it('refresh on Gallery re-scans the pictures, not the places', async () => {
    const tab = new TabState();
    await tab.navigate(GALLERY, { replace: true });
    const scan = vi.spyOn(gallery, 'reload').mockResolvedValue();
    const placesReload = vi.spyOn(places, 'reload');
    await tab.refresh();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(placesReload).not.toHaveBeenCalled();
    scan.mockRestore();
    placesReload.mockRestore();
  });

  it('refresh on Home reloads the places and the recent files (the button too, not just F5)', async () => {
    const tab = new TabState();
    await tab.navigate(HOME, { replace: true });
    const files = vi.spyOn(recent, 'loadFiles').mockResolvedValue();
    const placesReload = vi.spyOn(places, 'reload').mockResolvedValue();
    await tab.refresh();
    expect(files).toHaveBeenCalledTimes(1);
    expect(placesReload).toHaveBeenCalledTimes(1);
    files.mockRestore();
    placesReload.mockRestore();
  });
});

describe('TabState.sortBy', () => {
  it('flips the active column and opens a new one the way Explorer opens it', () => {
    const tab = new TabState();
    expect([tab.sortKey, tab.sortDir]).toEqual(['name', 'asc']);
    tab.sortBy('name');
    expect(tab.sortDir).toBe('desc');
    // a date column opens newest-first, not oldest-first
    tab.sortBy('modifiedMs');
    expect([tab.sortKey, tab.sortDir]).toEqual(['modifiedMs', 'desc']);
    tab.sortBy('modifiedMs');
    expect(tab.sortDir).toBe('asc');
    tab.sortBy('name');
    expect([tab.sortKey, tab.sortDir]).toEqual(['name', 'asc']);
  });

  it('remembers the sort in the settings, so the next tab and the next run keep it', () => {
    const tab = new TabState();
    tab.sortBy('size');
    expect([settings.sortKey, settings.sortDir]).toEqual(['size', 'desc']);
    expect([new TabState().sortKey, new TabState().sortDir]).toEqual(['size', 'desc']);
    settings.sortKey = 'name';
    settings.sortDir = 'asc';
  });

  it('follows a sort that lands after the tab was built, until the folder is sorted by hand', () => {
    // tabs are constructed at module load; the settings file is read after. A tab that copied
    // the sort at construction would show the defaults for ever — the first tab, every launch.
    const tab = new TabState();
    tab.location = pathLocation('E:\\Tainment');
    settings.sortKey = 'modifiedMs';
    settings.sortDir = 'desc';
    expect([tab.sortKey, tab.sortDir]).toEqual(['modifiedMs', 'desc']);
    // once this folder is sorted by hand it holds its own, and a later change to the global
    // default does not move it
    tab.sortBy('name');
    settings.sortKey = 'size';
    settings.sortDir = 'desc';
    expect([tab.sortKey, tab.sortDir]).toEqual(['name', 'asc']);
    settings.sortKey = 'name';
    settings.sortDir = 'asc';
    settings.folderViews = [];
  });
});

describe('TabState.groupBy', () => {
  it('follows a grouping that lands after the tab was built, until it is set by hand', () => {
    // the same trap as the sort above, with one extra tooth: `null` is a real choice here
    // ("(None)"), so "not chosen" cannot be `null` and the fallback cannot be `??`.
    const tab = new TabState();
    tab.location = pathLocation('E:\\Tainment');
    expect(tab.groupKey).toBeNull();
    settings.groupKey = 'modifiedMs';
    expect(tab.groupKey).toBe('modifiedMs');
    tab.groupBy(null);
    settings.groupKey = 'size';
    expect(tab.groupKey).toBeNull();
    settings.groupKey = null;
    settings.folderViews = [];
  });

  it('remembers the grouping in the settings, so the next tab and the next run keep it', () => {
    const tab = new TabState();
    tab.groupBy('ext');
    expect(settings.groupKey).toBe('ext');
    expect(new TabState().groupKey).toBe('ext');
    settings.groupKey = null;
  });
});

// ⭐ The feature Joy asked for with screenshots and never got. Explorer's global default is
// ungrouped too — what makes Windows look automatic is that the **Downloads** folder template
// ships with Group by: Date modified on, and that Explorer then remembers what you change
// **per folder**. Both halves live here; the arithmetic of the buckets is `utils/sort.test.ts`.
describe('TabState per-folder view state', () => {
  const DOWNLOADS = 'C:\\Users\\alex\\Downloads';

  beforeEach(() => {
    settings.folderViews = [];
    settings.groupKey = null;
    settings.sortKey = 'name';
    settings.sortDir = 'asc';
    places.knownFolders = [{ key: 'downloads', label: 'Downloads', path: DOWNLOADS }];
    vi.mocked(readDir).mockImplementation(async (path) => ({ path, entries: [] }));
  });

  afterEach(() => {
    settings.folderViews = [];
    places.knownFolders = [];
    vi.mocked(readDir).mockReset();
  });

  it('Downloads arrives grouped by date on its first visit, with nothing stored', async () => {
    const tab = new TabState();
    await tab.navigate(DOWNLOADS);
    expect(tab.groupKey).toBe('modifiedMs');
    // ⚠️ and the folder was listed ONCE. Applying the view in an $effect is the shape of the
    // cascade fixed in 71ddc2a; this is the assertion that would catch it coming back.
    expect(vi.mocked(readDir).mock.calls).toHaveLength(1);
    // and it is the *known* folder, not the name: a folder of your own called Downloads is not it
    await tab.navigate('E:\\Downloads');
    expect(tab.groupKey).toBeNull();
    expect(vi.mocked(readDir).mock.calls).toHaveLength(2);
  });

  it('every other folder is as ungrouped on its first visit as it was before this existed', async () => {
    const tab = new TabState();
    await tab.navigate('E:\\Tainment');
    expect(tab.groupKey).toBeNull();
    expect([tab.sortKey, tab.sortDir]).toEqual(['name', 'asc']);
  });

  it('a grouping set in one folder is remembered there, and does not follow you elsewhere', async () => {
    const tab = new TabState();
    await tab.navigate('E:\\Tainment');
    tab.groupBy('ext');
    expect(tab.groupKey).toBe('ext');

    // ⛔ this is the bug: one global `groupKey` meant grouping one folder grouped every folder
    await tab.navigate('E:\\Softwares');
    expect(tab.groupKey).toBeNull();

    await tab.navigate('E:\\Tainment');
    expect(tab.groupKey).toBe('ext');
    // a second tab opening the same folder sees it too — the memory is the folder's, not the tab's
    const other = new TabState();
    await other.navigate('E:\\Tainment');
    expect(other.groupKey).toBe('ext');
  });

  it('the sort travels with the grouping — a group by date with a name sort is not what was asked', async () => {
    const tab = new TabState();
    await tab.navigate('E:\\Tainment');
    tab.groupBy('modifiedMs');
    tab.sortBy('size');
    expect([tab.groupKey, tab.sortKey, tab.sortDir]).toEqual(['modifiedMs', 'size', 'desc']);
    await tab.navigate('E:\\Softwares');
    await tab.navigate('E:\\Tainment');
    expect([tab.groupKey, tab.sortKey, tab.sortDir]).toEqual(['modifiedMs', 'size', 'desc']);
  });

  it('⭐ the Downloads seed is a default, not a policy: turned off, it stays off', async () => {
    const tab = new TabState();
    await tab.navigate(DOWNLOADS);
    expect(tab.groupKey).toBe('modifiedMs');
    tab.groupBy(null);
    await tab.navigate('E:\\Tainment');
    await tab.navigate(DOWNLOADS);
    expect(tab.groupKey).toBeNull();
    // and it survives the restart: the entry is in the settings, not in the tab
    expect(settings.folderViews.map((v) => [v.path, v.groupKey])).toEqual([
      ['c:\\users\\alex\\downloads', null],
    ]);
    // and it survives the restart, because the entry is in the settings and not in the tab
    const next = new TabState();
    await next.navigate(DOWNLOADS);
    expect(next.groupKey).toBeNull();
  });

  it('the known-folder list landing late still seeds Downloads — no effect, no refetch', async () => {
    // `places.load()` is an OS call that can take a minute (see places.svelte.ts); the folder can
    // be on screen well before it lands, so the seed has to be derived, not applied on arrival.
    places.knownFolders = [];
    const tab = new TabState();
    await tab.navigate(DOWNLOADS);
    expect(tab.groupKey).toBeNull();
    const reads = vi.mocked(readDir).mock.calls.length;
    places.knownFolders = [{ key: 'downloads', label: 'Downloads', path: DOWNLOADS }];
    expect(tab.groupKey).toBe('modifiedMs');
    // ⚠️ and the folder was NOT listed again: this is derived state, not an $effect that navigates
    expect(vi.mocked(readDir).mock.calls).toHaveLength(reads);
  });

  it('navigating never writes to the map — the memory is of changes, not of visits', async () => {
    const tab = new TabState();
    await tab.navigate(DOWNLOADS);
    await tab.navigate('E:\\Tainment');
    await tab.navigate('E:\\Softwares');
    expect(settings.folderViews).toEqual([]);
    // three navigations, three listings: no write, so nothing to re-list
    expect(vi.mocked(readDir).mock.calls).toHaveLength(3);
  });

  it('the same folder in a different case is one folder', async () => {
    const tab = new TabState();
    await tab.navigate('C:\\Users\\alex\\Downloads');
    tab.groupBy('size');
    await tab.navigate('E:\\Tainment');
    await tab.navigate('c:\\users\\alex\\downloads\\');
    expect(tab.groupKey).toBe('size');
    expect(settings.folderViews).toHaveLength(1);
  });

  it('a place has no folder state: the choice lands on the global default instead', async () => {
    const tab = new TabState();
    await tab.navigate(THIS_PC);
    tab.groupBy('ext');
    expect(settings.folderViews).toEqual([]);
    expect(settings.groupKey).toBe('ext');
    settings.groupKey = null;
  });
});

/** A promise the test settles by hand, so two reads really are in flight at the same time. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const listingOf = (path: string, names: string[]): DirListing => ({
  path,
  entries: names.map(entry),
});

describe('TabState overlapping reads', () => {
  beforeEach(() => void vi.mocked(readDir).mockReset());
  afterEach(() => void vi.mocked(readDir).mockReset());

  it('a superseded navigate writes neither the rows nor the breadcrumb', async () => {
    const tab = new TabState();
    const slow = deferred<DirListing>();
    const fast = deferred<DirListing>();
    vi.mocked(readDir).mockImplementation((path) =>
      path === 'D:\\slow' ? slow.promise : fast.promise,
    );
    const first = tab.navigate('D:\\slow');
    const second = tab.navigate('C:\\fast');
    fast.resolve(listingOf('C:\\fast', ['f']));
    await second;
    expect(tab.path).toBe('C:\\fast');
    // the abandoned read answers last; it must not be the one left on screen
    slow.resolve(listingOf('D:\\slow', ['s']));
    await first;
    expect(tab.path).toBe('C:\\fast');
    expect(tab.entries.map((e) => e.name)).toEqual(['f']);
    expect(tab.loading).toBe(false);
  });

  it('a navigate that has been overtaken does not lower loading or move the tab', async () => {
    const tab = new TabState();
    tab.location = pathLocation('C:\\start');
    tab.entries = [entry('start')];
    const fast = deferred<DirListing>();
    const slow = deferred<DirListing>();
    vi.mocked(readDir).mockImplementation((path) =>
      path === 'C:\\fast' ? fast.promise : slow.promise,
    );
    const first = tab.navigate('C:\\fast');
    const second = tab.navigate('D:\\slow');
    fast.resolve(listingOf('C:\\fast', ['f']));
    await first;
    // the slow folder is the one being waited for: the list must still say it is loading, and
    // nothing may stop off at a folder nobody asked to stay in
    expect(tab.loading).toBe(true);
    expect(tab.path).toBe('C:\\start');
    expect(tab.entries.map((e) => e.name)).toEqual(['start']);
    slow.resolve(listingOf('D:\\slow', ['s']));
    await second;
    expect(tab.path).toBe('D:\\slow');
    expect(tab.entries.map((e) => e.name)).toEqual(['s']);
    expect(tab.loading).toBe(false);
  });

  it('a read that fails after the tab moved on does not paint its error on the new folder', async () => {
    const tab = new TabState();
    tab.location = pathLocation('C:\\old');
    const stale = deferred<DirListing>();
    const moved = deferred<DirListing>();
    vi.mocked(readDir).mockImplementation((path) =>
      path === 'C:\\old' ? stale.promise : moved.promise,
    );
    const reloading = tab.reload(); // the watcher, or the 5 s WSL poll
    const moving = tab.navigate('C:\\new');
    moved.resolve(listingOf('C:\\new', ['n']));
    await moving;
    stale.reject(new Error('C:\\old is gone'));
    await reloading;
    expect(tab.path).toBe('C:\\new');
    expect(tab.entries.map((e) => e.name)).toEqual(['n']);
    expect(tab.error).toBeNull();
  });

  it('a Recent folder that is gone leaves Recent when opening it fails; one still there stays', async () => {
    const tab = new TabState();
    tab.location = pathLocation('/Users/alex');
    settings.recentFolders = ['/Users/alex/x', '/Users/alex/locked', '/Users/alex/kept'];
    vi.mocked(readDir).mockRejectedValue('"x" is no longer there.');
    vi.mocked(pathKind).mockImplementation(async (p) =>
      p === '/Users/alex/x' ? 'missing' : 'dir',
    );
    await tab.navigate('/Users/alex/x');
    expect(tab.error).toBe('"x" is no longer there.');
    await vi.waitFor(() =>
      expect(settings.recentFolders).toEqual(['/Users/alex/locked', '/Users/alex/kept']),
    );
    // there but unreadable: the entry is kept, it may open again later
    await tab.navigate('/Users/alex/locked');
    await vi.waitFor(() => expect(pathKind).toHaveBeenCalledWith('/Users/alex/locked'));
    expect(settings.recentFolders).toEqual(['/Users/alex/locked', '/Users/alex/kept']);
    expect(tab.path).toBe('/Users/alex/locked');
    vi.mocked(pathKind).mockReset();
    vi.mocked(pathKind).mockImplementation(async () => 'dir');
    settings.recentFolders = [];
  });

  it('a re-read of a folder that is still unreadable keeps its error', async () => {
    const tab = new TabState();
    tab.location = pathLocation('C:\\here');
    vi.mocked(readDir).mockImplementation(async (path) => {
      if (path === 'D:\\bad') throw new Error('D:\\bad is not readable');
      return listingOf(path, ['h']);
    });
    await tab.navigate('D:\\bad');
    // a navigate that fails shows the destination, empty, with its message
    expect(tab.path).toBe('D:\\bad');
    expect(tab.error).toContain('D:\\bad');
    await tab.reload();
    // still unreadable, so a re-read keeps the message
    expect(tab.error).toContain('D:\\bad');
  });

  it('a folder that cannot be read shows as the location, empty, with the error; Back restores the rows', async () => {
    const tab = new TabState();
    vi.mocked(readDir).mockImplementation(async (path) => {
      if (path === 'C:\\locked') throw new Error('Access is denied. (os error 5)');
      return listingOf(path, ['a', 'b']);
    });
    await tab.navigate('C:\\here');
    expect(tab.entries).toHaveLength(2);
    await tab.navigate('C:\\locked');
    expect(tab.path).toBe('C:\\locked');
    expect(tab.entries).toEqual([]);
    expect(tab.error).toContain('Access is denied');
    expect(tab.loading).toBe(false);
    await tab.back();
    expect(tab.path).toBe('C:\\here');
    expect(tab.entries.map((e) => e.name)).toEqual(['a', 'b']);
    expect(tab.error).toBeNull();
  });

  it('two reloads of one folder: the older answer does not land on top of the newer', async () => {
    // the reason this is a generation counter and not a path comparison — both of these reads
    // are of the folder on screen, so a path test cannot tell them apart
    const tab = new TabState();
    tab.location = pathLocation('C:\\scratch');
    const older = deferred<DirListing>();
    const newer = deferred<DirListing>();
    let call = 0;
    vi.mocked(readDir).mockImplementation(() => (++call === 1 ? older.promise : newer.promise));
    const first = tab.reload();
    const second = tab.reload();
    newer.resolve(listingOf('C:\\scratch', ['new']));
    await second;
    older.resolve(listingOf('C:\\scratch', ['old']));
    await first;
    expect(tab.entries.map((e) => e.name)).toEqual(['new']);
  });

  it('records history where the move landed, so Back after two quick clicks goes back', async () => {
    const tab = new TabState();
    tab.location = pathLocation('C:\\start');
    const slow = deferred<DirListing>();
    const fast = deferred<DirListing>();
    vi.mocked(readDir).mockImplementation((path) =>
      path === 'D:\\slow' ? slow.promise : fast.promise,
    );
    const first = tab.navigate('D:\\slow');
    const second = tab.navigate('C:\\fast');
    fast.resolve(listingOf('C:\\fast', ['f']));
    await second;
    slow.resolve(listingOf('D:\\slow', ['s']));
    await first;
    // one entry, for the folder actually left — not two for the same one, which would make the
    // first Back appear to do nothing
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['back']));
    await tab.back();
    expect(tab.path).toBe('C:\\start');
    expect(tab.canGoBack).toBe(false);
  });

  it('a back whose read fails still steps, showing that folder empty with its error', async () => {
    const tab = new TabState();
    tab.location = pathLocation('C:\\here');
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['ok']));
    await tab.navigate('C:\\there');
    expect([tab.canGoBack, tab.canGoForward]).toEqual([true, false]);
    const failing = deferred<DirListing>();
    vi.mocked(readDir).mockImplementation(() => failing.promise);
    const going = tab.back();
    failing.reject(new Error('C:\\here is gone'));
    await going;
    // the folder is shown empty with its message, and the step stands: Forward returns to
    // the folder we left
    expect(tab.path).toBe('C:\\here');
    expect(tab.entries).toEqual([]);
    expect([tab.canGoBack, tab.canGoForward]).toEqual([false, true]);
    expect(tab.error).toContain('C:\\here');
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['ok']));
    await tab.forward();
    expect(tab.path).toBe('C:\\there');
    expect([tab.canGoBack, tab.canGoForward]).toEqual([true, false]);
  });

  it('a forward whose read fails still steps, showing that folder empty with its error', async () => {
    const tab = new TabState();
    tab.location = pathLocation('C:\\one');
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['ok']));
    await tab.navigate('C:\\two');
    await tab.back();
    expect([tab.canGoBack, tab.canGoForward]).toEqual([false, true]);
    const failing = deferred<DirListing>();
    vi.mocked(readDir).mockImplementation(() => failing.promise);
    const going = tab.forward();
    failing.reject(new Error('C:\\two is gone'));
    await going;
    expect(tab.path).toBe('C:\\two');
    expect(tab.entries).toEqual([]);
    expect([tab.canGoBack, tab.canGoForward]).toEqual([true, false]);
    expect(tab.error).toContain('C:\\two');
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['ok']));
    await tab.back();
    expect(tab.path).toBe('C:\\one');
    expect([tab.canGoBack, tab.canGoForward]).toEqual([false, true]);
  });

  it('an up whose read fails shows the parent empty with its error, and Back returns', async () => {
    const tab = new TabState();
    tab.location = pathLocation('C:\\a\\b');
    const failing = deferred<DirListing>();
    vi.mocked(readDir).mockImplementation(() => failing.promise);
    const going = tab.up();
    failing.reject(new Error('C:\\a is gone'));
    await going;
    expect(tab.path).toBe('C:\\a');
    expect([tab.canGoBack, tab.canGoForward]).toEqual([true, false]);
    expect(tab.error).toContain('C:\\a');
  });

  it('two quick clicks on Back step twice, rather than twice onto the same entry', async () => {
    // why Back and Forward move the stacks up front instead of at the landing point the way a
    // push does: a step *consumes* an entry, and two peeks of one entry would go back once
    const tab = new TabState();
    tab.location = pathLocation('C:\\one');
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['ok']));
    await tab.navigate('C:\\two');
    await tab.navigate('C:\\three');
    const overtaken = deferred<DirListing>();
    const winner = deferred<DirListing>();
    vi.mocked(readDir).mockImplementation((path) =>
      path === 'C:\\two' ? overtaken.promise : winner.promise,
    );
    const first = tab.back();
    const second = tab.back();
    winner.resolve(listingOf('C:\\one', ['w']));
    await second;
    overtaken.resolve(listingOf('C:\\two', ['o']));
    await first;
    // both entries were consumed, and there are two ways forward again. Peeking at the landing
    // point instead would have taken the same entry twice: one folder back, for two clicks.
    expect(tab.path).toBe('C:\\one');
    expect([tab.canGoBack, tab.canGoForward]).toEqual([false, true]);
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['ok']));
    await tab.forward();
    expect(tab.canGoForward).toBe(true);
    await tab.forward();
    expect(tab.path).toBe('C:\\three');
    expect([tab.canGoBack, tab.canGoForward]).toEqual([true, false]);
  });

  it('two overlapping refreshes keep the spinner up until the last one settles', async () => {
    const tab = new TabState();
    tab.location = pathLocation('C:\\scratch');
    const older = deferred<DirListing>();
    const newer = deferred<DirListing>();
    let call = 0;
    vi.mocked(readDir).mockImplementation(() => (++call === 1 ? older.promise : newer.promise));
    const first = tab.refresh();
    const second = tab.refresh();
    expect(tab.refreshing).toBe(true);
    older.resolve(listingOf('C:\\scratch', ['old']));
    await first;
    // the first F5 is done, 700 ms floor included — but the second read is still out, so the
    // button must still be spinning
    expect(tab.refreshing).toBe(true);
    newer.resolve(listingOf('C:\\scratch', ['new']));
    await second;
    expect(tab.refreshing).toBe(false);
    expect(tab.entries.map((e) => e.name)).toEqual(['new']);
  });
});

describe('TabState history under overlapping steps', () => {
  beforeEach(() => void vi.mocked(readDir).mockReset());
  afterEach(() => void vi.mocked(readDir).mockReset());

  const walk = async (tab: TabState, folders: string[]) => {
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['x']));
    tab.location = pathLocation(folders[0]);
    for (const f of folders.slice(1)) await tab.navigate(f);
  };

  it('a Back superseded by a click on a folder keeps the entry it was about to use', async () => {
    const tab = new TabState();
    await walk(tab, ['C:\\a', 'C:\\b']);
    const slow = deferred<DirListing>();
    vi.mocked(readDir).mockImplementation((path) =>
      path === 'C:\\a' ? slow.promise : Promise.resolve(listingOf(path, ['x'])),
    );
    const going = tab.back();
    await tab.navigate('C:\\c');
    slow.resolve(listingOf('C:\\a', ['x']));
    await going;
    expect(tab.path).toBe('C:\\c');
    // a and b are both still behind us, in order
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['x']));
    await tab.back();
    expect(tab.path).toBe('C:\\b');
    await tab.back();
    expect(tab.path).toBe('C:\\a');
    expect(tab.canGoBack).toBe(false);
  });

  it('two quick Backs move two folders and leave both ahead of you for Forward', async () => {
    const tab = new TabState();
    await walk(tab, ['C:\\a', 'C:\\b', 'C:\\c', 'C:\\d']);
    const first = deferred<DirListing>();
    const second = deferred<DirListing>();
    vi.mocked(readDir).mockImplementation((path) =>
      path === 'C:\\c' ? first.promise : second.promise,
    );
    const one = tab.back();
    const two = tab.back();
    second.resolve(listingOf('C:\\b', ['x']));
    await two;
    first.resolve(listingOf('C:\\c', ['x']));
    await one;
    expect(tab.path).toBe('C:\\b');
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['x']));
    await tab.forward();
    expect(tab.path).toBe('C:\\c');
    await tab.forward();
    expect(tab.path).toBe('C:\\d');
    expect(tab.canGoForward).toBe(false);
  });
});

describe('TabState scroll per history entry', () => {
  beforeEach(() => void vi.mocked(readDir).mockReset());
  afterEach(() => void vi.mocked(readDir).mockReset());

  it('opens a new folder at the top and Back returns to where that entry was left', async () => {
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['x']));
    const tab = new TabState();
    tab.location = pathLocation('C:\\a');
    tab.scrollOffset = 640;
    await tab.navigate('C:\\b');
    expect(tab.scrollOffset).toBe(0);
    expect(tab.scrollRestore.offset).toBe(0);
    tab.scrollOffset = 90;
    await tab.back();
    expect(tab.path).toBe('C:\\a');
    expect(tab.scrollRestore.offset).toBe(640);
    await tab.forward();
    expect(tab.scrollRestore.offset).toBe(90);
  });

  it('a refresh of the same folder keeps the offset', async () => {
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['x']));
    const tab = new TabState();
    tab.location = pathLocation('C:\\a');
    tab.scrollOffset = 300;
    await tab.navigate('C:\\a', { replace: true });
    expect(tab.scrollOffset).toBe(300);
  });
});

describe('TabState.sortTo (the palette and menu "Sort by …")', () => {
  it('sets the order instead of flipping it, so running it twice changes nothing', () => {
    const tab = new TabState();
    tab.sortTo('name');
    expect([tab.sortKey, tab.sortDir]).toEqual(['name', 'asc']);
    tab.sortTo('name');
    expect([tab.sortKey, tab.sortDir]).toEqual(['name', 'asc']);
  });

  it('from a header-flipped Z→A, "Sort by name" goes back to A→Z', () => {
    const tab = new TabState();
    tab.sortBy('name'); // header click on the active column flips it
    expect(tab.sortDir).toBe('desc');
    tab.sortTo('name');
    expect(tab.sortDir).toBe('asc');
  });
});

describe('TabState inside an archive (plan 16, Phase 4)', () => {
  const ZIP = 'C:/t/a.zip'.replaceAll('/', String.fromCharCode(92));
  const row = (inner: string, isDir: boolean): FileEntry => ({
    ...entry(inner.split('/').at(-1) ?? inner),
    path: `${ZIP}\u0000${inner}`,
    isDir,
  });

  it('navigate reads the listing through readArchiveDir; read-only by type', async () => {
    vi.mocked(readArchiveDir).mockResolvedValueOnce({
      path: ZIP,
      entries: [row('docs', true), row('a.txt', false)],
    });
    const tab = new TabState();
    await tab.navigate(archiveLocation(ZIP));
    expect(readArchiveDir).toHaveBeenLastCalledWith(ZIP, '');
    expect(tab.location).toEqual(archiveLocation(ZIP));
    expect(tab.entries.map((e) => e.name)).toEqual(['docs', 'a.txt']);
    expect(tab.inArchive).toBe(true);
    expect(tab.showsList).toBe(true);
    // the watcher and every write action key off these two
    expect(tab.isFolder).toBe(false);
    expect(tab.path).toBe('');
    expect(tab.loadingText).toBe('Reading archive…');
  });

  it('Up from the archive top returns to the containing folder', async () => {
    vi.mocked(readArchiveDir).mockResolvedValue({ path: ZIP, entries: [] });
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['a.zip']));
    const tab = new TabState();
    await tab.navigate(archiveLocation(ZIP, 'docs'));
    await tab.up();
    expect(tab.location).toEqual(archiveLocation(ZIP));
    await tab.up();
    expect(tab.location).toEqual(pathLocation(ZIP.slice(0, -'\\a.zip'.length)));
    expect(tab.isFolder).toBe(true);
    await tab.back();
    expect(tab.location).toEqual(archiveLocation(ZIP));
  });

  it('a corrupt archive is an error and the tab stays where it was', async () => {
    vi.mocked(readDir).mockImplementation(async (path) => listingOf(path, ['a.zip']));
    const tab = new TabState();
    await tab.navigate('C:\\t');
    vi.mocked(readArchiveDir).mockRejectedValueOnce('not a zip archive');
    await tab.navigate(archiveLocation(ZIP));
    expect(tab.error).toBe('not a zip archive');
    expect(tab.location).toEqual(pathLocation('C:\\t'));
    expect(tab.loading).toBe(false);
  });

  it('F5 inside re-reads the listing', async () => {
    vi.mocked(readArchiveDir).mockResolvedValueOnce({ path: ZIP, entries: [] });
    const tab = new TabState();
    await tab.navigate(archiveLocation(ZIP));
    vi.mocked(readArchiveDir).mockResolvedValueOnce({ path: ZIP, entries: [row('b', false)] });
    await tab.refresh();
    expect(tab.entries.map((e) => e.name)).toEqual(['b']);
  });
});

describe('TabState.setView (the layout is per folder too, plan 15 G.53)', () => {
  it('set in A, B keeps the default, back to A restores', () => {
    settings.folderViews = [];
    settings.view = 'details';
    settings.iconSize = 48;
    const tab = new TabState();
    tab.location = pathLocation('E:\\A');
    tab.setView('grid', 256);
    expect([tab.view, tab.iconSize]).toEqual(['grid', 256]);
    tab.location = pathLocation('E:\\B');
    expect([tab.view, tab.iconSize]).toEqual(['details', 48]);
    tab.location = pathLocation('E:\\A');
    expect([tab.view, tab.iconSize]).toEqual(['grid', 256]);
    // the global default is untouched
    expect([settings.view, settings.iconSize]).toEqual(['details', 48]);
    settings.folderViews = [];
  });

  it('a layout change keeps the folder sort, and a sort change keeps the layout', () => {
    settings.folderViews = [];
    const tab = new TabState();
    tab.location = pathLocation('E:\\A');
    tab.sortBy('size');
    tab.setView('list');
    expect([tab.view, tab.sortKey]).toEqual(['list', 'size']);
    tab.sortTo('name');
    expect([tab.view, tab.sortKey]).toEqual(['list', 'name']);
    settings.folderViews = [];
  });

  it('a place has no folder, so its choice lands on the global default', () => {
    settings.folderViews = [];
    settings.view = 'details';
    const tab = new TabState();
    tab.location = HOME;
    tab.setView('list');
    expect(settings.view).toBe('list');
    expect(settings.folderViews).toEqual([]);
    settings.view = 'details';
  });
});

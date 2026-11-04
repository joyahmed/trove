import { describe, expect, it } from 'vitest';
import {
  MAX_FOLDER_VIEWS,
  applyFolderViewToSubfolders,
  isBelow,
  nearestFolderView,
  effectiveFolderView,
  findFolderView,
  isDownloadsFolder,
  rememberFolderView,
  sanitizeFolderViews,
  type FolderLayout,
  type FolderView,
  type FolderViewState,
} from './folder-views';

const DOWNLOADS = 'C:\\Users\\alex\\Downloads';
/** Joy's global settings as they actually are: sorted newest-first, grouped by nothing. */
const GLOBAL: FolderViewState & FolderLayout = {
  groupKey: null,
  sortKey: 'modifiedMs',
  sortDir: 'desc',
  view: 'details',
  iconSize: 48,
};

const view = (path: string, over: Partial<FolderView> = {}): FolderView => ({
  path,
  groupKey: GLOBAL.groupKey,
  sortKey: GLOBAL.sortKey,
  sortDir: GLOBAL.sortDir,
  view: null,
  iconSize: null,
  ...over,
});

describe('isDownloadsFolder', () => {
  it('is the known folder, by its path — not by anything called "Downloads"', () => {
    expect(isDownloadsFolder(DOWNLOADS, DOWNLOADS)).toBe(true);
    // the same folder spelled any of the ways it reaches us
    expect(isDownloadsFolder('c:\\users\\alex\\downloads\\', DOWNLOADS)).toBe(true);
    expect(isDownloadsFolder('C:/Users/alex/Downloads', DOWNLOADS)).toBe(true);
    // ⭐ a folder of your own that happens to be named Downloads is NOT the Downloads folder
    expect(isDownloadsFolder('E:\\Downloads', DOWNLOADS)).toBe(false);
    expect(isDownloadsFolder('C:\\Users\\alex\\Downloads\\old', DOWNLOADS)).toBe(false);
    // a Downloads folder that has been moved still is the Downloads folder
    expect(isDownloadsFolder('E:\\Downloads', 'E:\\Downloads')).toBe(true);
    // the known-folder list has not landed yet, or the OS call failed
    expect(isDownloadsFolder(DOWNLOADS, null)).toBe(false);
    // a place (Home, This PC) is no folder at all
    expect(isDownloadsFolder('', null)).toBe(false);
    expect(isDownloadsFolder('', '')).toBe(false);
  });
});

describe('effectiveFolderView', () => {
  it('seeds Downloads with date grouping on its first visit, and nothing else', () => {
    expect(effectiveFolderView(DOWNLOADS, [], DOWNLOADS, GLOBAL)).toEqual({
      groupKey: 'modifiedMs',
      sortKey: 'modifiedMs',
      sortDir: 'desc',
      view: 'details',
      iconSize: 48,
    });
    // every other folder is exactly as ungrouped as it was before this feature existed
    expect(effectiveFolderView('E:\\Tainment', [], DOWNLOADS, GLOBAL)).toEqual(GLOBAL);
    expect(effectiveFolderView('E:\\Downloads', [], DOWNLOADS, GLOBAL)).toEqual(GLOBAL);
    expect(effectiveFolderView('', [], DOWNLOADS, GLOBAL)).toEqual(GLOBAL);
  });

  it('the seed is a default, not a policy: an entry always wins, including "off"', () => {
    const off = [view('c:\\users\\alex\\downloads', { groupKey: null })];
    expect(effectiveFolderView(DOWNLOADS, off, DOWNLOADS, GLOBAL).groupKey).toBeNull();
    const bySize = [view('c:\\users\\alex\\downloads', { groupKey: 'size' })];
    expect(effectiveFolderView(DOWNLOADS, bySize, DOWNLOADS, GLOBAL).groupKey).toBe('size');
  });

  it('a folder with its own view keeps it, sort and all; one without follows the globals', () => {
    const views = [view('e:\\tainment', { groupKey: 'ext', sortKey: 'name', sortDir: 'asc' })];
    expect(effectiveFolderView('E:\\Tainment', views, DOWNLOADS, GLOBAL)).toEqual({
      groupKey: 'ext',
      sortKey: 'name',
      sortDir: 'asc',
      view: 'details',
      iconSize: 48,
    });
    expect(effectiveFolderView('E:\\Softwares', views, DOWNLOADS, GLOBAL)).toEqual(GLOBAL);
  });

  it('follows the globals, so a change to them still reaches every folder that has no view', () => {
    const other: FolderViewState & FolderLayout = {
      groupKey: 'ext',
      sortKey: 'size',
      sortDir: 'asc',
      view: 'details',
      iconSize: 48,
    };
    expect(effectiveFolderView('E:\\Tainment', [], DOWNLOADS, other)).toEqual(other);
    // …and Downloads keeps the global sort, overriding only the grouping
    expect(effectiveFolderView(DOWNLOADS, [], DOWNLOADS, other)).toEqual({
      groupKey: 'modifiedMs',
      sortKey: 'size',
      sortDir: 'asc',
      view: 'details',
      iconSize: 48,
    });
  });
});

describe('rememberFolderView', () => {
  it('files the change under the folder, most-recently-changed first', () => {
    let views = rememberFolderView([], 'E:\\Tainment', { ...GLOBAL, groupKey: 'ext' });
    views = rememberFolderView(views, DOWNLOADS, { ...GLOBAL, groupKey: null });
    expect(views.map((v) => v.path)).toEqual(['c:\\users\\alex\\downloads', 'e:\\tainment']);
    expect(findFolderView(views, 'E:\\Tainment')?.groupKey).toBe('ext');
  });

  it('the same folder in a different case is one entry, not two', () => {
    let views = rememberFolderView([], 'C:\\Users\\alex\\Downloads', {
      ...GLOBAL,
      groupKey: 'ext',
    });
    views = rememberFolderView(views, 'c:\\users\\alex\\downloads\\', {
      ...GLOBAL,
      groupKey: 'size',
    });
    expect(views).toHaveLength(1);
    expect(views[0].groupKey).toBe('size');
    // and it is found by any spelling
    expect(findFolderView(views, 'C:/Users/alex/Downloads')?.groupKey).toBe('size');
    expect(findFolderView(views, 'C:\\Users\\alex\\Downloads\\')?.groupKey).toBe('size');
  });

  it('a place has no folder to remember anything under, and is left alone', () => {
    const views = [view('e:\\tainment')];
    expect(rememberFolderView(views, '', { ...GLOBAL, groupKey: 'ext' })).toBe(views);
  });

  it('caps the map and evicts the least-recently-changed, never the folder just changed', () => {
    let views: FolderView[] = [];
    for (let i = 0; i < MAX_FOLDER_VIEWS; i++) {
      views = rememberFolderView(views, `E:\\f${i}`, { ...GLOBAL, groupKey: 'ext' });
    }
    expect(views).toHaveLength(MAX_FOLDER_VIEWS);
    expect(findFolderView(views, 'E:\\f0')).not.toBeNull();

    views = rememberFolderView(views, 'E:\\one-too-many', { ...GLOBAL, groupKey: 'size' });

    expect(views).toHaveLength(MAX_FOLDER_VIEWS);
    // the folder you are standing in is at the head, so the cap can never drop it
    expect(views[0].path).toBe('e:\\one-too-many');
    expect(findFolderView(views, 'E:\\one-too-many')?.groupKey).toBe('size');
    // the oldest change is the one that went
    expect(findFolderView(views, 'E:\\f0')).toBeNull();
    expect(findFolderView(views, `E:\\f${MAX_FOLDER_VIEWS - 1}`)).not.toBeNull();
  });
});

describe('sanitizeFolderViews', () => {
  it('an old settings file with no map at all reads as no map', () => {
    expect(sanitizeFolderViews(undefined)).toEqual([]);
    expect(sanitizeFolderViews(null)).toEqual([]);
    expect(sanitizeFolderViews('nope')).toEqual([]);
    expect(sanitizeFolderViews({ 'C:\\a': 'name' })).toEqual([]);
  });

  it('checks every field, normalises the path, and drops what it cannot use', () => {
    expect(
      sanitizeFolderViews([
        { path: 'C:\\Users\\alex\\Downloads\\', groupKey: 'modifiedMs', sortKey: 'name' },
        // the Folder column belongs to search alone, so it cannot be a grouping: "(None)"
        {
          path: 'E:\\a',
          groupKey: 'path',
          sortKey: 'size',
          sortDir: 'desc',
          view: null,
          iconSize: null,
        },
        { path: 'E:\\b', groupKey: 'nonsense', sortKey: 'ext', sortDir: 'sideways' },
        // no usable sort: the three fields are one view, so the entry goes and the folder
        // falls back to the globals
        { path: 'E:\\c', groupKey: 'ext' },
        { path: 'E:\\d', groupKey: 'ext', sortKey: 'attic' },
        // not an entry at all
        { groupKey: 'ext', sortKey: 'name' },
        'C:\\e',
        null,
      ]),
    ).toEqual([
      {
        path: 'c:\\users\\alex\\downloads',
        groupKey: 'modifiedMs',
        sortKey: 'name',
        sortDir: 'asc',
        view: null,
        iconSize: null,
      },
      {
        path: 'e:\\a',
        groupKey: null,
        sortKey: 'size',
        sortDir: 'desc',
        view: null,
        iconSize: null,
      },
      { path: 'e:\\b', groupKey: null, sortKey: 'ext', sortDir: 'asc', view: null, iconSize: null },
    ]);
  });

  it('two spellings of one folder collapse to the newest, and the cap holds on load too', () => {
    expect(
      sanitizeFolderViews([
        { path: 'E:\\a', groupKey: 'ext', sortKey: 'name' },
        { path: 'e:\\A\\', groupKey: 'size', sortKey: 'size' },
      ]),
    ).toEqual([
      {
        path: 'e:\\a',
        groupKey: 'ext',
        sortKey: 'name',
        sortDir: 'asc',
        view: null,
        iconSize: null,
      },
    ]);

    const many = Array.from({ length: MAX_FOLDER_VIEWS + 40 }, (_, i) => ({
      path: `E:\\f${i}`,
      groupKey: 'ext',
      sortKey: 'name',
    }));
    const kept = sanitizeFolderViews(many);
    expect(kept).toHaveLength(MAX_FOLDER_VIEWS);
    expect(kept[0].path).toBe('e:\\f0');
  });
});

describe('per-folder layout (plan 15 G.53)', () => {
  const SORT = { groupKey: null, sortKey: 'name', sortDir: 'asc' } as const;

  it('a folder remembers its view and icon size; another folder keeps the default', () => {
    const views = rememberFolderView([], 'E:/Pics', { ...SORT, view: 'grid', iconSize: 256 });
    expect(effectiveFolderView('E:/Pics', views, null, GLOBAL)).toMatchObject({
      view: 'grid',
      iconSize: 256,
    });
    expect(effectiveFolderView('E:/Docs', views, null, GLOBAL)).toEqual(GLOBAL);
  });

  it('a sort change keeps the layout the folder already had', () => {
    const a = rememberFolderView([], 'E:/Pics', { ...SORT, view: 'list' });
    const b = rememberFolderView(a, 'E:/Pics', { ...SORT, sortDir: 'desc' });
    expect(findFolderView(b, 'E:/Pics')).toMatchObject({ view: 'list', sortDir: 'desc' });
  });

  it('a sort-only entry follows the global layout, even when that changes', () => {
    const views = rememberFolderView([], 'E:/Pics', SORT);
    const moved = { ...GLOBAL, view: 'list' as const, iconSize: 96 as const };
    expect(effectiveFolderView('E:/Pics', views, null, moved)).toMatchObject({
      view: 'list',
      iconSize: 96,
    });
  });

  it('sanitize drops a bad view or size to null, never to a made-up value', () => {
    const out = sanitizeFolderViews([
      { path: 'E:/a', sortKey: 'name', view: 'grid', iconSize: 96 },
      { path: 'E:/b', sortKey: 'name', view: 'filmstrip', iconSize: 12 },
      { path: 'E:/c', sortKey: 'name' },
      { path: 'E:/d', sortKey: 'name', view: 'tiles' },
      { path: 'E:/e', sortKey: 'name', view: 'content' },
      { path: 'E:/f', sortKey: 'name', view: 'small' },
    ]);
    expect(out.map((v) => [v.view, v.iconSize])).toEqual([
      ['grid', 96],
      [null, null],
      [null, null],
      ['tiles', null],
      ['content', null],
      ['small', null],
    ]);
  });
});

describe('inherited folder views (plan 08 F4)', () => {
  const grouped = (path: string) => view(path, { groupKey: 'modifiedMs', view: 'tiles' });

  it('a subfolder with no view of its own follows its ancestor', () => {
    const views = [grouped('c:\\work')];
    const got = effectiveFolderView('C:\\Work\\a\\b', views, null, GLOBAL);
    expect(got.groupKey).toBe('modifiedMs');
    expect(got.view).toBe('tiles');
    expect(effectiveFolderView('C:\\Other', views, null, GLOBAL)).toEqual(GLOBAL);
  });

  it('the nearest ancestor wins, and a folder own entry wins over both', () => {
    const views = [
      view('c:\\work', { view: 'grid' }),
      view('c:\\work\\a', { view: 'list' }),
      view('c:\\work\\a\\b', { view: 'tiles' }),
    ];
    expect(effectiveFolderView('C:\\Work\\a\\b\\c', views, null, GLOBAL).view).toBe('tiles');
    expect(effectiveFolderView('C:\\Work\\a\\x', views, null, GLOBAL).view).toBe('list');
    expect(effectiveFolderView('C:\\Work\\z', views, null, GLOBAL).view).toBe('grid');
    expect(effectiveFolderView('C:\\Work\\a', views, null, GLOBAL).view).toBe('list');
  });

  it('a name that only starts the same is not an ancestor', () => {
    const views = [grouped('c:\\work')];
    expect(effectiveFolderView('C:\\Workshop\\a', views, null, GLOBAL)).toEqual(GLOBAL);
  });

  it('an ancestor entry beats the Downloads seed, the seed beats nothing', () => {
    const views = [view('c:\\users\\alex', { groupKey: null })];
    expect(effectiveFolderView(DOWNLOADS, views, DOWNLOADS, GLOBAL).groupKey).toBeNull();
    expect(effectiveFolderView(DOWNLOADS, [], DOWNLOADS, GLOBAL).groupKey).toBe('modifiedMs');
  });

  it('a drive root entry is inherited by everything on that drive', () => {
    const views = [grouped('c:\\')];
    expect(effectiveFolderView('C:\\a\\b', views, null, GLOBAL).view).toBe('tiles');
    expect(effectiveFolderView('D:\\a', views, null, GLOBAL).view).toBe('details');
  });

  it('works for WSL paths (case kept)', () => {
    const root = '\\\\wsl.localhost\\Ubuntu\\home\\alex';
    const views = [grouped(root)];
    expect(effectiveFolderView(root + '\\proj\\src', views, null, GLOBAL).view).toBe('tiles');
    expect(effectiveFolderView('\\\\wsl.localhost\\Ubuntu\\etc', views, null, GLOBAL).view).toBe(
      'details',
    );
  });

  const MAC = { os: 'macos' } as never;
  const LIN = { os: 'linux' } as never;
  it('POSIX paths: case-sensitive, / and /Users/x chains', () => {
    for (const p of [MAC, LIN]) {
      const views = [grouped('/Users/Alex')];
      expect(nearestFolderView(views, '/Users/Alex/a/b', p)?.path).toBe('/Users/Alex');
      expect(nearestFolderView(views, '/users/alex/a', p)).toBeNull();
      expect(nearestFolderView([grouped('/')], '/tmp/x', p)?.path).toBe('/');
      expect(nearestFolderView(views, '/Users/Alexa', p)).toBeNull();
      expect(isBelow('/a/b/c', '/a/b/', p)).toBe(true);
      expect(isBelow('/a/b', '/a/b', p)).toBe(false);
    }
  });

  it('Windows isBelow ignores slash direction and case', () => {
    expect(isBelow('c:/Work/A/b', 'C:\\work')).toBe(true);
    expect(isBelow('C:\\work', 'C:\\work')).toBe(false);
    expect(isBelow('C:\\workx', 'C:\\work')).toBe(false);
  });

  it('apply to subfolders files the view and clears descendants, nothing else', () => {
    const views = [
      view('c:\\work\\a', { view: 'list' }),
      view('c:\\work\\a\\deep', { view: 'grid' }),
      view('c:\\work', { view: 'grid' }),
      view('c:\\other', { view: 'tiles' }),
      view('c:\\workshop', { view: 'tiles' }),
    ];
    const out = applyFolderViewToSubfolders(views, 'C:\\Work', {
      groupKey: 'modifiedMs',
      sortKey: 'name',
      sortDir: 'asc',
      view: 'content',
      iconSize: 96,
    });
    expect(out.map((v) => v.path)).toEqual(['c:\\work', 'c:\\other', 'c:\\workshop']);
    expect(out[0]).toMatchObject({ view: 'content', iconSize: 96, groupKey: 'modifiedMs' });
    expect(effectiveFolderView('C:\\Work\\a\\deep', out, null, GLOBAL).view).toBe('content');
    expect(applyFolderViewToSubfolders(views, '', GLOBAL).length).toBe(views.length);
  });

  it('old saved data (no new fields) loads unchanged and now inherits', () => {
    const old = [{ path: 'C:\\Old\\', groupKey: 'size', sortKey: 'name', sortDir: 'desc' }];
    const loaded = sanitizeFolderViews(old);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ path: 'c:\\old', view: null, iconSize: null });
    expect(effectiveFolderView('C:\\Old\\sub', loaded, null, GLOBAL)).toMatchObject({
      groupKey: 'size',
      sortDir: 'desc',
      view: 'details',
    });
  });
});

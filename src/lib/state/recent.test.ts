import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recentFiles } from '$lib/api/recent';
import { places } from './places.svelte';
import { MAX_RECENT_FOLDERS, recent } from './recent.svelte';
import { settings } from './settings.svelte';

vi.mock('$lib/api/recent', () => ({ recentFiles: vi.fn(async () => []) }));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  oneDriveRoot: vi.fn(async () => null),
}));

const file = (path: string) => ({
  name: path.slice(path.lastIndexOf('\\') + 1),
  path,
  isDir: false,
  size: 1,
  modifiedMs: 1,
  createdMs: 1,
  ext: 'txt',
  isHidden: false,
  iconKey: 'ext/txt',
  typeName: 'Text Document',
});

describe('recent folders', () => {
  beforeEach(() => {
    settings.recentFolders = [];
    settings.pins = [];
    places.knownFolders = [];
  });

  it('moves a visited folder to the front, dedupes by case and caps the list', () => {
    recent.visited('D:\\a');
    recent.visited('D:\\b');
    recent.visited('d:\\A');
    expect(settings.recentFolders).toEqual(['d:\\A', 'D:\\b']);
    recent.visited('');
    expect(settings.recentFolders).toEqual(['d:\\A', 'D:\\b']);
    for (let i = 0; i < MAX_RECENT_FOLDERS + 3; i++) recent.visited(`C:\\f${i}`);
    expect(settings.recentFolders).toHaveLength(MAX_RECENT_FOLDERS);
    expect(settings.recentFolders[0]).toBe(`C:\\f${MAX_RECENT_FOLDERS + 2}`);
  });

  it('leaves pinned and known folders out of the listed recents', () => {
    recent.visited('C:\\Users\\alex\\Documents');
    recent.visited('D:\\pinned');
    recent.visited('E:\\plain');
    settings.pins = ['d:\\PINNED'];
    places.knownFolders = [
      { key: 'documents', label: 'Documents', path: 'C:\\Users\\alex\\Documents' },
    ];
    expect(recent.folders).toEqual(['E:\\plain']);
    recent.forget('E:\\plain');
    expect(recent.folders).toEqual([]);
  });

  it('forget leaves the list untouched for a folder that is not in it', () => {
    const list = ['C:\\a', 'C:\\b'];
    settings.recentFolders = list;
    recent.forget('C:\\elsewhere');
    expect(settings.recentFolders).toBe(list);
    recent.forget('c:\\A');
    expect(settings.recentFolders).toEqual(['C:\\b']);
    settings.recentFolders = [];
  });

  it('on Linux hides a drive spelled with a trailing slash, keeps another-cased folder', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' } });
    try {
      places.drives = [{ path: '/media/alex/USB', label: 'USB', totalBytes: 0, freeBytes: 0 }];
      settings.recentFolders = ['/media/alex/USB/', '/media/alex/usb'];
      expect(recent.folders).toEqual(['/media/alex/usb']);
      // and visiting dedupes by exact path: `/home/Alex` and `/home/alex` are two folders
      recent.visited('/home/Alex');
      recent.visited('/home/alex');
      expect(settings.recentFolders.slice(0, 2)).toEqual(['/home/alex', '/home/Alex']);
    } finally {
      places.drives = [];
      vi.unstubAllGlobals();
    }
  });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('recent files', () => {
  // Home re-fetches on every tab switch back to it and on F5, and resolving Windows' Recent
  // shortcuts is slow enough that two fetches overlap. The older one must not answer last.
  it('a fetch overtaken by a newer one writes nothing', async () => {
    vi.mocked(recentFiles).mockImplementationOnce(async () => {
      await delay(20);
      return [file('C:\\x\\older.txt')];
    });
    vi.mocked(recentFiles).mockImplementationOnce(async () => [file('C:\\x\\newer.txt')]);
    const first = recent.loadFiles();
    const second = recent.loadFiles();
    await Promise.all([first, second]);
    expect(recent.files.map((f) => f.name)).toEqual(['newer.txt']);
  });

  it('an overtaken failure does not empty the list the live fetch just filled', async () => {
    vi.mocked(recentFiles).mockImplementationOnce(async () => {
      await delay(20);
      throw new Error('no shortcuts');
    });
    vi.mocked(recentFiles).mockImplementationOnce(async () => [file('C:\\x\\newer.txt')]);
    const first = recent.loadFiles();
    const second = recent.loadFiles();
    await Promise.all([first, second]);
    expect(recent.files.map((f) => f.name)).toEqual(['newer.txt']);
    expect(recent.loading).toBe(false);
  });

  it('loads from the OS and keeps an empty list on failure', async () => {
    vi.mocked(recentFiles).mockResolvedValueOnce([file('C:\\x\\notes.txt')]);
    await recent.loadFiles();
    expect(recent.files.map((f) => f.name)).toEqual(['notes.txt']);
    expect(recent.loading).toBe(false);
    vi.mocked(recentFiles).mockRejectedValueOnce(new Error('no'));
    await recent.loadFiles();
    expect(recent.files).toEqual([]);
  });
});

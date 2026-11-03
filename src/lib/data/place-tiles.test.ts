import { afterEach, describe, expect, it, vi } from 'vitest';
import { places } from '$lib/state/places.svelte';
import { recent } from '$lib/state/recent.svelte';
import { settings } from '$lib/state/settings.svelte';
import { driveTile, pinTile, placeSections, placeTileCount } from './place-tiles';

vi.mock('$lib/api/recent', () => ({ recentFiles: vi.fn(async () => []) }));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  oneDriveRoot: vi.fn(async () => null),
}));

const GB = 1024 ** 3;
const drive = (label: string, totalBytes: number | null, freeBytes: number | null) => ({
  path: 'C:\\',
  label,
  totalBytes,
  freeBytes,
});

describe('driveTile', () => {
  it('labels the drive as Explorer does and measures what is used', () => {
    const t = driveTile(drive('Local Disk', 237 * GB, 45.3 * GB));
    expect(t.kind).toBe('drive');
    expect(t.path).toBe('C:\\');
    expect(t.key).toBe('C:\\');
    if (t.kind !== 'drive') return;
    expect(t.label).toBe('Local Disk (C:)');
    expect(t.usedFraction).toBeCloseTo(1 - 45.3 / 237, 5);
    expect(t.caption).toBe('45.3 GB free of 237 GB');
    expect(t.critical).toBe(false);
  });

  it('turns critical at 90 % used', () => {
    const t = driveTile(drive('Data', 100 * GB, 10 * GB));
    if (t.kind !== 'drive') throw new Error('not a drive tile');
    expect(t.usedFraction).toBeCloseTo(0.9, 5);
    expect(t.critical).toBe(true);
    const ok = driveTile(drive('Data', 100 * GB, 11 * GB));
    if (ok.kind !== 'drive') throw new Error('not a drive tile');
    expect(ok.critical).toBe(false);
  });

  it('an unknown size has no bar and no caption, never "0 B free of 0 B"', () => {
    for (const t of [driveTile(drive('Gone', null, null)), driveTile(drive('Empty', 0, 0))]) {
      if (t.kind !== 'drive') throw new Error('not a drive tile');
      expect(t.usedFraction).toBeNull();
      expect(t.critical).toBe(false);
      expect(t.caption).toBeNull();
    }
  });
});

describe('pinTile', () => {
  it('is a yellow folder named after the last segment', () => {
    const t = pinTile('D:\\work\\repo');
    expect(t).toMatchObject({ kind: 'folder', key: 'pin:D:\\work\\repo', label: 'repo' });
  });
});

describe('Home', () => {
  it('has Quick access (pins), then Recent: visited folders first, then recent files', () => {
    settings.pins = ['D:\\pinned'];
    settings.recentFolders = ['D:\\pinned', 'E:\\visited'];
    recent.files = [
      {
        name: 'notes.txt',
        path: 'C:\\x\\notes.txt',
        isDir: false,
        size: 1,
        modifiedMs: 1,
        createdMs: 1,
        ext: 'txt',
        isHidden: false,
        iconKey: 'ext/txt',
        typeName: 'Text Document',
      },
    ];
    const [quick, recentSection] = placeSections.home;
    expect(quick.tiles().map((t) => t.key)).toEqual(['pin:D:\\pinned']);
    expect(recentSection.title).toBe('Recent');
    expect(recentSection.tiles().map((t) => t.key)).toEqual([
      'rec:E:\\visited',
      'file:C:\\x\\notes.txt',
    ]);
    expect(placeTileCount('home')).toBe(3);
  });

  it('Recent is not empty where the OS has no recent files (a Mac), when Trove visited folders', () => {
    // Mac: Home said "Recent (0)" while the palette listed "Folder X" under RECENT
    settings.pins = [];
    places.knownFolders = [];
    settings.recentFolders = ['/Users/alex/Folder X'];
    recent.files = [];
    const recentSection = placeSections.home.find((s) => s.key === 'recent')!;
    expect(recentSection.tiles().map((t) => t.key)).toEqual(['rec:/Users/alex/Folder X']);
    settings.recentFolders = [];
  });

  it('keeps drive roots out of Recent, on Windows and Linux spellings', () => {
    settings.pins = [];
    places.knownFolders = [];
    places.drives = [
      { path: '/', label: 'root', totalBytes: 0, freeBytes: 0 },
      { path: '/media/alex/DATADRIVE', label: 'DATADRIVE', totalBytes: 0, freeBytes: 0 },
    ];
    settings.recentFolders = ['/', '/media/alex/DATADRIVE', 'G:', 'C:\\', '/home/alex/src'];
    const [, recentSection] = placeSections.home;
    expect(recentSection.tiles().map((t) => t.key)).toEqual(['rec:/home/alex/src']);
    // the history itself is untouched
    expect(settings.recentFolders).toHaveLength(5);
    places.drives = [];
    settings.recentFolders = [];
  });

  it('keeps a mount-like folder that is not a drive, and drops "/" before drives arrive', () => {
    settings.pins = [];
    places.knownFolders = [];
    places.drives = [];
    settings.recentFolders = ['/', '/mnt/data'];
    const [, recentSection] = placeSections.home;
    expect(recentSection.tiles().map((t) => t.key)).toEqual(['rec:/mnt/data']);
    settings.recentFolders = [];
  });

  it("an unpinned built-in leaves Home's Quick access but stays under This PC", () => {
    places.knownFolders = [
      { key: 'desktop', label: 'Desktop', path: 'C:\\Users\\alex\\Desktop' },
      { key: 'downloads', label: 'Downloads', path: 'C:\\Users\\alex\\Downloads' },
    ];
    settings.pins = [];
    settings.recentFolders = [];
    recent.files = [];
    settings.hiddenKnownFolders = ['downloads'];
    const [quick] = placeSections.home;
    expect(quick.tiles().map((t) => t.key)).toEqual(['desktop']);
    const [folders] = placeSections['this-pc'];
    expect(folders.tiles().map((t) => t.key)).toEqual(['desktop', 'downloads']);
    settings.hiddenKnownFolders = [];
    places.knownFolders = [];
  });
});

describe('driveTile off Windows', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('has no letter tag: the label, or the mount path with no label', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'macos', thisPcLabel: 'This Mac' } });
    const mac = { ...drive('Macintosh HD', GB, GB), path: '/' };
    const labelOf = (d: ReturnType<typeof drive>) => {
      const t = driveTile(d);
      if (t.kind !== 'drive') throw new Error('not a drive tile');
      return t.label;
    };
    expect(labelOf(mac)).toBe('Macintosh HD');
    expect(labelOf({ ...drive('', GB, GB), path: '/Volumes/USB' })).toBe('/Volumes/USB');
    expect(labelOf({ ...drive('V', GB, GB), path: '/V' })).toBe('V');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRIVES_KEY,
  QUICK_ACCESS_KEY,
  driveName,
  driveUsage,
  isExpanded,
  networkItems,
  oneDriveRows,
  sidebarSections,
} from './sidebar-sections';
import { places } from '$lib/state/places.svelte';
import { THIS_PC } from '$lib/utils/location';
import { settings } from '$lib/state/settings.svelte';
import { wsl } from '$lib/state/wsl.svelte';
import { network } from '$lib/state/network.svelte';

vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));
vi.mock('$lib/api/wsl', () => ({
  wslDistros: vi.fn(async () => []),
  wslHome: vi.fn(async () => ''),
  wslRunningDistros: vi.fn(async () => []),
}));

const section = (key: string) => sidebarSections.find((s) => s.key === key)!;

describe('sidebar sections', () => {
  beforeEach(() => {
    places.drives = [
      { path: 'C:\\', label: 'OS', totalBytes: 10, freeBytes: 5 },
      { path: 'D:\\', label: 'CODE', totalBytes: 10, freeBytes: 5 },
    ];
    places.oneDriveRoot = null;
    settings.sidebarCollapsed = [];
    settings.hiddenSidebarKeys = [];
  });

  it('runs Pinned, Drives, the Gallery/Bin group, Network, Linux — in that order', () => {
    expect(sidebarSections.map((s) => s.key)).toEqual([
      QUICK_ACCESS_KEY,
      DRIVES_KEY,
      'system',
      'network',
      'linux',
    ]);
    expect(section(QUICK_ACCESS_KEY).title).toBe('Pinned');
    expect(section(QUICK_ACCESS_KEY).keepWhenEmpty).toBe(true);
    expect(section('system').title).toBeUndefined();
    expect(sidebarSections.some((x) => x.key === 'top')).toBe(false);
  });

  it('Drives is a flat section of the drives whose header opens This PC; Network is not listed', () => {
    const drives = section(DRIVES_KEY);
    expect(drives.title).toBe('Drives');
    expect(drives.location).toEqual(THIS_PC);
    expect(drives.items().map((i) => i.key)).toEqual(['C:\\', 'D:\\']);
    expect(drives.items().some((i) => i.children)).toBe(false);
    const system = section('system').items();
    expect(system.map((i) => i.key)).toEqual([
      'gallery',
      'applications',
      'onedrive',
      'recycle-bin',
    ]);
    expect(system[3].location).toEqual({ kind: 'recycle-bin' });
    expect(sidebarSections.flatMap((s) => s.items()).some((i) => i.key === 'network')).toBe(false);
  });

  it('Linux is titled and has no rows without distros, so the sidebar skips it', () => {
    wsl.distros = [];
    const linux = section('linux');
    expect(linux.title).toBe('Linux');
    expect(linux.items()).toEqual([]);
    expect(linux.keepWhenEmpty).toBeUndefined();
  });

  it('a running distro carries the running mark, a stopped one does not', () => {
    wsl.distros = [
      { name: 'Ubuntu', isDefault: true, uid: 1000 },
      { name: 'Debian', isDefault: false, uid: 1000 },
    ];
    wsl.running = ['Ubuntu'];
    const rows = section('linux').items();
    expect(rows.map((r) => [r.label, r.running])).toEqual([
      ['Ubuntu', true],
      ['Debian', false],
    ]);
    wsl.distros = [];
    wsl.running = [];
  });

  it('Home is the first Pinned row, with the pinned flag; the Bin and Gallery are not pinned rows', () => {
    places.knownFolders = [{ key: 'desktop', label: 'Desktop', path: 'C:\\Users\\alex\\Desktop' }];
    settings.pins = [];
    const pinned = section(QUICK_ACCESS_KEY).items();
    expect(pinned.map((i) => i.key)).toEqual(['home', 'desktop']);
    expect(pinned[0]).toMatchObject({ glyph: 'home', pinned: true, location: { kind: 'home' } });
    expect(
      section('system')
        .items()
        .some((i) => i.pinned),
    ).toBe(false);
  });

  it('an unpinned Home or Recycle Bin leaves the sidebar, and restore brings it back', () => {
    const pinned = () =>
      section(QUICK_ACCESS_KEY)
        .items()
        .map((i) => i.key);
    settings.toggleSidebarKey('home');
    settings.toggleSidebarKey('recycle-bin');
    expect(pinned()).not.toContain('home');
    expect(
      section('system')
        .items()
        .map((i) => i.key),
    ).toEqual(['gallery', 'applications', 'onedrive']);
    settings.restoreSidebarDefaults();
    expect(pinned()).toContain('home');
    expect(section('system').items()).toHaveLength(4);
  });

  it('a pinned WSL folder carries the WSL tag; a Windows one does not', () => {
    places.knownFolders = [];
    settings.pins = [String.raw`\\wsl.localhost\Ubuntu\home\alex`, 'D:\\work'];
    const [, linux, win] = section(QUICK_ACCESS_KEY).items();
    expect(linux.tag).toBe('WSL');
    expect(win.tag).toBeUndefined();
    settings.pins = [];
  });

  it('a pinned drive root reads as the Drives row does, not as its path', () => {
    places.knownFolders = [];
    places.drives = [
      { path: 'C:\\', label: 'OS', totalBytes: 10, freeBytes: 5 },
      { path: '/', label: 'Macintosh HD', totalBytes: 10, freeBytes: 5 },
    ];
    settings.pins = ['C:\\', '/', '/Volumes/Gone', 'D:\\work'];
    const [, win, mac, gone, plain] = section(QUICK_ACCESS_KEY).items();
    expect([win.label, win.tag]).toEqual(['OS', 'C:']);
    expect([mac.label, mac.tag]).toEqual(['Macintosh HD', undefined]);
    expect(gone.label).toBe('Gone');
    expect(plain.label).toBe('work');
    settings.pins = [];
  });

  it('an unnamed root still gets a name, and an empty pin is not a row', () => {
    places.knownFolders = [];
    places.drives = [{ path: '/', label: '', totalBytes: 10, freeBytes: 5 }];
    settings.pins = ['/', ''];
    const rows = section(QUICK_ACCESS_KEY).items();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.label.trim() !== '')).toBe(true);
    settings.pins = [];
  });

  it('OneDrive is disabled until the OS gives a root, then it navigates there', () => {
    const before = section('system')
      .items()
      .find((i) => i.key === 'onedrive')!;
    expect(before.location).toBeUndefined();
    places.oneDriveRoot = 'C:\\Users\\alex\\OneDrive';
    const after = section('system')
      .items()
      .find((i) => i.key === 'onedrive')!;
    expect(after.location).toEqual({ kind: 'path', path: 'C:\\Users\\alex\\OneDrive' });
    expect(after.expandable).toBeUndefined();
  });

  it('an unpinned built-in leaves Pinned and carries its key for the menu', () => {
    places.knownFolders = [
      { key: 'desktop', label: 'Desktop', path: 'C:\\Users\\alex\\Desktop' },
      { key: 'downloads', label: 'Downloads', path: 'C:\\Users\\alex\\Downloads' },
    ];
    settings.hiddenKnownFolders = [];
    settings.pins = [];
    settings.recentFolders = [];
    const before = section(QUICK_ACCESS_KEY).items();
    expect(before.map((i) => i.key)).toEqual(['home', 'desktop', 'downloads']);
    expect(before[2].knownKey).toBe('downloads');
    settings.toggleKnownFolder('downloads');
    expect(
      section(QUICK_ACCESS_KEY)
        .items()
        .map((i) => i.key),
    ).toEqual(['home', 'desktop']);
    settings.hiddenKnownFolders = [];
  });

  it('Gallery navigates to the gallery place', () => {
    const gallery = section('system')
      .items()
      .find((i) => i.key === 'gallery')!;
    expect(gallery.location).toEqual({ kind: 'gallery' });
  });

  it('Applications sits right after Gallery and opens the applications place, on all three OSes', () => {
    for (const os of ['windows', 'macos', 'linux']) {
      vi.stubGlobal('window', { __TROVE_PLATFORM__: { os, thisPcLabel: 'This PC' } });
      const keys = section('system')
        .items()
        .map((i) => i.key);
      expect(keys.indexOf('applications'), os).toBe(keys.indexOf('gallery') + 1);
      const row = section('system')
        .items()
        .find((i) => i.key === 'applications')!;
      expect(row).toMatchObject({
        label: 'Applications',
        glyph: 'fileApp',
        location: { kind: 'applications' },
      });
      // a place has no path, so the row is never a drop target (SidebarItem's data-drop)
      expect(row.location?.kind).not.toBe('path');
    }
    vi.unstubAllGlobals();
  });

  it('an unpinned Applications row leaves the sidebar, and Show brings it back', () => {
    const keys = () =>
      section('system')
        .items()
        .map((i) => i.key);
    settings.toggleSidebarKey('applications');
    expect(settings.hiddenSidebarKeys).toEqual(['applications']);
    expect(keys()).not.toContain('applications');
    settings.toggleSidebarKey('applications');
    expect(keys()).toContain('applications');
  });

  it('collapse state persists per key through settings', () => {
    expect(isExpanded(DRIVES_KEY)).toBe(true);
    settings.toggleCollapsed(DRIVES_KEY);
    expect(isExpanded(DRIVES_KEY)).toBe(false);
    expect(isExpanded(QUICK_ACCESS_KEY)).toBe(true);
    settings.toggleCollapsed(DRIVES_KEY);
    expect(settings.sidebarCollapsed).toEqual([]);
  });
});

describe('driveName', () => {
  it('is the volume name with the drive letter as a tag on Windows', () => {
    expect(driveName('Data', 'G:\\')).toEqual({ label: 'Data', tag: 'G:' });
    expect(driveName('Data', 'g:/')).toEqual({ label: 'Data', tag: 'G:' });
    expect(driveName('OS', 'C:')).toEqual({ label: 'OS', tag: 'C:' });
  });

  it('is the letter alone for an unnamed Windows volume, never an empty label', () => {
    expect(driveName('', 'X:\\')).toEqual({ label: 'X:' });
    expect(driveName('  ', 'x:')).toEqual({ label: 'X:' });
  });

  it('is the volume name alone for a mount point, never its first two characters', () => {
    // ⛔ seen on a real Ubuntu desktop: `DATADRIVE (/m)`
    expect(driveName('DATADRIVE', '/media/DATADRIVE')).toEqual({ label: 'DATADRIVE' });
    expect(driveName('File System', '/')).toEqual({ label: 'File System' });
    expect(driveName('Backup', '/Volumes/Backup')).toEqual({ label: 'Backup' });
  });
});

describe('oneDriveRows', () => {
  it('shows OneDrive when a root is found, on any OS', () => {
    expect(oneDriveRows(String.raw`C:\Users\alex\OneDrive`, true)).toHaveLength(1);
    expect(oneDriveRows('/Users/alex/Library/CloudStorage/OneDrive', false)).toHaveLength(1);
  });

  it('keeps the placeholder on Windows when none is set up, and hides it elsewhere', () => {
    expect(oneDriveRows(null, true)).toHaveLength(1);
    expect(oneDriveRows(null, false)).toEqual([]);
  });

  it('adds a sync-state glyph only when the root has a known sync state', () => {
    const root = String.raw`C:\Users\alex\OneDrive`;
    expect(oneDriveRows(root, true)[0].status).toBeUndefined();
    expect(oneDriveRows(root, true, 'syncing')[0].status).toMatchObject({
      glyph: 'refresh',
      label: 'Syncing',
    });
    expect(oneDriveRows(root, true, 'error')[0].status?.color).toBe('var(--color-critical)');
    expect(oneDriveRows(null, true, 'syncing')[0].status).toBeUndefined();
  });
});

describe('driveUsage', () => {
  it('is absent when the OS would not say, or the total is 0', () => {
    expect(driveUsage(null, 5)).toBeUndefined();
    expect(driveUsage(10, null)).toBeUndefined();
    expect(driveUsage(0, 0)).toBeUndefined();
  });

  it('gives the used fraction and a free-of-total caption', () => {
    const u = driveUsage(1024 ** 3 * 100, 1024 ** 3 * 25)!;
    expect(u.fraction).toBeCloseTo(0.75);
    expect(u.caption).toBe('25.0 GB free of 100 GB');
    expect(u.level).toBe('ok');
  });

  it('turns amber at 80% used and red at 90%, the Places tiles line', () => {
    expect(driveUsage(100, 21)!.level).toBe('ok');
    expect(driveUsage(100, 20)!.level).toBe('low');
    expect(driveUsage(100, 11)!.level).toBe('low');
    expect(driveUsage(100, 10)!.level).toBe('critical');
    expect(driveUsage(100, 0)!.level).toBe('critical');
  });
});

describe('the Network group (5.3b, D3)', () => {
  // Backslashes are written as `/` and turned back, so no literal has to be read twice.
  const win = (text: string) => text.replaceAll('/', String.fromCharCode(92));
  beforeEach(() => {
    places.drives = [{ path: win('Z:/'), label: 'media', totalBytes: null, freeBytes: null }];
    network.mapped = [win('Z:/')];
    settings.recentFolders = [
      win('//nas/media/film'),
      win('C:/Users'),
      win('//NAS/media'),
      win('//wsl.localhost/Ubuntu/home'),
      win('//backup/old/2024'),
    ];
  });

  it('lists mapped letters, then each visited share root once, no WSL, no local folder', () => {
    const rows = networkItems();
    expect(rows.map((r) => [r.label, r.tag])).toEqual([
      ['media', 'Z:'],
      ['media', 'nas'],
      ['old', 'backup'],
    ]);
    expect(rows[1].location).toEqual({ kind: 'path', path: win('//nas/media') });
    expect(rows.every((r) => !r.unreachable)).toBe(true);
  });

  it('greys a place that missed its deadline and clears it when it answers', () => {
    network.failed(`${win('//backup/old')} did not answer in 10 s`);
    network.failed(`${win('Z:/')} did not answer in 10 s`);
    network.failed(`${win('//nas/media')}: Access is denied. (os error 5)`);
    const byKey = Object.fromEntries(networkItems().map((r) => [r.key, r.unreachable]));
    expect(byKey).toEqual({
      [`net:${win('Z:/')}`]: true,
      [`net:${win('//nas/media')}`]: false,
      [`net:${win('//backup/old')}`]: true,
    });
    expect(section(DRIVES_KEY).items()[0].unreachable).toBe(true);
    network.answered(win('//backup/old/2024'));
    network.answered(win('z:/x'));
    expect(networkItems().some((r) => r.unreachable)).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));
vi.mock('$lib/api/window', () => ({ openWindow: vi.fn(async () => {}) }));

import { sidebarMenuFor } from './sidebar-menu';
import { sidebarSections, type SidebarItem } from './sidebar-sections';
import { places } from '$lib/state/places.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';

const on = { openTerminal: vi.fn() };
const item = (key: string): SidebarItem => {
  const found = sidebarSections.flatMap((s) => s.items()).find((i) => i.key === key);
  if (!found) throw new Error(`no sidebar row ${key}`);
  return found;
};
const entry = (menu: MenuItem[], key: string) => {
  const e = menu.find((m) => m.key === key);
  if (!e || e.kind !== 'item') throw new Error(`no menu item ${key}`);
  return e;
};
const shows = (menu: MenuItem[], key: string) => entry(menu, key).visible?.() ?? true;

describe('the sidebar menu', () => {
  beforeEach(() => {
    places.drives = [{ path: 'C:\\', label: 'OS', totalBytes: 10, freeBytes: 5 }];
    places.knownFolders = [{ key: 'desktop', label: 'Desktop', path: 'C:\\Users\\alex\\Desktop' }];
    settings.pins = ['D:\\work'];
    settings.hiddenKnownFolders = [];
    settings.hiddenSidebarKeys = [];
  });

  it('offers Unpin on Home and the Recycle Bin, and Unpin hides them', () => {
    for (const key of ['home', 'recycle-bin'] as const) {
      const menu = sidebarMenuFor(item(key), on);
      expect(shows(menu, 'unpin')).toBe(true);
      expect(shows(menu, 'pin')).toBe(false);
      void entry(menu, 'unpin').run?.();
      expect(settings.isSidebarKeyHidden(key)).toBe(true);
    }
  });

  it('offers Unpin on a built-in folder and on a pin, with the sidebar wording', () => {
    const desktop = sidebarMenuFor(item('desktop'), on);
    expect(entry(desktop, 'unpin').label).toBe('Unpin from sidebar');
    expect(shows(desktop, 'unpin')).toBe(true);
    void entry(desktop, 'unpin').run?.();
    expect(settings.hiddenKnownFolders).toEqual(['desktop']);
    const pin = sidebarMenuFor(item('pin:D:\\work'), on);
    void entry(pin, 'unpin').run?.();
    expect(settings.pins).toEqual([]);
  });

  it('offers Pin on a drive, not Unpin', () => {
    const menu = sidebarMenuFor(item('C:\\'), on);
    expect(entry(menu, 'pin').label).toBe('Pin to sidebar');
    expect(shows(menu, 'pin')).toBe(true);
    expect(shows(menu, 'unpin')).toBe(false);
  });
});

// A Home / This PC tile's right-click menu IS the sidebar's place menu, for the row the tile
// stands for (the Mac, 2026-10-08: tiles had no menu at all).
import { readFileSync } from 'node:fs';
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

import { placeTileMenuFor, tileAsSidebarItem } from './place-tile-menu';
import { driveTile, fileTile, knownFolderTile, pinTile, recentFolderTile } from './place-tiles';
import { sidebarMenuFor } from './sidebar-menu';
import { sidebarSections } from './sidebar-sections';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import { places } from '$lib/state/places.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { FileEntry } from '$lib/types/fs';

const on = { openTerminal: vi.fn() };
const DESKTOP = { key: 'desktop' as const, label: 'Desktop', path: 'C:\\Users\\alex\\Desktop' };
const DRIVE = { path: 'C:\\', label: 'OS', totalBytes: 10, freeBytes: 5 };

/** The keys a menu shows right now (dividers and hidden items left out). */
const shown = (menu: MenuItem[]) =>
  menu.filter((m) => m.kind === 'item' && (m.visible?.() ?? true)).map((m) => m.key);
const entry = (menu: MenuItem[], key: string) => {
  const e = menu.find((m) => m.key === key);
  if (!e || e.kind !== 'item') throw new Error(`no menu item ${key}`);
  return e;
};
const sidebarRow = (key: string) => {
  const row = sidebarSections.flatMap((s) => s.items()).find((i) => i.key === key);
  if (!row) throw new Error(`no sidebar row ${key}`);
  return row;
};

describe('the Home / This PC tile menu', () => {
  beforeEach(() => {
    places.drives = [DRIVE];
    places.knownFolders = [DESKTOP];
    settings.pins = ['D:\\work'];
    settings.hiddenKnownFolders = [];
    on.openTerminal.mockClear();
  });

  it('a known-folder tile shows exactly what its sidebar row shows', () => {
    const tileMenu = placeTileMenuFor(knownFolderTile(DESKTOP), on);
    expect(shown(tileMenu)).toEqual(shown(sidebarMenuFor(sidebarRow('desktop'), on)));
    expect(shown(tileMenu)).toEqual(['open-tab', 'open-window', 'unpin', 'terminal']);
  });

  it('a pinned-folder tile and a drive tile match their sidebar rows too', () => {
    expect(shown(placeTileMenuFor(pinTile('D:\\work'), on))).toEqual(
      shown(sidebarMenuFor(sidebarRow('pin:D:\\work'), on)),
    );
    expect(shown(placeTileMenuFor(driveTile(DRIVE), on))).toEqual(
      shown(sidebarMenuFor(sidebarRow('C:\\'), on)),
    );
  });

  it('a recent folder offers Pin, and Pin pins it', () => {
    const menu = placeTileMenuFor(recentFolderTile('E:\\photos'), on);
    expect(shown(menu)).toEqual(['open-tab', 'open-window', 'pin', 'terminal']);
    void entry(menu, 'pin').run();
    expect(settings.pins).toContain('E:\\photos');
  });

  it('Unpin on a known-folder tile hides it; This PC still lists it and then offers Pin', () => {
    void entry(placeTileMenuFor(knownFolderTile(DESKTOP), on), 'unpin').run();
    expect(settings.isKnownFolderHidden('desktop')).toBe(true);
    const again = placeTileMenuFor(knownFolderTile(DESKTOP), on);
    expect(shown(again)).toContain('pin');
    void entry(again, 'pin').run();
    expect(settings.isKnownFolderHidden('desktop')).toBe(false);
  });

  it('Open in new tab opens the tile folder; Open in Terminal hands over its path', () => {
    const menu = placeTileMenuFor(knownFolderTile(DESKTOP), on);
    const before = tabs.list.length;
    void entry(menu, 'open-tab').run();
    expect(tabs.list.length).toBe(before + 1);
    void entry(menu, 'terminal').run();
    expect(on.openTerminal).toHaveBeenCalledWith(DESKTOP.path);
  });

  it('a recent FILE tile has no menu (the sidebar has no file rows)', () => {
    const file = fileTile({ path: 'C:\\a.txt', name: 'a.txt' } as FileEntry);
    expect(tileAsSidebarItem(file)).toBeNull();
    expect(placeTileMenuFor(file, on)).toEqual([]);
  });

  it('the place view wires the menu onto folder and drive tiles', () => {
    const src = readFileSync(
      new URL('../components/places/PlaceView.svelte', import.meta.url),
      'utf8',
    );
    expect(src.match(/oncontextmenu=\{\(e\) => view\.oncontextmenu\(tile, e\)\}/g)).toHaveLength(2);
    expect(src).toMatch(/<Menu menu=\{view\.menu\} items=\{view\.items\} \/>/);
  });
});

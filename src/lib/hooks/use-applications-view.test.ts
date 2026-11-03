import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEntry } from '$lib/types/palette';
import { comingFrom } from '$lib/state/coming-from.svelte';
import { clipboard } from '$lib/state/clipboard.svelte';

// ⛔ No test starts an app: both ways of starting one are mocks that only record the call.
const openPath = vi.fn<(path: string) => Promise<void>>(async () => {});
const launchApp = vi.fn<(aumid: string) => Promise<void>>(async () => {});
vi.mock('$lib/api/fs', async (orig) => ({
  ...(await orig<object>()),
  openPath: (p: string) => openPath(p),
}));
const clipboardWritePathsText = vi.fn<(paths: string[]) => Promise<void>>(async () => {});
vi.mock('$lib/api/clipboard', () => ({
  clipboardWritePaths: vi.fn(async () => {}),
  clipboardReadPaths: vi.fn(async () => null),
  clipboardWritePathsText: (p: string[]) => clipboardWritePathsText(p),
}));
vi.mock('$lib/api/palette', async (orig) => ({
  ...(await orig<object>()),
  launchApp: (id: string) => launchApp(id),
  spotlightApps: vi.fn(async () => []),
}));

import {
  appColumnsFor,
  appDiskPath,
  appKeyAction,
  applicationsMenuFor,
  copyAppPath,
  startApp,
} from './use-applications-view.svelte';

const winLnk: AppEntry = {
  name: 'Notepad++',
  lnkPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Notepad++.lnk',
  target: 'C:\\Program Files\\Notepad++\\notepad++.exe',
  aumid: '',
  openWith: { program: 'C:\\Program Files\\Notepad++\\notepad++.exe', args: '%paths%' },
  path: 'C:\\Program Files\\Notepad++\\notepad++.exe',
};
const storeApp: AppEntry = {
  name: 'Calculator',
  lnkPath: '',
  target: '',
  aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
  openWith: null,
  path: '',
};
const macApp: AppEntry = {
  name: 'Calculator',
  lnkPath: '',
  target: '',
  aumid: '/System/Applications/Calculator.app',
  openWith: { program: 'open', args: '-a "/System/Applications/Calculator.app" %paths%' },
  path: '/System/Applications/Calculator.app',
};
const linuxApp: AppEntry = {
  name: 'Calculator',
  lnkPath: '',
  target: '',
  aumid: 'org.gnome.Calculator.desktop',
  openWith: { program: 'gnome-calculator', args: '' },
  path: '/usr/share/applications/org.gnome.Calculator.desktop',
};

const handlers = () => ({ start: vi.fn(), reveal: vi.fn(), copyPath: vi.fn() });

describe('the Applications menu verb follows "Coming from" (plan 19)', () => {
  afterEach(() => {
    comingFrom.choice = 'native';
  });

  it.each([
    ['windows', 'Start'],
    ['mac', 'Open'],
    ['linux', 'Open'],
  ] as const)('%s style: the first item reads %s', (style, word) => {
    comingFrom.choice = style;
    const first = applicationsMenuFor(macApp, handlers())[0];
    expect(first.kind === 'item' && first.label).toBe(word);
  });
});

describe('the Applications menu is read-only (plan 17, traps)', () => {
  const FORBIDDEN = /delete|rename|cut|move|bin|trash|paste|uninstall|remove/i;

  it.each([
    ['Windows shortcut', winLnk],
    ['Store app', storeApp],
    ['Mac bundle', macApp],
    ['Ubuntu .desktop', linuxApp],
  ])('%s: Start / Open file location / Copy as path only — no Delete, Rename or Cut', (_, a) => {
    const items = applicationsMenuFor(a, handlers());
    for (const item of items) {
      expect(item.key).toMatch(/^(start|reveal|copy-path)$/);
      if (item.kind === 'item') expect(item.label).not.toMatch(FORBIDDEN);
    }
    expect(items.map((i) => i.key)[0]).toBe('start');
  });

  it('an app with nothing on disk (a Store app) offers Start alone', () => {
    expect(applicationsMenuFor(storeApp, handlers()).map((i) => i.key)).toEqual(['start']);
  });

  it('an app on disk adds Open file location and Copy as path, pointing at the exe / bundle / file', () => {
    const on = handlers();
    const items = applicationsMenuFor(macApp, on);
    expect(items.map((i) => i.key)).toEqual(['start', 'reveal', 'copy-path']);
    for (const item of items) if (item.kind === 'item') void item.run();
    expect(on.start).toHaveBeenCalledWith(macApp);
    expect(on.reveal).toHaveBeenCalledWith(macApp);
    expect(on.copyPath).toHaveBeenCalledWith(macApp);
    expect(appDiskPath(winLnk)).toBe(winLnk.target);
    expect(appDiskPath(linuxApp)).toBe(linuxApp.path);
  });

  it('the view and its tiles are no drop target and drag nothing', () => {
    for (const file of ['ApplicationsView.svelte', 'ApplicationTile.svelte']) {
      const src = readFileSync(
        new URL(`../components/places/applications-parts/${file}`, import.meta.url),
        'utf8',
      );
      expect(src, file).not.toMatch(/data-drop|ondrop|ondragover|ondragenter|ondragstart/);
      expect(src, file).not.toMatch(/draggable="true"|draggable=\{true\}/);
      // nor does it reach for the file actions that write (delete, rename, cut, paste)
      expect(src, file).not.toMatch(/state\/actions|actions\.(delete|rename|cut|paste)/);
    }
  });
});

describe('Copy as path — the same text as the file list', () => {
  beforeEach(() => clipboardWritePathsText.mockClear());

  it('the menu item is labelled "Copy as path"', () => {
    const item = applicationsMenuFor(macApp, handlers()).find((i) => i.key === 'copy-path');
    expect(item?.kind === 'item' && item.label).toBe('Copy as path');
  });

  it('writes the quoted-text form of the exe / bundle / file path', async () => {
    await copyAppPath(winLnk);
    expect(clipboardWritePathsText).toHaveBeenCalledWith([winLnk.target]);
  });

  it('a pending cut is cleared, as the text replaced the OS clipboard', async () => {
    clipboard.set(['/tmp/a.txt'], true);
    await copyAppPath(macApp);
    expect(clipboard.cut).toBe(false);
    expect(clipboard.paths).toEqual([]);
  });
});

describe('startApp — the palette run rule, never a real launch here', () => {
  beforeEach(() => {
    openPath.mockClear();
    launchApp.mockClear();
  });

  it('opens the Start-menu shortcut when there is one', async () => {
    await startApp(winLnk);
    expect(openPath).toHaveBeenCalledWith(winLnk.lnkPath);
    expect(launchApp).not.toHaveBeenCalled();
  });

  it.each([storeApp, macApp, linuxApp])('else hands the id to launch_app ($aumid)', async (a) => {
    await startApp(a);
    expect(launchApp).toHaveBeenCalledWith(a.aumid);
    expect(openPath).not.toHaveBeenCalled();
  });
});

describe('appKeyAction', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as Pick<
      KeyboardEvent,
      'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
    >;
  const at = (over: Partial<Parameters<typeof appKeyAction>[1]> = {}) => ({
    index: 0,
    count: 10,
    cols: 4,
    filter: '',
    inInput: false,
    ...over,
  });

  it('Enter starts the highlighted app; with nothing shown it does nothing', () => {
    expect(appKeyAction(key('Enter'), at(), false)).toEqual({ kind: 'start' });
    expect(appKeyAction(key('Enter'), at({ count: 0 }), false)).toEqual({ kind: 'none' });
  });

  it('on a Mac ⌘O and ⌘↓ start it too', () => {
    expect(appKeyAction(key('o', { metaKey: true }), at(), true)).toEqual({ kind: 'start' });
    expect(appKeyAction(key('ArrowDown', { metaKey: true }), at(), true)).toEqual({
      kind: 'start',
    });
  });

  it('arrows move by one across and by a row down, clamped to the list', () => {
    expect(appKeyAction(key('ArrowRight'), at({ index: 2 }), false)).toEqual({
      kind: 'move',
      to: 3,
    });
    expect(appKeyAction(key('ArrowLeft'), at({ index: 0 }), false)).toEqual({
      kind: 'move',
      to: 0,
    });
    expect(appKeyAction(key('ArrowDown'), at({ index: 1 }), false)).toEqual({
      kind: 'move',
      to: 5,
    });
    expect(appKeyAction(key('ArrowDown'), at({ index: 8 }), false)).toEqual({
      kind: 'move',
      to: 9,
    });
    expect(appKeyAction(key('ArrowUp'), at({ index: 5 }), false)).toEqual({ kind: 'move', to: 1 });
    expect(appKeyAction(key('End'), at(), false)).toEqual({ kind: 'move', to: 9 });
  });

  it('typing on the grid filters; Backspace and Escape take it back', () => {
    expect(appKeyAction(key('c'), at(), false)).toEqual({ kind: 'filter', text: 'c' });
    expect(appKeyAction(key('a'), at({ filter: 'c' }), false)).toEqual({
      kind: 'filter',
      text: 'ca',
    });
    expect(appKeyAction(key('Backspace'), at({ filter: 'ca' }), false)).toEqual({
      kind: 'filter',
      text: 'c',
    });
    expect(appKeyAction(key('Escape'), at({ filter: 'ca' }), false)).toEqual({
      kind: 'filter',
      text: '',
    });
  });

  it('Delete, F2 and Ctrl+X do nothing here (read-only)', () => {
    expect(appKeyAction(key('Delete'), at(), false)).toEqual({ kind: 'none' });
    expect(appKeyAction(key('F2'), at(), false)).toEqual({ kind: 'none' });
    expect(appKeyAction(key('x', { ctrlKey: true }), at(), false)).toEqual({ kind: 'none' });
    expect(appKeyAction(key('Backspace', { metaKey: true }), at(), true)).toEqual({ kind: 'none' });
  });

  it('inside the filter box letters and ←/→ belong to the box; F5 still reloads', () => {
    expect(appKeyAction(key('c'), at({ inInput: true }), false)).toEqual({ kind: 'none' });
    expect(appKeyAction(key('ArrowLeft'), at({ inInput: true }), false)).toEqual({ kind: 'none' });
    expect(appKeyAction(key('F5'), at({ inInput: true }), false)).toEqual({ kind: 'reload' });
  });

  it('a row holds as many 112 px tiles as fit, never fewer than one', () => {
    expect(appColumnsFor(800)).toBe(6);
    expect(appColumnsFor(100)).toBe(1);
  });
});

describe('the Uninstall item (plan 18)', () => {
  const withUninstall = (enabled: boolean, reason = '') => {
    const run = vi.fn();
    return {
      run,
      on: { ...handlers(), uninstall: { state: () => ({ enabled, reason }), run } },
    };
  };

  it('is last, after a divider', () => {
    const { on } = withUninstall(true);
    const items = applicationsMenuFor(winLnk, on);
    expect(items.slice(-2).map((i) => i.kind)).toEqual(['divider', 'item']);
    expect(items.at(-1)?.key).toBe('uninstall');
    expect(items.at(-1)).toMatchObject({ label: 'Uninstall' });
  });

  it('is greyed with its reason when it cannot act', () => {
    const { on } = withUninstall(false, 'Part of Windows');
    const item = applicationsMenuFor(winLnk, on).at(-1);
    expect(item).toMatchObject({ key: 'uninstall', shortcut: 'Part of Windows' });
    expect(item?.kind === 'item' && item.enabled?.()).toBe(false);
  });

  it('runs the handler with the app', () => {
    const { on, run } = withUninstall(true);
    const item = applicationsMenuFor(storeApp, on).at(-1);
    if (item?.kind === 'item') void item.run();
    expect(run).toHaveBeenCalledWith(storeApp);
  });

  it('is absent without a handler', () => {
    expect(applicationsMenuFor(winLnk, handlers()).some((i) => i.key === 'uninstall')).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEntry } from '$lib/types/palette';
import type { Confirmed } from '$lib/api/uninstall';
import type { Uninstallable, UninstallOutcome } from '$lib/types/uninstall';

// ⛔ No test reaches an uninstaller: the whole IPC module is a mock that only records calls.
const uninstallList = vi.fn<() => Promise<Uninstallable[]>>(async () => []);
const uninstallApp = vi.fn<(row: Confirmed) => Promise<UninstallOutcome>>(async () => 'gone');
const openAppsSettings = vi.fn<() => Promise<void>>(async () => {});
vi.mock('$lib/api/uninstall', () => ({
  uninstallList: () => uninstallList(),
  uninstallApp: (row: Confirmed) => uninstallApp(row),
  openAppsSettings: () => openAppsSettings(),
}));
// ⛔ No test spawns a pty: the terminal is a plain fake that records writes.
const clipboardWriteText = vi.fn<(text: string) => Promise<void>>(async () => {});
vi.mock('$lib/api/clipboard', () => ({
  clipboardWriteText: (text: string) => clipboardWriteText(text),
}));
const fakeTerminal = vi.hoisted(() => ({
  open: false,
  sessionId: null as number | null,
  exited: false,
  plain: false,
  plainNext: false,
  requestPlain: vi.fn<(on?: boolean) => void>(),
  write: vi.fn<(data: string) => void>(),
  waitFor: vi.fn<(text: string, ms: number) => Promise<boolean>>(async () => true),
}));
vi.mock('./terminal.svelte', () => ({ terminal: fakeTerminal }));
vi.mock('$lib/state/terminal.svelte', () => ({ terminal: fakeTerminal }));
vi.mock('$lib/api/palette', () => ({
  spotlightApps: vi.fn(async () => []),
  launchApp: vi.fn(),
}));

import { confirm } from './confirm.svelte';
import { notices } from './notices.svelte';
import { applications } from './applications.svelte';
import { checkApp, isStoreApp, matchRow, uninstall } from './uninstall.svelte';

const row = (over: Partial<Uninstallable> & { id: string; name: string }): Uninstallable => ({
  version: '1.0',
  publisher: 'Pub',
  folder: '',
  path: '',
  removable: 'yes',
  typed: false,
  program: 'C:\\Program Files\\X\\unins000.exe',
  stamp: '',
  ...over,
});
const tile = (name: string, target = ''): AppEntry => ({
  name,
  lnkPath: target ? 'C:\\x.lnk' : '',
  target,
  aumid: '',
  openWith: null,
  path: target,
});

const sevenZip = row({ id: 'a', name: '7-Zip', folder: 'C:\\Program Files\\7-Zip' });

describe('matchRow (plan 18, 2.1)', () => {
  it('a shortcut under the row folder finds it', () => {
    const t = tile('7-Zip File Manager', 'C:\\Program Files\\7-Zip\\7zFM.exe');
    expect(matchRow(t, [sevenZip])?.id).toBe('a');
  });

  it('the deeper folder wins', () => {
    const outer = row({ id: 'o', name: 'Suite', folder: 'C:\\Program Files\\Suite' });
    const inner = row({ id: 'i', name: 'Tool', folder: 'C:\\Program Files\\Suite\\Tool' });
    const t = tile('Tool', 'C:\\Program Files\\Suite\\Tool\\t.exe');
    expect(matchRow(t, [outer, inner])?.id).toBe('i');
  });

  it('two rows on the same folder is no match', () => {
    const a = row({ id: '1', name: 'A', folder: 'C:\\P\\X' });
    const b = row({ id: '2', name: 'B', folder: 'C:\\P\\X' });
    expect(matchRow(tile('Zed', 'C:\\P\\X\\x.exe'), [a, b])).toBeNull();
  });

  it('a folder prefix is not a path prefix', () => {
    const a = row({ id: '1', name: 'A', folder: 'C:\\P\\X' });
    expect(matchRow(tile('Zed', 'C:\\P\\XY\\x.exe'), [a])).toBeNull();
  });

  it('falls back to exactly one row with the same name, case-insensitive', () => {
    const r = row({ id: 'n', name: 'Notepad++' });
    expect(matchRow(tile('notepad++'), [r])?.id).toBe('n');
  });

  it('two rows with the same name and no folder is no match; no match is null', () => {
    const a = row({ id: '1', name: 'Same' });
    const b = row({ id: '2', name: 'Same' });
    expect(matchRow(tile('Same'), [a, b])).toBeNull();
    expect(matchRow(tile('Other'), [a, b])).toBeNull();
  });
});

describe('checkApp', () => {
  it('greys system, trove and no-uninstaller with their reasons', () => {
    const t = tile('7-Zip', 'C:\\Program Files\\7-Zip\\7z.exe');
    expect(checkApp(t, [{ ...sevenZip, removable: 'system' }], 'windows')).toEqual({
      kind: 'refused',
      reason: 'Part of Windows',
    });
    expect(checkApp(t, [{ ...sevenZip, removable: 'trove' }], 'windows')).toMatchObject({
      kind: 'refused',
      reason: 'This is Trove',
    });
    expect(checkApp(tile('Ghost'), [], 'windows')).toEqual({
      kind: 'refused',
      reason: 'No uninstaller found',
    });
  });

  it('off Windows and Mac it is not available yet', () => {
    expect(checkApp(tile('7-Zip'), [sevenZip], 'other')).toMatchObject({ kind: 'refused' });
  });

  it('on a Mac only the row whose bundle path is the tile path exactly', () => {
    const xApp = row({
      id: 'm',
      name: 'X',
      folder: '/Applications/X.app',
      program: '/Applications/X.app',
      stamp: 's1',
    });
    const mac = (path: string): AppEntry => ({ ...tile('X'), path });
    expect(checkApp(mac('/Applications/X.app'), [xApp], 'mac')).toEqual({ kind: 'row', row: xApp });
    // a name match or a path under the bundle is not enough
    expect(checkApp(mac('/Applications/X.app/Contents'), [xApp], 'mac')).toMatchObject({
      kind: 'refused',
    });
    expect(checkApp(mac('/Users/me/X.app'), [xApp], 'mac')).toMatchObject({ kind: 'refused' });
    expect(checkApp(mac(''), [{ ...xApp, folder: '' }], 'mac')).toMatchObject({
      kind: 'refused',
    });
    // a Mac row that may not move is greyed with its reason
    expect(checkApp(mac('/Applications/X.app'), [{ ...xApp, removable: 'link' }], 'mac')).toEqual({
      kind: 'refused',
      reason: 'This is a link, not the app',
    });
  });

  it('a Store app opens Settings instead', () => {
    const store: AppEntry = { ...tile('Calculator'), aumid: 'Microsoft.Calc!App' };
    expect(isStoreApp(store)).toBe(true);
    expect(checkApp(store, [], 'windows')).toEqual({ kind: 'settings' });
  });
});

describe('uninstall.ask', () => {
  const answer = async (ok: boolean) => {
    await vi.waitFor(() => expect(confirm.pending).not.toBeNull());
    confirm.answer(ok);
  };
  const t = tile('7-Zip', 'C:\\Program Files\\7-Zip\\7z.exe');

  beforeEach(() => {
    uninstallList.mockReset().mockResolvedValue([sevenZip]);
    uninstallApp.mockReset().mockResolvedValue('gone');
    openAppsSettings.mockReset();
    notices.list.length = 0;
    uninstall.rows = [sevenZip];
    uninstall.loaded = true;
    uninstall.running = false;
    uninstall.host = 'windows';
  });

  it('no call when the confirm says no', async () => {
    const p = uninstall.ask(t);
    await answer(false);
    await p;
    expect(uninstallApp).not.toHaveBeenCalled();
  });

  it('one call with what the confirm showed, when the confirm says yes', async () => {
    const p = uninstall.ask(t);
    expect(confirm.pending).toMatchObject({ danger: true, okLabel: 'Uninstall' });
    expect(confirm.pending?.message).toContain(`Runs: ${sevenZip.program}`);
    await answer(true);
    await p;
    expect(uninstallApp).toHaveBeenCalledTimes(1);
    expect(uninstallApp).toHaveBeenCalledWith(sevenZip);
  });

  it('only gone toasts "uninstalled"', async () => {
    uninstallApp.mockResolvedValue('stillListed');
    const p = uninstall.ask(t);
    await answer(true);
    await p;
    expect(notices.list.map((n) => n.message).join('\n')).not.toMatch(/was uninstalled/);
  });

  it('gone toasts "was uninstalled"', async () => {
    const p = uninstall.ask(t);
    await answer(true);
    await p;
    expect(notices.list.some((n) => n.message === '7-Zip was uninstalled')).toBe(true);
  });

  it.each(['system', 'trove', 'noUninstaller'] as const)(
    'never asks nor calls for a %s row',
    async (removable) => {
      uninstall.rows = [{ ...sevenZip, removable }];
      await uninstall.ask(t);
      expect(confirm.pending).toBeNull();
      expect(uninstallApp).not.toHaveBeenCalled();
    },
  );

  it('a Store app opens Settings with no confirm and no uninstall', async () => {
    const store: AppEntry = { ...tile('Calculator'), aumid: 'Microsoft.Calc!App' };
    await uninstall.ask(store);
    expect(openAppsSettings).toHaveBeenCalledTimes(1);
    expect(uninstallApp).not.toHaveBeenCalled();
  });

  it('a second uninstall while one runs is refused with a notice', async () => {
    uninstall.running = true;
    await uninstall.ask(t);
    expect(confirm.pending).toBeNull();
    expect(uninstallApp).not.toHaveBeenCalled();
    expect(notices.list.length).toBe(1);
  });
});

describe('uninstall.ask on a Mac', () => {
  const xApp = row({
    id: 'm',
    name: 'X',
    folder: '/Applications/X.app',
    program: '/Applications/X.app',
    stamp: 's1',
  });
  const t: AppEntry = { ...tile('X'), path: '/Applications/X.app' };
  const answer = async (ok: boolean) => {
    await vi.waitFor(() => expect(confirm.pending).not.toBeNull());
    confirm.answer(ok);
  };

  beforeEach(() => {
    vi.stubGlobal('window', {
      __TROVE_PLATFORM__: { os: 'macos', thisPcLabel: 'This Mac' },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    uninstallList.mockReset().mockResolvedValue([xApp]);
    uninstallApp.mockReset().mockResolvedValue('gone');
    notices.list.length = 0;
    uninstall.rows = [xApp];
    uninstall.loaded = true;
    uninstall.running = false;
    uninstall.host = null; // read live: the stub above says macOS
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a new ~/Applications app gets a live "Move to Trash" once the app list re-reads', async () => {
    const fresh = '/Users/me/Applications/TroveTest.app';
    const newApp = row({ id: 'n', name: 'TroveTest', folder: fresh, program: fresh, stamp: 's2' });
    const newTile: AppEntry = { ...tile('TroveTest'), path: fresh };
    // the rows were read when the place first showed, before the bundle existed
    expect(uninstall.menuState(newTile)).toEqual({
      enabled: false,
      reason: 'Not found in Applications',
    });
    uninstallList.mockResolvedValue([xApp, newApp]);
    await applications.reload(); // what the folder watch (or F5) does
    await vi.waitFor(() => expect(uninstall.menuState(newTile).enabled).toBe(true));
  });

  it('the confirm names the app and the bundle; yes sends the stamp too', async () => {
    const p = uninstall.ask(t);
    expect(confirm.pending).toMatchObject({
      title: 'Move X to the Trash?',
      okLabel: 'Move to Trash',
      danger: true,
    });
    expect(confirm.pending?.message).toContain('Moves: /Applications/X.app');
    await answer(true);
    await p;
    expect(uninstallApp).toHaveBeenCalledWith(xApp);
    expect(notices.list.some((n) => n.message === 'X was moved to the Trash')).toBe(true);
  });

  it('noTrash warns, says drag it in Finder, and does not watch', async () => {
    uninstallApp.mockResolvedValue('noTrash');
    const p = uninstall.ask(t);
    await answer(true);
    await p;
    const n = notices.list.find((x) => x.kind === 'warning');
    expect(n?.message).toContain('Drag it to the Trash in Finder');
    expect(uninstall.watching).toBeNull();
  });

  it('a refusal from Rust shows as a plain notice', async () => {
    uninstallApp.mockRejectedValue('Quit X first.');
    const p = uninstall.ask(t);
    await answer(true);
    await p;
    expect(notices.list.map((n) => n.message)).toContain('Quit X first.');
    expect(uninstall.running).toBe(false);
  });
});

describe('Ubuntu (plan 18, Phase 4)', () => {
  const desktop = '/usr/share/applications/org.gnome.Mines.desktop';
  const mines: AppEntry = { ...tile('Mines'), aumid: 'org.gnome.Mines.desktop', path: desktop };
  const typedRow = row({
    id: 'm',
    name: 'Mines',
    path: desktop,
    program: 'sudo apt remove gnome-mines',
    typed: true,
  });
  const answer = async (ok: boolean) => {
    await vi.waitFor(() => expect(confirm.pending).not.toBeNull());
    confirm.answer(ok);
  };

  beforeEach(() => {
    uninstallList.mockReset().mockResolvedValue([typedRow]);
    uninstallApp.mockReset().mockResolvedValue('typedInTerminal');
    clipboardWriteText.mockReset().mockResolvedValue(undefined);
    fakeTerminal.open = false;
    fakeTerminal.sessionId = null;
    fakeTerminal.exited = false;
    fakeTerminal.plain = false;
    fakeTerminal.plainNext = false;
    fakeTerminal.write.mockReset();
    fakeTerminal.requestPlain.mockReset().mockImplementation((on = true) => {
      fakeTerminal.plainNext = on;
    });
    // the pane's spawn: a plain shell when one was requested, and its prompt
    fakeTerminal.waitFor.mockReset().mockImplementation(async () => {
      fakeTerminal.sessionId = 7;
      fakeTerminal.plain = fakeTerminal.plainNext;
      return true;
    });
    notices.list.length = 0;
    uninstall.rows = [typedRow];
    uninstall.loaded = true;
    uninstall.running = false;
    uninstall.host = 'linux';
  });
  afterEach(() => {
    uninstall.host = null;
  });

  it('joins a tile to its row by the exact .desktop path only', () => {
    expect(checkApp(mines, [typedRow], 'linux')).toEqual({ kind: 'row', row: typedRow });
    // same name, another file: no match (no name fallback on Ubuntu)
    expect(checkApp({ ...mines, path: '/x/Mines.desktop' }, [typedRow], 'linux')).toEqual({
      kind: 'refused',
      reason: 'No uninstaller found',
    });
    expect(checkApp(mines, [{ ...typedRow, removable: 'system' }], 'linux')).toEqual({
      kind: 'refused',
      reason: 'Ubuntu needs this package',
    });
  });

  it('types the confirmed line into a fresh shell with no trailing newline', async () => {
    const p = uninstall.ask(mines);
    await vi.waitFor(() => expect(confirm.pending).not.toBeNull());
    expect(confirm.pending?.message).toContain('Runs: sudo apt remove gnome-mines');
    expect(confirm.pending?.message).toContain('Press Enter to run it');
    await answer(true);
    await p;
    expect(fakeTerminal.open).toBe(true);
    expect(fakeTerminal.requestPlain).toHaveBeenCalledWith();
    expect(fakeTerminal.waitFor).toHaveBeenCalledWith('trove-uninstall$ ', 5000);
    expect(fakeTerminal.write).toHaveBeenCalledTimes(1);
    const written = fakeTerminal.write.mock.calls[0][0];
    expect(written).toBe('sudo apt remove gnome-mines');
    expect(written).not.toMatch(/[\r\n]$/);
    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(notices.list.map((n) => n.message).join('\n')).not.toMatch(/was uninstalled/);
  });

  it('with a live session it never writes: the line is copied instead', async () => {
    fakeTerminal.open = true;
    fakeTerminal.sessionId = 3;
    const p = uninstall.ask(mines);
    await vi.waitFor(() => expect(confirm.pending).not.toBeNull());
    expect(confirm.pending?.message).toContain('copied');
    await answer(true);
    await p;
    expect(fakeTerminal.write).not.toHaveBeenCalled();
    expect(clipboardWriteText).toHaveBeenCalledWith('sudo apt remove gnome-mines');
    expect(notices.list.some((n) => n.message.includes('nothing was typed'))).toBe(true);
  });

  it('no prompt from the new shell: nothing is written, the line is copied', async () => {
    fakeTerminal.waitFor.mockResolvedValue(false);
    const p = uninstall.ask(mines);
    await answer(true);
    await p;
    expect(fakeTerminal.write).not.toHaveBeenCalled();
    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
    // the unused request is withdrawn: the next pane opening is the person's own shell
    expect(fakeTerminal.plainNext).toBe(false);
  });

  it('the shell that came up is not the plain one: nothing is written, the line is copied', async () => {
    fakeTerminal.waitFor.mockImplementation(async () => {
      fakeTerminal.sessionId = 7;
      fakeTerminal.plain = false; // e.g. a Restart took the spawn
      return true;
    });
    const p = uninstall.ask(mines);
    await answer(true);
    await p;
    expect(fakeTerminal.write).not.toHaveBeenCalled();
    expect(clipboardWriteText).toHaveBeenCalledWith('sudo apt remove gnome-mines');
  });

  it('a refused confirm types nothing', async () => {
    const p = uninstall.ask(mines);
    await answer(false);
    await p;
    expect(uninstallApp).not.toHaveBeenCalled();
    expect(fakeTerminal.write).not.toHaveBeenCalled();
  });

  it('GNOME Software rows say so and type nothing', async () => {
    const gs = {
      ...typedRow,
      program: 'gnome-software --details=org.gnome.Mines.desktop',
      typed: false,
    };
    uninstall.rows = [gs];
    uninstallApp.mockResolvedValue('stillListed');
    const p = uninstall.ask(mines);
    await vi.waitFor(() => expect(confirm.pending).not.toBeNull());
    expect(confirm.pending?.message).toContain('GNOME Software will open on Mines.');
    await answer(true);
    await p;
    expect(fakeTerminal.write).not.toHaveBeenCalled();
  });
});

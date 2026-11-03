import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ windows: true }));
vi.mock('$lib/utils/platform', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/platform')>()),
  onWindows: () => platform.windows,
}));

// the dialog is the top trap in these tests; no DOM, so the real focus hook would say it is not
vi.mock('./use-focus-return.svelte', () => ({
  useFocusReturn: () => ({ trap: () => ({ destroy() {} }), isTop: () => true }),
}));
const api = vi.hoisted(() => ({
  apps: [] as import('$lib/types/palette').AppEntry[],
  resolved: null as string | null,
}));
vi.mock('$lib/api/palette', () => ({ spotlightApps: vi.fn(async () => api.apps) }));
vi.mock('$lib/api/shell-verbs', () => ({
  detectCommonCommands: vi.fn(async () => []),
  resolveCustomProgram: vi.fn(async () => api.resolved),
}));

import { resolveCustomProgram } from '$lib/api/shell-verbs';
import { customize } from '$lib/state/customize.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { AppEntry } from '$lib/types/palette';
import { BLOCKED_REASON } from '$lib/utils/app-pick';
import { useCustomizeDialog } from './use-customize-dialog.svelte';

// called straight: in this (server-runtime) project `$effect` is a no-op and `$effect.root` never
// runs its callback
const open = () => ({ dialog: useCustomizeDialog(), stop: () => {} });

describe('the Customize form placeholders come from the hook', () => {
  let stop = () => {};
  afterEach(() => stop());

  it('Windows examples mention WSL', () => {
    platform.windows = true;
    const h = open();
    stop = h.stop;
    expect(h.dialog.labelPlaceholder).toBe('Open with Code (WSL)');
    expect(h.dialog.argsPlaceholder).toBe('--remote wsl+%distro% %linuxpath%');
  });
  it('Mac/Linux examples do not', () => {
    platform.windows = false;
    const h = open();
    stop = h.stop;
    expect(h.dialog.labelPlaceholder).toBe('Open with Code');
    expect(h.dialog.argsPlaceholder).toBe('--new-window %path%');
  });
});

const entry = (name: string, more: Partial<AppEntry> = {}): AppEntry => ({
  name,
  lnkPath: '',
  target: '',
  aumid: '',
  openWith: null,
  path: '',
  ...more,
});
const ZED_EXE = 'C:\\Users\\alex\\AppData\\Local\\Programs\\Zed\\zed.exe';
const WIN_ZED = entry('Zed', {
  target: ZED_EXE,
  aumid: 'dev.zed.Zed',
  openWith: { program: ZED_EXE, args: '%paths%' },
  path: ZED_EXE,
});
const MAC_ZED = entry('Zed', {
  aumid: '/Applications/Zed.app',
  openWith: { program: 'open', args: '-a "/Applications/Zed.app" %paths%' },
  path: '/Applications/Zed.app',
});
const LINUX_ZED = entry('Zed', {
  aumid: 'dev.zed.Zed.desktop',
  openWith: { program: '/home/alex/.local/zed.app/libexec/zed-editor', args: '%paths%' },
  path: '/home/alex/.local/share/applications/dev.zed.Zed.desktop',
});
const STORE = entry('Zedge Wallpapers', { aumid: 'Zedge.Wallpapers_abc!App' });
const ZIP = entry('7-Zip', { openWith: { program: 'C:\\7z.exe', args: '%paths%' } });

/** a key event with the bits the handlers read; `stopped` says whether it was consumed */
const key = (k: string, target: object = { tagName: 'INPUT', type: 'text' }) => {
  const e = {
    key: k,
    target,
    stopped: false,
    preventDefault() {},
    stopPropagation() {
      e.stopped = true;
    },
  };
  return e as typeof e & KeyboardEvent;
};

const openWith = async (apps: AppEntry[]) => {
  api.apps = apps;
  api.resolved = null;
  customize.apps = null;
  settings.customCommands = [];
  customize.show();
  await customize.loadApps();
  customize.add();
  return useCustomizeDialog();
};
const type = (text: string) => {
  customize.draft!.program = text;
};

describe('picking a program from the app list', () => {
  afterEach(() => customize.close());

  it('typing "zed" lists Zed, a Store app greyed with the reason', async () => {
    const d = await openWith([ZIP, STORE, WIN_ZED]);
    type('zed');
    expect(d.appMatches.map((m) => m.app.name)).toEqual(['Zedge Wallpapers', 'Zed']);
    expect(d.appMatches[0]).toMatchObject({
      blocked: BLOCKED_REASON,
      where: 'Microsoft Store app',
    });
    expect(d.appMatches[1]).toMatchObject({ blocked: null, where: ZED_EXE });
    type('');
    expect(d.appMatches).toEqual([]);
  });

  it.each([
    ['Windows', WIN_ZED, ZED_EXE, '%paths%'],
    ['Mac', MAC_ZED, 'open', '-a "/Applications/Zed.app" %paths%'],
    ['Ubuntu', LINUX_ZED, '/home/alex/.local/zed.app/libexec/zed-editor', '%paths%'],
  ])('%s: picking fills program, args and label', async (_os, app, program, args) => {
    const d = await openWith([app]);
    type('ze');
    d.pickApp(d.appMatches[0]!.app);
    expect(customize.draft).toMatchObject({ program, args, label: 'Open with Zed' });
    // the list shuts once picked, and the pick is checked like a typed program
    expect(d.appMatches).toEqual([]);
    expect(resolveCustomProgram).toHaveBeenLastCalledWith(program);
  });

  it('picking does not overwrite typed args or a typed label', async () => {
    const d = await openWith([WIN_ZED]);
    customize.draft!.args = '--new-window %path%';
    customize.draft!.label = 'Zed it';
    type('zed');
    d.pickApp(WIN_ZED);
    expect(customize.draft).toMatchObject({
      program: ZED_EXE,
      args: '--new-window %path%',
      label: 'Zed it',
    });
  });

  it('a blocked app cannot be picked', async () => {
    const d = await openWith([STORE]);
    type('zedge');
    d.pickApp(STORE);
    expect(customize.draft).toMatchObject({ program: 'zedge', args: '%path%', label: '' });
  });

  it('Save still waits for the program check: a pick whose exe is gone is not saved', async () => {
    const d = await openWith([WIN_ZED]);
    type('zed');
    d.pickApp(WIN_ZED);
    await customize.resolveNow(ZED_EXE);
    expect(d.draftValid).toBe(false);
    d.save();
    expect(settings.customCommands).toEqual([]);

    api.resolved = ZED_EXE;
    await customize.resolveNow(ZED_EXE);
    expect(d.draftValid).toBe(true);
    d.save();
    expect(settings.customCommands).toMatchObject([{ program: ZED_EXE, args: '%paths%' }]);
  });

  it('arrows move the highlight and Enter on it picks, without saving', async () => {
    const d = await openWith([ZIP, WIN_ZED]);
    type('z');
    expect(d.appMatches.map((m) => m.app.name)).toEqual(['Zed', '7-Zip']);
    d.programKeydown(key('ArrowDown'));
    d.programKeydown(key('ArrowDown'));
    d.programKeydown(key('ArrowUp'));
    expect(d.activeMatch).toBe(0);
    const enter = key('Enter');
    d.programKeydown(enter);
    expect(enter.stopped).toBe(true);
    expect(customize.draft?.program).toBe(ZED_EXE);
    expect(settings.customCommands).toEqual([]);
  });

  it('Enter on a greyed row neither picks nor saves', async () => {
    const d = await openWith([STORE]);
    type('zedge');
    d.programKeydown(key('ArrowDown'));
    const enter = key('Enter');
    d.programKeydown(enter);
    expect(enter.stopped).toBe(true);
    expect(customize.draft?.program).toBe('zedge');
  });

  it('Enter with nothing highlighted falls through, and the dialog saves', async () => {
    const d = await openWith([WIN_ZED]);
    type('zed');
    const enter = key('Enter');
    d.programKeydown(enter);
    expect(enter.stopped).toBe(false);
    api.resolved = 'C:\\bin\\zed.exe';
    await customize.resolveNow('zed');
    d.onkeydown(enter);
    expect(customize.draft).toBeNull();
    expect(settings.customCommands).toMatchObject([{ program: 'zed' }]);
  });

  it('Escape shuts the list without leaving the form; typing opens it again', async () => {
    const d = await openWith([WIN_ZED]);
    type('zed');
    const esc = key('Escape');
    d.programKeydown(esc);
    expect(esc.stopped).toBe(true);
    expect(d.appMatches).toEqual([]);
    expect(customize.draft).not.toBeNull();
    type('ze');
    expect(d.appMatches).toHaveLength(1);
  });

  it('editing a saved command does not open the list until its program is changed', async () => {
    const d = await openWith([WIN_ZED]);
    customize.edit({ id: 'x', label: 'Zed', program: 'zed', args: '%path%', scope: ['file'] });
    expect(d.appMatches).toEqual([]);
    type('zed ');
    expect(d.appMatches).toHaveLength(1);
  });
});

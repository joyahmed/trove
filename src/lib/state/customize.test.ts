import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/shell-verbs', () => ({
  detectCommonCommands: vi.fn(async () => []),
  resolveCustomProgram: vi.fn(async (): Promise<string | null> => null),
}));

import { resolveCustomProgram } from '$lib/api/shell-verbs';
import { confirm } from '$lib/state/confirm.svelte';
import { customize } from '$lib/state/customize.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { AppEntry } from '$lib/types/palette';
import type { CustomCommand, DetectedApp } from '$lib/types/shell-verbs';

// ⚠️ Windows paths are doubled backslashes on purpose — `'C:\fast'` is `C:` + FORM FEED + `ast`.
const CODE_EXE = 'C:\\Users\\alex\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
const ZED_EXE = 'C:\\Users\\alex\\AppData\\Local\\Programs\\Zed\\zed.exe';
const VLC_EXE = 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe';
const WT_EXE = 'C:\\Users\\alex\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';

/**
 * What `known_apps::catalogue` offers on Joy's machine: five entries, one of them the WSL guess.
 * Shapes copied from `src-tauri/src/core/known_apps.rs`.
 */
const CANDIDATES: DetectedApp[] = [
  {
    id: 'vscode',
    label: 'Open with Code',
    program: CODE_EXE,
    args: '%path%',
    scope: ['file', 'folder', 'background'],
    source: 'app-paths',
    certain: true,
  },
  {
    id: 'vscode-wsl',
    label: 'Open with Code (WSL)',
    program: CODE_EXE,
    args: '--remote wsl+%distro% %linuxpath%',
    scope: ['wsl'],
    source: 'wsl-distro',
    certain: false,
  },
  {
    id: 'zed',
    label: 'Open with Zed',
    program: ZED_EXE,
    args: '%path%',
    scope: ['file', 'folder', 'background'],
    source: 'known-dir',
    certain: false,
  },
  {
    id: 'vlc',
    label: 'Play with VLC',
    program: VLC_EXE,
    args: '%paths%',
    scope: ['file', 'folder'],
    source: 'app-paths',
    certain: true,
  },
  {
    id: 'terminal-here',
    label: 'Open in Windows Terminal',
    program: WT_EXE,
    args: '-d %path%',
    scope: ['folder', 'background'],
    source: 'path',
    certain: true,
  },
];

/**
 * Joy's three live commands, read from `%APPDATA%\com.joyahmed.trove\settings.json`. This is the
 * regression: both Zed rows were repaired to `zed %path%` by `7275431`, and between them they
 * hid the single detected Zed entry — the correct one.
 */
const LIVE: CustomCommand[] = [
  {
    id: 'code-wsl',
    label: 'Open with Code (WSL)',
    program: 'code',
    args: '--remote wsl+%distro% %linuxpath%',
    scope: ['wsl'],
  },
  {
    id: 'cmd-mueop3u2-c59f',
    label: 'Open with ZED',
    program: 'zed',
    args: '%path%',
    scope: ['file', 'folder'],
  },
  {
    id: 'cmd-muf8tdtx-7n2q',
    label: 'Open with ZED WSL',
    program: 'zed',
    args: '%path%',
    scope: ['file', 'folder', 'wsl', 'background'],
  },
];

const offered = () => customize.suggestions.map((s) => s.found.id);
const similar = () => customize.suggestions.filter((s) => s.similar).map((s) => s.found.id);

describe('customize.suggestions — surface, do not suppress', () => {
  beforeEach(() => {
    settings.customCommands = LIVE.map((c) => ({ ...c, scope: [...c.scope] }));
    customize.detected = CANDIDATES;
  });

  it("two broken Zed rows no longer hide the machine's one correct Zed detection", () => {
    // ⛔ the bug: `zed %path%` twice, neither scoped like the detection, and the detection went.
    expect(offered()).toContain('zed');
    expect(similar()).toContain('zed');
  });

  it('a `wsl`-scoped Code command does not hide a Code candidate scoped to files and folders', () => {
    expect(offered()).toContain('vscode');
    // different arguments as well as a different scope: nothing about it resembles what he has
    expect(similar()).not.toContain('vscode');
  });

  it('an exact match on program, arguments and scope is still treated as already-have', () => {
    // `code-wsl` is `code` + `--remote wsl+%distro% %linuxpath%` + `['wsl']`, field for field
    expect(offered()).not.toContain('vscode-wsl');
  });

  it('offers four of the five, where it used to offer three', () => {
    expect(offered()).toEqual(['vscode', 'zed', 'vlc', 'terminal-here']);
  });

  it('candidates nothing resembles are offered unmarked', () => {
    expect(similar()).toEqual(['zed']);
  });

  it('scope is a set: order and repeats do not make a new command', () => {
    settings.customCommands = [
      {
        id: 'mine',
        label: 'Zed',
        program: 'zed',
        args: '%path%',
        scope: ['background', 'folder', 'file', 'file'],
      },
    ];
    expect(offered()).not.toContain('zed');
  });

  it('a detected entry already added by id is gone whatever it was edited into', () => {
    settings.customCommands = [
      { id: 'vlc', label: 'Renamed', program: 'somethingelse', args: '%path%', scope: ['file'] },
    ];
    expect(offered()).not.toContain('vlc');
  });

  it('nothing detected yet is no suggestions rather than a crash', () => {
    customize.detected = null;
    expect(customize.suggestions).toEqual([]);
  });
});

describe('customize.draftValid — a program nothing would start cannot be saved', () => {
  const resolve = vi.mocked(resolveCustomProgram);

  beforeEach(() => {
    vi.useRealTimers();
    resolve.mockReset();
    settings.customCommands = [];
    customize.add();
  });

  it('a program that resolves to nothing keeps Save disabled, and Save does nothing', async () => {
    resolve.mockResolvedValue(null);
    customize.draft!.program = 'notaprogram';
    await customize.resolveNow('notaprogram');
    expect(resolve).toHaveBeenCalledWith('notaprogram');
    expect(customize.resolved).toBeNull();
    expect(customize.draftValid).toBe(false);
    customize.save();
    expect(settings.customCommands).toEqual([]);
  });

  it('a program that resolves can be saved, and the form shows the full line', async () => {
    resolve.mockResolvedValue(CODE_EXE);
    customize.draft!.program = ' code ';
    await customize.resolveNow('code');
    expect(customize.draftValid).toBe(true);
    expect(customize.commandLine).toBe(`"${CODE_EXE}" %path%`);
    customize.save();
    expect(settings.customCommands.map((c) => c.program)).toEqual(['code']);
  });

  it('an answer for text since changed does not validate the new text', async () => {
    resolve.mockResolvedValue(CODE_EXE);
    customize.draft!.program = 'code';
    await customize.resolveNow('code');
    customize.draft!.program = 'codex';
    expect(customize.draftValid).toBe(false);
  });

  it('typing is debounced: one lookup after the pause, not one per keystroke', async () => {
    vi.useFakeTimers();
    resolve.mockResolvedValue(CODE_EXE);
    for (const text of ['c', 'co', 'cod', 'code']) customize.queueResolve(text);
    expect(resolve).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('code');
    vi.useRealTimers();
  });
});

describe('customize.remove asks first', () => {
  const mine = (id: string): CustomCommand => ({
    id,
    label: 'Mine',
    program: 'code',
    args: '%path%',
    scope: ['file'],
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('keeps the command on No and removes it on Yes', async () => {
    settings.customCommands = [mine('a'), mine('b')];
    const no = customize.remove('a');
    await settle();
    expect(confirm.pending?.message).toContain('Mine');
    confirm.answer(false);
    await no;
    expect(settings.customCommands.map((c) => c.id)).toEqual(['a', 'b']);
    const yes = customize.remove('a');
    await settle();
    confirm.answer(true);
    await yes;
    expect(settings.customCommands.map((c) => c.id)).toEqual(['b']);
  });

  it('asks nothing for an id that is not there', async () => {
    settings.customCommands = [mine('a')];
    await customize.remove('zzz');
    expect(confirm.pending).toBeNull();
  });
});

describe("customize.pickApp keeps the app's required part", () => {
  const ZED: AppEntry = {
    name: 'Zed',
    lnkPath: '',
    target: '',
    aumid: '/Applications/Zed.app',
    path: '/Applications/Zed.app',
    openWith: { program: 'open', args: '-a "/Applications/Zed.app" %paths%' },
  };
  const pick = (args: string) => {
    customize.draft = { id: 'x', label: '', program: '', args, scope: ['file'] };
    expect(customize.pickApp(ZED)).toBe(true);
    return customize.draft!.args;
  };

  it('typed arguments get the Mac `-a "<app>"` put in front, and stay', () => {
    // ⛔ the bug (MAC-C.6.8): `open --p15keep %path%` — the app was dropped, so Zed never opened
    expect(pick('--p15keep %path%')).toBe('-a "/Applications/Zed.app" --p15keep %path%');
  });

  it('blank or untouched arguments are replaced whole, as before', () => {
    expect(pick('')).toBe('-a "/Applications/Zed.app" %paths%');
    expect(pick('%path%')).toBe('-a "/Applications/Zed.app" %paths%');
  });

  it('picking twice does not stack the part', () => {
    const once = pick('--p15keep %path%');
    expect(pick(once)).toBe(once);
  });

  it('a Windows pick has no required part, so typed arguments are left alone', () => {
    const exe: AppEntry = { ...ZED, openWith: { program: 'C:\\zed.exe', args: '%paths%' } };
    customize.draft = { id: 'x', label: '', program: '', args: '--new %path%', scope: ['file'] };
    customize.pickApp(exe);
    expect(customize.draft!.args).toBe('--new %path%');
  });
});

describe('customize.pickApp relabels with the pick unless the label was typed', () => {
  const app = (name: string): AppEntry => ({
    name,
    lnkPath: '',
    target: '',
    aumid: name,
    path: `C:\${name}.exe`,
    openWith: { program: `C:\${name}.exe`, args: '%paths%' },
  });

  it('picking a second app changes the label the first pick wrote', () => {
    customize.add();
    customize.pickApp(app('Visual Studio Code'));
    expect(customize.draft!.label).toBe('Open with Visual Studio Code');
    customize.pickApp(app('Wispr Flow'));
    expect(customize.draft!.label).toBe('Open with Wispr Flow');
  });

  it('a label typed by hand is kept across picks', () => {
    customize.add();
    customize.pickApp(app('Visual Studio Code'));
    customize.draft!.label = 'My editor';
    customize.pickApp(app('Wispr Flow'));
    expect(customize.draft!.label).toBe('My editor');
  });

  it('editing a saved command keeps its label on a pick', () => {
    customize.add();
    customize.pickApp(app('Visual Studio Code'));
    customize.edit({
      id: 'x',
      label: 'Open with Visual Studio Code',
      program: 'a',
      args: '%path%',
      scope: ['file'],
    });
    customize.pickApp(app('Wispr Flow'));
    expect(customize.draft!.label).toBe('Open with Visual Studio Code');
  });
});

describe('customize.pickApp swaps the arguments a pick wrote', () => {
  const mac = (name: string): AppEntry => ({
    name,
    lnkPath: '',
    target: '',
    aumid: `/Applications/${name}.app`,
    path: `/Applications/${name}.app`,
    openWith: { program: 'open', args: `-a "/Applications/${name}.app" %paths%` },
  });

  it('pick A then B gives B arguments only, not both -a parts', () => {
    customize.add();
    customize.pickApp(mac('A'));
    customize.pickApp(mac('B'));
    expect(customize.draft!.args).toBe('-a "/Applications/B.app" %paths%');
  });

  it('typed arguments are still kept, with the new -a part in front', () => {
    customize.add();
    customize.pickApp(mac('A'));
    customize.draft!.args = '--flag %path%';
    customize.pickApp(mac('B'));
    expect(customize.draft!.args).toBe('-a "/Applications/B.app" --flag %path%');
  });
});

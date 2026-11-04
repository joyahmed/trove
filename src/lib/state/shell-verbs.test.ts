import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/shell-verbs', () => ({
  shellVerbs: vi.fn(async () => []),
  runShellVerb: vi.fn(async () => {}),
  runCustomCommand: vi.fn(async () => {}),
  shellMenu: vi.fn(),
  shellMenuInvoke: vi.fn(async () => {}),
}));

import { runCustomCommand, shellMenu, shellMenuInvoke } from '$lib/api/shell-verbs';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import { notices } from '$lib/state/notices.svelte';
import { settings } from '$lib/state/settings.svelte';
import { shellVerbs } from '$lib/state/shell-verbs.svelte';
import type { CommandScope, CustomCommand } from '$lib/types/shell-verbs';

const WINDOWS = 'D:\\proj';
const WSL = '\\\\wsl.localhost\\Ubuntu\\home\\alex\\proj';

const cmd = (id: string, scope: CommandScope[], program = id): CustomCommand => ({
  id,
  label: id,
  program,
  args: '%path%',
  scope,
});

const ids = (scope: CommandScope, path: string) =>
  shellVerbs.commandsFor(scope, path).map((c) => c.id);

describe('commandsFor — `wsl` is a filter, not a fourth location kind', () => {
  beforeEach(() => {
    settings.customCommands = [
      // the shipped seed: `wsl` alone means "any WSL target"
      cmd('code-wsl', ['wsl']),
      // what the dialog produces when someone ticks WSL on top of the location kinds
      cmd('zed-wsl', ['file', 'folder', 'wsl', 'background'], 'zed-wsl-prog'),
      // no `wsl` at all: must be unaffected by any of this
      cmd('zed', ['folder']),
      cmd('vlc', ['file']),
    ];
  });

  it('a Windows folder gets only the commands with no `wsl` in their scope', () => {
    expect(ids('folder', WINDOWS)).toEqual(['zed']);
    // ⛔ the bug: `['file','folder','wsl','background']` matched on `folder` and showed here
    expect(ids('folder', WINDOWS)).not.toContain('zed-wsl');
    expect(ids('folder', WINDOWS)).not.toContain('code-wsl');
  });

  it('a WSL folder gets the WSL-scoped ones as well as the plain ones', () => {
    expect(ids('folder', WSL).sort()).toEqual(['code-wsl', 'zed', 'zed-wsl']);
  });

  it('`wsl` alone passes every location kind, but only inside a distro', () => {
    for (const scope of ['file', 'folder', 'background'] as const) {
      expect(ids(scope, WSL)).toContain('code-wsl');
      expect(ids(scope, WINDOWS)).not.toContain('code-wsl');
    }
  });

  it('`wsl` beside location kinds still narrows to those kinds', () => {
    // zed-wsl lists every kind, so compare against one that does not
    settings.customCommands = [cmd('files-in-wsl', ['file', 'wsl'])];
    expect(ids('file', WSL)).toEqual(['files-in-wsl']);
    expect(ids('folder', WSL)).toEqual([]);
    expect(ids('file', WINDOWS)).toEqual([]);
  });

  it('a command with no scope at all is offered nowhere', () => {
    settings.customCommands = [cmd('orphan', [])];
    expect(ids('folder', WINDOWS)).toEqual([]);
    expect(ids('folder', WSL)).toEqual([]);
  });

  it('a plain `folder` command shows on a WSL folder too — a distro folder is still a folder', () => {
    expect(ids('folder', WSL)).toContain('zed');
    expect(ids('file', WSL)).toContain('vlc');
    expect(ids('background', WSL)).not.toContain('zed');
  });
});

describe('commandsFor — a `wsl` command replaces its plain twin inside a distro', () => {
  // Zed opens the UNC path as an empty file; only `--wsl <distro> <linux path>` opens the folder.
  const zed = String.raw`C:\Zed\Zed.exe`;
  beforeEach(() => {
    settings.customCommands = [
      cmd('zed', ['file', 'folder', 'background'], zed),
      cmd('zed-wsl', ['wsl'], zed.toLowerCase()),
      cmd('vlc', ['file'], 'vlc.exe'),
    ];
  });

  it('on a WSL folder only the WSL one is offered', () => {
    expect(ids('folder', WSL)).toEqual(['zed-wsl']);
    expect(ids('background', WSL)).toEqual(['zed-wsl']);
  });

  it('on a Windows folder the plain one stays', () => {
    expect(ids('folder', WINDOWS)).toEqual(['zed']);
  });

  it('a program with no WSL twin keeps its plain command inside a distro', () => {
    expect(ids('file', WSL).sort()).toEqual(['vlc', 'zed-wsl']);
  });
});

describe('commandsFor off Windows', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a wsl-only command never appears on a Mac, even if one is stored', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'macos', thisPcLabel: 'This Mac' } });
    settings.customCommands = [cmd('code-wsl', ['wsl']), cmd('vlc', ['file'])];
    expect(ids('file', WSL)).toEqual(['vlc']);
    expect(ids('file', '/Users/me/a.txt')).toEqual(['vlc']);
    expect(settings.customCommands).toHaveLength(2);
  });
});

describe('runCommand: a command that would not start says so on screen', () => {
  it('raises an error notice naming the command and the reason', async () => {
    vi.mocked(runCustomCommand).mockRejectedValueOnce('code: The system cannot find the file');
    notices.list = [];
    await shellVerbs.runCommand(cmd('code', ['file']), { path: WINDOWS, paths: [WINDOWS] });
    expect(notices.list.map((n) => [n.kind, n.message])).toEqual([
      ['error', 'code did not start: code: The system cannot find the file'],
    ]);
  });
});

describe('menuRows: Windows items arrive in time, late, or not at all', () => {
  const target = { paths: ['C:\\docs\\a.txt'], background: false, dir: 'C:\\docs' };
  const row = (id: number, label: string) => ({
    id,
    label,
    verb: null,
    enabled: true,
    separator: false,
    children: [],
    iconKey: null,
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('an in-time answer becomes rows whose click invokes the live menu by token', async () => {
    vi.mocked(shellMenu).mockResolvedValueOnce({ token: 5, items: [row(8, '7-Zip')] });
    const rows = await shellVerbs.menuRows(target, false, []);
    const item = rows.find((r): r is Extract<MenuItem, { kind: 'item' }> => r.kind === 'item');
    expect(item?.label).toBe('7-Zip');
    item?.run();
    await Promise.resolve();
    expect(shellMenuInvoke).toHaveBeenCalledWith(5, 8, 'C:\\docs');
  });

  it('no answer past the deadline leaves the one late row', async () => {
    vi.useFakeTimers();
    vi.mocked(shellMenu).mockReturnValueOnce(new Promise(() => {}));
    const pending = shellVerbs.menuRows(target, false, []);
    await vi.advanceTimersByTimeAsync(401);
    const rows = await pending;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind === 'item' && rows[0].label).toBe('Windows items took too long');
  });

  it('a shell that refuses leaves nothing behind', async () => {
    vi.mocked(shellMenu).mockRejectedValueOnce('not a file system folder');
    expect(await shellVerbs.menuRows(target, false, [])).toEqual([]);
  });
});

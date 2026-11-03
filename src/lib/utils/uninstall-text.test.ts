import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { comingFrom } from '$lib/state/coming-from.svelte';
import { uninstallVerb } from '$lib/utils/platform';
import type { Uninstallable } from '$lib/types/uninstall';
import {
  confirmText,
  goneLaterNotice,
  outcomeNotice,
  reasonText,
  rowLabel,
} from './uninstall-text';

const row: Uninstallable = {
  id: 'u1',
  name: '7-Zip',
  version: '24.08',
  publisher: 'Igor Pavlov',
  folder: 'c:\\program files\\7-zip',
  path: '',
  removable: 'yes',
  typed: false,
  program: 'C:\\Program Files\\7-Zip\\Uninstall.exe',
  stamp: '',
};

describe('uninstall text (plan 18, 2.2)', () => {
  it('the confirm names the registry row: name, version, publisher', () => {
    const c = confirmText(row);
    expect(c.title).toContain('7-Zip');
    expect(c.message).toContain('24.08');
    expect(c.message).toContain('Igor Pavlov');
  });

  it('the confirm shows the program that will run, never its arguments', () => {
    expect(confirmText(row).message).toContain('Runs: C:\\Program Files\\7-Zip\\Uninstall.exe');
  });

  it('rowLabel does not repeat a version already in the name', () => {
    expect(rowLabel({ ...row, name: '7-Zip 24.08 (x64)' })).toBe(
      '7-Zip 24.08 (x64) by Igor Pavlov',
    );
    expect(rowLabel({ ...row, version: '', publisher: '' })).toBe('7-Zip');
  });

  it.each(['stillListed', 'unknown'] as const)('%s never claims removal', (outcome) => {
    const n = outcomeNotice(row, outcome);
    expect(n.message).not.toMatch(/removed|uninstalled|still installed/i);
  });

  it('only gone says uninstalled', () => {
    expect(outcomeNotice(row, 'gone')).toMatchObject({ kind: 'success' });
    expect(outcomeNotice(row, 'gone').message).toContain('was uninstalled');
    expect(goneLaterNotice(row).message).toContain('was uninstalled');
  });

  it('every refusal has a reason', () => {
    for (const r of [
      'system',
      'trove',
      'noUninstaller',
      'link',
      'notApp',
      'elsewhere',
      'notYet',
      'noMatch',
    ] as const) {
      expect(reasonText(r).length).toBeGreaterThan(0);
    }
    expect(reasonText('noUninstaller')).toBe('No uninstaller Trove can run safely');
    expect(reasonText('noMatch')).toBe('No uninstaller found');
  });

  it('on Ubuntu the Trove refusal says it cannot uninstall itself', () => {
    expect(reasonText('trove', true)).toBe('This is Trove — it cannot uninstall itself');
    expect(reasonText('trove')).toBe('This is Trove');
  });
});

describe('uninstall text on a Mac (plan 18, Phase 3)', () => {
  const app: Uninstallable = {
    ...row,
    name: 'X',
    version: '',
    publisher: '',
    folder: '/Applications/X.app',
    program: '/Applications/X.app',
    stamp: 's1',
  };
  beforeEach(() => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'macos', thisPcLabel: 'x' } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the confirm names the app, the Trash and how to put it back', () => {
    const c = confirmText(app);
    expect(c.title).toBe('Move X to the Trash?');
    expect(c.message).toBe(
      'X goes to the Trash. To put it back, use Put Back in the Trash in Finder.\nMoves: /Applications/X.app',
    );
  });

  it('Mac reasons are plain', () => {
    expect(reasonText('system')).toBe('Part of macOS');
    expect(reasonText('link')).toBe('This is a link, not the app');
    expect(reasonText('notApp').length).toBeGreaterThan(0);
    expect(reasonText('elsewhere').length).toBeGreaterThan(0);
  });

  it('gone says moved to the Trash, never uninstalled or deleted', () => {
    expect(outcomeNotice(app, 'gone')).toEqual({
      kind: 'success',
      message: 'X was moved to the Trash',
    });
    expect(goneLaterNotice(app).message).toBe('X was moved to the Trash');
  });

  it('noTrash is a warning that nothing moved, with no delete-for-good offer', () => {
    const n = outcomeNotice(app, 'noTrash');
    expect(n).toEqual({
      kind: 'warning',
      message:
        'macOS did not let Trove use the Trash, so X was not moved. Drag it to the Trash in Finder.',
    });
    expect(n.message).not.toMatch(/delete|permanent|for good/i);
  });
});

describe('uninstall text takes its bin word from "I\'m coming from" (plan 19)', () => {
  const app: Uninstallable = { ...row, name: 'X', program: '/Applications/X.app' };
  beforeEach(() => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'macos', thisPcLabel: 'x' } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    comingFrom.choice = 'native';
  });

  it.each([
    ['windows', 'Recycle Bin'],
    ['mac', 'Trash'],
    ['linux', 'Trash'],
    ['native', 'Trash'],
  ] as const)('%s says %s in the menu item, confirm and toasts', (choice, bin) => {
    comingFrom.choice = choice;
    expect(uninstallVerb()).toBe(`Move to ${bin}`);
    expect(confirmText(app).title).toBe(`Move X to the ${bin}?`);
    expect(confirmText(app).message).toContain(`goes to the ${bin}`);
    expect(outcomeNotice(app, 'gone').message).toBe(`X was moved to the ${bin}`);
    expect(goneLaterNotice(app).message).toBe(`X was moved to the ${bin}`);
    expect(outcomeNotice(app, 'noTrash').message).toContain(`use the ${bin}`);
    expect(reasonText('elsewhere')).toBe(`Only apps in Applications can be moved to the ${bin}`);
  });

  it('a Windows or Linux host still says Uninstall, whatever is picked', () => {
    comingFrom.choice = 'mac';
    expect(uninstallVerb({ os: 'windows' } as never)).toBe('Uninstall');
    expect(uninstallVerb({ os: 'linux' } as never)).toBe('Uninstall');
  });
});

describe('uninstall text on Ubuntu (plan 18, Phase 4)', () => {
  const typed: Uninstallable = { ...row, program: 'sudo apt remove gnome-mines', typed: true };
  it('the typed confirm shows the exact line and leaves Enter to the person', () => {
    const m = confirmText(typed, true).message;
    expect(m).toContain('The command is typed in the terminal. Press Enter to run it.');
    expect(m).toContain('Runs: sudo apt remove gnome-mines');
  });
  it('GNOME Software confirm names the app', () => {
    const gs = { ...row, program: 'gnome-software --details=x.desktop' };
    expect(confirmText(gs, true).message).toContain('GNOME Software will open on 7-Zip.');
  });
  it('system reason and typed outcome', () => {
    expect(reasonText('system', true)).toBe('Ubuntu needs this package');
    expect(reasonText('system')).toBe('Part of Windows');
    const n = outcomeNotice(typed, 'typedInTerminal');
    expect(n.message).not.toMatch(/uninstalled|removed\b(?! until)/);
    expect(n.message).toContain('Nothing is removed until you press Enter');
  });
});

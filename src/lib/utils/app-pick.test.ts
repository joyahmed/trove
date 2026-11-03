import { describe, expect, it } from 'vitest';
import type { AppEntry } from '$lib/types/palette';
import { BLOCKED_REASON, appWhere, matchApps, toDraft } from './app-pick';

const app = (name: string, more: Partial<AppEntry> = {}): AppEntry => ({
  name,
  lnkPath: '',
  target: '',
  aumid: '',
  openWith: null,
  path: '',
  ...more,
});

// the three OS shapes `all_apps()` produces (plan 17, "The design")
const CODE_EXE = 'C:\\Users\\alex\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
const WIN_CODE = app('Visual Studio Code', {
  lnkPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Visual Studio Code.lnk',
  target: CODE_EXE,
  aumid: 'Microsoft.VisualStudioCode',
  openWith: { program: CODE_EXE, args: '%paths%' },
  path: CODE_EXE,
});
const WIN_STORE = app('Calculator', { aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' });
const MAC_ZED = app('Zed', {
  aumid: '/Applications/Zed.app',
  openWith: { program: 'open', args: '-a "/Applications/Zed.app" %paths%' },
  path: '/Applications/Zed.app',
});
const LINUX_GEDIT = app('Text Editor', {
  aumid: 'org.gnome.gedit.desktop',
  openWith: { program: 'gedit', args: '%paths%' },
  path: '/usr/share/applications/org.gnome.gedit.desktop',
});
// Terminal=true: Rust lists it (gio can launch it) but gives it no open-with
const LINUX_VIM = app('Vim', {
  aumid: 'vim.desktop',
  path: '/usr/share/applications/vim.desktop',
});

describe('matchApps', () => {
  const apps = [app('Notepad++'), app('Zed Preview'), app('Notepad'), app('Zed'), app('Lazed')];

  it('lists names that start with the text before names that only contain it', () => {
    expect(matchApps(apps, 'zed').map((a) => a.name)).toEqual(['Zed Preview', 'Zed', 'Lazed']);
  });
  it('ignores case and surrounding spaces', () => {
    expect(matchApps(apps, '  NOTE ').map((a) => a.name)).toEqual(['Notepad++', 'Notepad']);
  });
  it('matches nothing on empty or blank text', () => {
    expect(matchApps(apps, '')).toEqual([]);
    expect(matchApps(apps, '   ')).toEqual([]);
  });
  it('stops at the limit, prefix hits kept first', () => {
    const many = Array.from({ length: 12 }, (_, i) => app(`App ${i}`));
    expect(matchApps(many, 'app')).toHaveLength(8);
    expect(matchApps([app('My App'), ...many], 'app', 3).map((a) => a.name)).toEqual([
      'App 0',
      'App 1',
      'App 2',
    ]);
  });
  it('keeps blocked apps in the list (they are shown greyed, not hidden)', () => {
    expect(matchApps([WIN_STORE, LINUX_VIM], 'c')).toEqual([WIN_STORE]);
    expect(matchApps([WIN_STORE, LINUX_VIM], 'vim')).toEqual([LINUX_VIM]);
  });
});

describe('toDraft: what a pick saves, per OS shape', () => {
  it('Windows: the exe and %paths%', () => {
    expect(toDraft(WIN_CODE)).toEqual({ program: CODE_EXE, args: '%paths%' });
  });
  it('Mac: open -a "<bundle>" %paths%', () => {
    expect(toDraft(MAC_ZED)).toEqual({
      program: 'open',
      args: '-a "/Applications/Zed.app" %paths%',
    });
  });
  it('Ubuntu: the mapped Exec', () => {
    expect(toDraft(LINUX_GEDIT)).toEqual({ program: 'gedit', args: '%paths%' });
  });
  it('a Store app is blocked with the reason', () => {
    expect(toDraft(WIN_STORE)).toEqual({ blocked: BLOCKED_REASON });
  });
  it('a Terminal=true app (no openWith) is blocked too', () => {
    expect(toDraft(LINUX_VIM)).toEqual({ blocked: BLOCKED_REASON });
  });
});

describe('appWhere', () => {
  it('shows where the app lives, or that it is a Store app', () => {
    expect(appWhere(WIN_CODE)).toBe(CODE_EXE);
    expect(appWhere(MAC_ZED)).toBe('/Applications/Zed.app');
    expect(appWhere(WIN_STORE)).toBe('Microsoft Store app');
  });
});

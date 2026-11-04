import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backgroundMenuFor, openWithItems, rowMenuFor, verbIconPath } from './context-menus';
import { openWith } from '$lib/state/open-with.svelte';
import type { OpenWithApp } from '$lib/types/open-with';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import { comingFrom } from '$lib/state/coming-from.svelte';
import { settings } from '$lib/state/settings.svelte';
import { shellVerbs } from '$lib/state/shell-verbs.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { FileEntry } from '$lib/types/fs';
import { HOME, pathLocation } from '$lib/utils/location';
import { selection } from '$lib/state/selection.svelte';
import { startCompress } from '$lib/api/archive';
import { openTerminal } from '$lib/api/shell';
import { archiveLocation } from '$lib/utils/archive-location';
import { openWithApps } from '$lib/api/open-with';
import { iconUrl, thumbUrl } from '$lib/api/icons';
import { actions } from '$lib/state/actions.svelte';

const run = vi.hoisted(() => ({ verb: vi.fn(async () => {}), custom: vi.fn(async () => {}) }));
vi.mock('$lib/api/shell-verbs', () => ({
  shellVerbs: vi.fn(async () => []),
  runShellVerb: run.verb,
  runCustomCommand: run.custom,
}));

vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));

vi.mock('$lib/api/open-with', () => ({
  openWithApps: vi.fn(async () => []),
  openWithApp: vi.fn(async () => {}),
  openWithDialog: vi.fn(async () => {}),
}));

vi.mock('$lib/api/archive', () => ({
  archiveConflicts: vi.fn(async () => []),
  startExtract: vi.fn(async () => 1),
  startExtractHere: vi.fn(async () => 1),
  startCompress: vi.fn(async () => 1),
}));

const FORMATS = [
  ['ZIP file', 'zip'],
  ['7z file', '7z'],
  ['tar.gz file', 'tar.gz'],
  ['tar.xz file', 'tar.xz'],
  ['tar.zst file', 'tar.zst'],
] as const;

/** the "Compress to" flyout of `items`: five rows, each starts the archive job in its format */
const checkCompressFlyout = async (items: MenuItem[]) => {
  const flyout = items.find((i) => i.key === 'compress-to');
  if (flyout?.kind !== 'submenu') throw new Error('no "Compress to" flyout');
  expect(flyout.label).toBe('Compress to');
  expect(flyout.items.map((i) => (i.kind === 'item' ? i.label : ''))).toEqual(
    FORMATS.map(([label]) => label),
  );
  tabs.active.location = pathLocation('C:\\scratch');
  selection.replaceAll(['C:\\scratch\\a.txt']);
  expect(flyout.enabled?.()).toBe(true);
  for (const [label, format] of FORMATS) {
    vi.mocked(startCompress).mockClear();
    const row = flyout.items.find((i) => i.kind === 'item' && i.label === label);
    if (row?.kind !== 'item') throw new Error(`no ${label} row`);
    expect(row.enabled?.()).toBe(true);
    await row.run();
    expect(startCompress).toHaveBeenCalledExactlyOnceWith(['C:\\scratch\\a.txt'], format);
  }
  selection.clear();
  expect(flyout.enabled?.()).toBe(false);
  for (const row of flyout.items) expect(row.kind === 'item' && row.enabled?.()).toBe(false);
};

const entry = (path: string, isDir: boolean): FileEntry => ({
  name: path.split('\\').pop() ?? path,
  path,
  isDir,
  size: 0,
  modifiedMs: null,
  createdMs: null,
  ext: isDir ? null : 'txt',
  isHidden: false,
  iconKey: isDir ? 'folder' : 'ext/txt',
  typeName: isDir ? 'File folder' : 'Text Document',
});

const labels = (items: ReturnType<typeof rowMenuFor>) =>
  items.filter((i) => i.kind === 'item').map((i) => (i.kind === 'item' ? i.label : ''));

/** The flyout hanging off `key`, or a failure that names it — a missing one is the bug. */
const flyout = (items: MenuItem[], key: string) => {
  const found = items.find((i) => i.key === key);
  if (found?.kind !== 'submenu') throw new Error(`no "${key}" flyout in the background menu`);
  return found;
};

/** Which rows of a menu draw a checkmark right now, by label. */
const checkedLabels = (items: MenuItem[]) =>
  items.filter((i) => i.kind === 'item' && i.checked?.() === true).map((i) => labels([i])[0]);

const rowNamed = (items: MenuItem[], label: string) => {
  const found = items.find((i) => i.kind === 'item' && i.label === label);
  if (found?.kind !== 'item') throw new Error(`no "${label}" row`);
  return found;
};

describe('context menu builders', () => {
  beforeEach(() => {
    shellVerbs.verbs = [
      { key: 'VSCode', label: 'Open with Code', command: 'code "%1"', icon: null, scope: 'file' },
      {
        key: 'git_shell',
        label: 'Open Git Bash here',
        command: 'bash',
        icon: null,
        scope: 'directory',
      },
      {
        key: 'bg',
        label: 'Open Neovim here',
        command: 'nvim',
        icon: null,
        scope: 'directory-background',
      },
    ];
    settings.customCommands = [
      {
        id: 'code-wsl',
        label: 'Open with Code (WSL)',
        program: 'code',
        args: '--remote wsl+%distro% %linuxpath%',
        scope: ['wsl'],
      },
      { id: 'zed', label: 'Open with Zed', program: 'zed', args: '%path%', scope: ['folder'] },
    ];
    run.verb.mockClear();
    run.custom.mockClear();
  });

  it('a file row offers Compress to ZIP file and Extract here, and Extract all…', () => {
    const menu = rowMenuFor(entry('C:\\docs\\photos.zip', false));
    const items = labels(menu);
    expect(menu.some((i) => i.key === 'compress-to')).toBe(true);
    expect(items).toContain('Extract here');
    expect(items).toContain('Extract all…');
    // nothing is selected in this test: the row is there but greyed out
    const row = menu.find((i) => i.kind === 'item' && i.key === 'extract-here');
    expect(row?.kind === 'item' && row.enabled?.()).toBe(false);
  });

  it('the row menu has Compress to with zip, tar.gz, tar.xz, tar.zst, each running its format', async () => {
    await checkCompressFlyout(rowMenuFor(entry('C:\\docs\\photos', true)));
  });

  it('a WSL folder row gets the folder verbs and the WSL command, not the file verbs', () => {
    const items = labels(rowMenuFor(entry('\\\\wsl.localhost\\Ubuntu\\home\\alex\\proj', true)));
    expect(items).toContain('Open Git Bash here');
    expect(items).toContain('Open with Code (WSL)');
    expect(items).toContain('Open with Zed');
    expect(items).not.toContain('Open with Code');
    expect(items).not.toContain('Open Neovim here');
  });

  it('a file row gets the File verbs only, and running one passes its path', async () => {
    const menu = rowMenuFor(entry('C:\\docs\\note.txt', false));
    const items = labels(menu);
    expect(items).toContain('Open with Code');
    expect(items).not.toContain('Open Git Bash here');
    expect(items).not.toContain('Open with Code (WSL)');
    expect(items).not.toContain('Open with Zed');
    const verb = menu.find((i) => i.kind === 'item' && i.label === 'Open with Code');
    if (verb?.kind === 'item') await verb.run();
    expect(run.verb).toHaveBeenCalledWith('VSCode', 'file', 'C:\\docs\\note.txt');
  });

  it('the background gets its own verbs and a WSL command only inside a distro', async () => {
    tabs.active.location = pathLocation('C:\\docs');
    let items = labels(backgroundMenuFor());
    expect(items).toContain('Open Neovim here');
    expect(items).not.toContain('Open with Code (WSL)');
    tabs.active.location = pathLocation('\\\\wsl.localhost\\Ubuntu\\home\\alex');
    const menu = backgroundMenuFor();
    items = labels(menu);
    expect(items).toContain('Open with Code (WSL)');
    const cmd = menu.find((i) => i.kind === 'item' && i.label === 'Open with Code (WSL)');
    if (cmd?.kind === 'item') await cmd.run();
    expect(run.custom).toHaveBeenCalledWith(
      'code',
      ['--remote', 'wsl+Ubuntu', '/home/alex'],
      '\\\\wsl.localhost\\Ubuntu\\home',
    );
  });
});

/**
 * Right-clicking the empty space is the gesture people reach for to sort and group — Explorer
 * has always answered it. Trove's answer was nothing at all, which is why a built, working
 * "Group by date" went unfound for weeks: "you are never grouping with this week, this month".
 */
describe('the background menu, as the way sort and group are found', () => {
  beforeEach(() => {
    shellVerbs.verbs = [];
    settings.customCommands = [];
    settings.folderViews = [];
    settings.sortKey = 'name';
    settings.sortDir = 'asc';
    settings.groupKey = null;
    tabs.active.location = pathLocation('C:\\docs');
  });

  it('hangs Sort by and Group by off it as flyouts, with the same rows as the toolbar', () => {
    const menu = backgroundMenuFor();
    const sort = flyout(menu, 'sort-by');
    const group = flyout(menu, 'group-by');
    expect(sort.label).toBe('Sort by');
    expect(group.label).toBe('Group by');
    expect(labels(sort.items)).toEqual([
      'Name',
      'Date modified',
      'Date created',
      'Type',
      'Size',
      'Dimensions',
      'Ascending',
      'Descending',
    ]);
    expect(labels(group.items)).toEqual([
      'Name',
      'Date modified',
      'Date created',
      'Type',
      'Size',
      '(None)',
    ]);
    // two rows, not nine: the flyouts are what keeps an already long menu short
    expect(labels(menu).length).toBeLessThanOrEqual(14);
  });

  it('shows the sort key, the direction and the group key that are on right now', () => {
    tabs.active.sortBy('size'); // a size column opens largest-first
    tabs.active.groupBy('ext');
    const menu = backgroundMenuFor();
    expect(checkedLabels(flyout(menu, 'sort-by').items)).toEqual(['Size', 'Descending']);
    expect(checkedLabels(flyout(menu, 'group-by').items)).toEqual(['Type']);
  });

  it('offers (None) under Group by, so grouping can be turned back off', () => {
    tabs.active.groupBy('modifiedMs');
    expect(tabs.active.groupKey).toBe('modifiedMs');
    rowNamed(flyout(backgroundMenuFor(), 'group-by').items, '(None)').run();
    expect(tabs.active.groupKey).toBeNull();
    expect(checkedLabels(flyout(backgroundMenuFor(), 'group-by').items)).toEqual(['(None)']);
  });

  it('writes the folder its own view and leaves the global default alone', () => {
    rowNamed(flyout(backgroundMenuFor(), 'group-by').items, 'Type').run();
    rowNamed(flyout(backgroundMenuFor(), 'sort-by').items, 'Descending').run();
    expect([tabs.active.groupKey, tabs.active.sortDir]).toEqual(['ext', 'desc']);
    // 59cd76c moved this off the globals; writing settings.* here would put that bug back
    expect([settings.groupKey, settings.sortKey, settings.sortDir]).toEqual([null, 'name', 'asc']);
    expect(settings.folderViews).toHaveLength(1);
    expect(settings.folderViews[0].groupKey).toBe('ext');
    expect(settings.folderViews[0].sortDir).toBe('desc');
  });

  it('still sorts on a place, where the choice has no folder to live in', () => {
    tabs.active.location = HOME;
    const menu = backgroundMenuFor();
    rowNamed(flyout(menu, 'sort-by').items, 'Date modified').run();
    expect(tabs.active.sortKey).toBe('modifiedMs');
    // no folder to file it under, so a place's choice is the global one — as the toolbar does
    expect(settings.sortKey).toBe('modifiedMs');
    expect(settings.folderViews).toHaveLength(0);
  });
});

describe('verbIconPath', () => {
  it('takes the file out of a registry Icon value, quotes and index and all', () => {
    expect(verbIconPath(String.raw`C:\code.exe,0`)).toBe(String.raw`C:\code.exe`);
    expect(verbIconPath(String.raw`"C:\Program Files\VLC\vlc.exe",0`)).toBe(
      String.raw`C:\Program Files\VLC\vlc.exe`,
    );
    expect(verbIconPath(String.raw`C:\apps\thing.ico`)).toBe(String.raw`C:\apps\thing.ico`);
    expect(verbIconPath(String.raw`\\server\share\app.exe`)).toBe(
      String.raw`\\server\share\app.exe`,
    );
  });

  it('drops what the shell protocol would draw wrong, so the slot stays blank', () => {
    // a non-zero index is a resource inside the file, not the file's own icon
    expect(verbIconPath(String.raw`C:\Windows\system32\shell32.dll,-16`)).toBeUndefined();
    // only Rust can expand these
    expect(verbIconPath(String.raw`%SystemRoot%\system32\shell32.dll,0`)).toBeUndefined();
    expect(verbIconPath('notepad.exe')).toBeUndefined(); // not absolute
    expect(verbIconPath(null)).toBeUndefined();
    expect(verbIconPath('  ')).toBeUndefined();
  });
});

// Plan 19, 2.4: the row menu's hints are getters, so they follow the style live.
// Nothing injected → a Windows host.
describe('row menu hints follow the "Coming from" style', () => {
  afterEach(() => {
    comingFrom.choice = 'native';
  });

  const deleteHint = () => {
    const row = rowMenuFor(entry('C:\\docs\\note.txt', false)).find((i) => i.key === 'delete');
    return row?.kind === 'item' ? row.shortcut : undefined;
  };

  it('Delete shows Ctrl+Backspace under Mac style and Delete under Windows style', () => {
    comingFrom.choice = 'mac';
    expect(deleteHint()).toBe('Ctrl+Backspace');
    comingFrom.choice = 'windows';
    expect(deleteHint()).toBe('Delete');
  });
});

// Seen on a Mac, browsing inside a zip: Copy was greyed though Cmd+C worked there, and
// "Compress to" stayed live in a place that is read-only and has no real paths to compress.
describe('the row menu inside an archive', () => {
  const ZIP = 'C:\\t\\a.zip';
  const inner = `${ZIP}\u0000docs/a.txt`;
  const item = (key: string) => {
    const found = rowMenuFor(entry(inner, false)).find((i) => i.key === key);
    if (!found) throw new Error(`no "${key}" row`);
    return found;
  };
  beforeEach(() => {
    tabs.active.location = archiveLocation(ZIP, 'docs');
    tabs.active.entries = [entry(inner, false)];
    selection.replaceAll([inner]);
  });
  afterEach(() => {
    selection.clear();
    tabs.active.location = pathLocation('C:\\scratch');
    tabs.active.entries = [];
  });

  it('Copy is enabled with an entry selected, greyed with none', () => {
    const copy = item('copy');
    expect(copy.kind === 'item' && copy.enabled?.()).toBe(true);
    selection.clear();
    expect(copy.kind === 'item' && copy.enabled?.()).toBe(false);
  });

  it('"Compress to" is greyed, and so is every format row under it', () => {
    const compress = item('compress-to');
    if (compress.kind !== 'submenu') throw new Error('"Compress to" is not a flyout');
    expect(compress.enabled?.()).toBe(false);
    for (const row of compress.items) expect(row.kind === 'item' && row.enabled?.()).toBe(false);
  });
});

// Seen on Ubuntu and a Mac (plan 15 C.8.7): inside a zip the empty-space menu pinned a nameless
// folder that could not be removed, and "Open in Terminal" stayed live and did nothing.
describe('the empty-space menu inside an archive', () => {
  const ZIP = 'C:\\t\\a.zip';
  const item = (key: string) => {
    const found = backgroundMenuFor().find((i) => i.key === key);
    if (!found || found.kind !== 'item') throw new Error(`no "${key}" row`);
    return found;
  };
  beforeEach(() => {
    tabs.active.location = archiveLocation(ZIP, 'docs');
  });
  afterEach(() => {
    tabs.active.location = pathLocation('C:\\scratch');
  });

  it('offers no Pin, and no Unpin either', () => {
    expect(item('pin').visible?.()).toBe(false);
    expect(item('unpin').visible?.()).toBe(false);
  });

  it('greys out Open in Terminal, and enables it again in a real folder', () => {
    expect(item('terminal').enabled?.()).toBe(false);
    tabs.active.location = pathLocation('C:\\scratch');
    expect(item('terminal').enabled?.()).toBe(true);
    expect(item('pin').visible?.()).toBe(true);
  });
});

// "Open with ▸" on a file's right-click menu (G.61).
describe('the Open with flyout', () => {
  const app = (id: string, name: string, isDefault = false): OpenWithApp => ({
    id,
    name,
    icon: null,
    isDefault,
  });
  const file = (name: string, ext: string | null = 'txt'): FileEntry => ({
    ...entry(`C:\\docs\\${name}`, false),
    ext,
  });
  const flyoutOf = (menu: MenuItem[]) => menu.find((i) => i.key === 'open-with');
  /** the flyout as the person sees it: absent when hidden, else its row labels */
  const shown = (focus: FileEntry, selected: FileEntry[] = [focus]) => {
    tabs.active.entries = [...new Set([focus, ...selected])];
    selection.replaceAll(selected.map((e) => e.path));
    selection.focused = focus.path;
    const found = flyoutOf(rowMenuFor(focus));
    if (found?.kind !== 'submenu') throw new Error('no Open with flyout');
    return found.visible?.() === false ? null : found;
  };

  afterEach(() => {
    selection.clear();
    comingFrom.choice = 'native';
    tabs.active.entries = [];
    openWith.apps = [];
  });

  it('is labelled "Open With" under Mac style and "Open with" otherwise', () => {
    comingFrom.choice = 'mac';
    expect(shown(file('a.txt'))?.label).toBe('Open With');
    comingFrom.choice = 'windows';
    expect(shown(file('a.txt'))?.label).toBe('Open with');
  });

  it('sits right after Open', () => {
    const menu = rowMenuFor(file('a.txt'));
    expect(menu.findIndex((i) => i.key === 'open-with')).toBe(
      menu.findIndex((i) => i.key === 'open') + 1,
    );
  });

  it('is hidden for a folder, an archive member and a mixed selection', () => {
    expect(shown(entry('C:\\docs\\photos', true))).toBeNull();
    const inner = 'C:\\t\\a.zip\u0000docs/a.txt';
    expect(shown(entry(inner, false))).toBeNull();
    expect(shown(file('a.txt'), [file('a.txt'), file('b.png', 'png')])).toBeNull();
    expect(shown(file('a.txt'), [file('a.txt'), file('c.TXT', 'TXT')])).not.toBeNull();
  });

  it('never asks the OS for apps for an archive member (MAC-C.8.7: that path crashed macOS)', () => {
    vi.mocked(openWithApps).mockClear();
    rowMenuFor(entry('/Users/j/z.zip\u0000src/a.txt', false));
    expect(openWithApps).not.toHaveBeenCalled();
    rowMenuFor(file('a.txt'));
    expect(openWithApps).toHaveBeenCalledWith('C:\\docs\\a.txt');
  });

  it('lists the default app first, marked, with the chooser last on Windows', () => {
    const rows = openWithItems(
      [app('a', 'Notepad'), app('b', 'Code', true)],
      false,
      'C:\\docs\\a.txt',
      ['C:\\docs\\a.txt'],
      true,
    );
    expect(labels(rows)).toEqual(['Code (default)', 'Notepad', 'Choose another app…']);
  });

  it('has no chooser off Windows', () => {
    const rows = openWithItems(
      [app('/Applications/X.app', 'X')],
      false,
      '/a.txt',
      ['/a.txt'],
      false,
    );
    expect(labels(rows)).toEqual(['X']);
  });

  // plan 10 B.5: the Mac flyout drew every app with a blank icon slot. `keyedIcon` answers a
  // `.app` with a QuickLook thumb, and the flyout only took a shell icon, so it dropped it.
  it('draws a Mac app from its bundle thumb, the picture the Applications place shows', () => {
    const rows = openWithItems(
      [app('/Applications/TextEdit.app', 'TextEdit', true)],
      false,
      '/a.txt',
      ['/a.txt'],
      false,
      true,
      true,
    );
    const row = rows[0];
    expect(row.kind === 'item' && row.iconSrc).toBe(thumbUrl('/Applications/TextEdit.app', 48));
  });

  it('draws an Ubuntu app from its .desktop icon, as before', () => {
    const id = '/usr/share/applications/org.gnome.TextEditor.desktop';
    const rows = openWithItems(
      [app(id, 'Text Editor')],
      false,
      '/a.txt',
      ['/a.txt'],
      false,
      true,
      false,
    );
    const row = rows[0];
    expect(row.kind === 'item' && row.iconSrc).toBe(iconUrl(`file/${id}`, 16));
  });

  it('shows a greyed Loading… and a greyed No apps found', () => {
    for (const [loading, text] of [
      [true, 'Loading…'],
      [false, 'No apps found'],
    ] as const) {
      const rows = openWithItems([], loading, '/a.txt', ['/a.txt'], false);
      expect(labels(rows)).toEqual([text]);
      const row = rows[0];
      expect(row.kind === 'item' && row.enabled?.()).toBe(false);
    }
  });
});

// Explorer's "Open in Terminal" on a folder itself, not only on empty space.
describe('Open in Terminal on a row', () => {
  const termRow = (focus: FileEntry, selected: FileEntry[] = [focus]) => {
    tabs.active.entries = [...new Set([focus, ...selected])];
    selection.replaceAll(selected.map((e) => e.path));
    selection.focused = focus.path;
    const row = rowMenuFor(focus).find((i) => i.key === 'open-terminal');
    return row?.kind === 'item' && row.visible?.() !== false ? row : null;
  };

  afterEach(() => {
    selection.clear();
    tabs.active.entries = [];
  });

  it('a folder offers it and opens the terminal in that folder', async () => {
    const dir = entry('C:\\docs\\photos', true);
    const row = termRow(dir);
    expect(row?.label).toBe('Open in Terminal');
    vi.mocked(openTerminal).mockClear();
    await row?.run();
    expect(openTerminal).toHaveBeenCalledExactlyOnceWith('C:\\docs\\photos');
  });

  it('a file does not offer it', () => {
    expect(termRow(entry('C:\\docs\\a.txt', false))).toBeNull();
  });

  it('several selected folders do not offer it', () => {
    const a = entry('C:\\docs\\a', true);
    const b = entry('C:\\docs\\b', true);
    expect(termRow(a, [a, b])).toBeNull();
  });
});

// Seen on the Windows screen 2026-10-21: inside a zip the right-click menus still offered the
// person's own commands ("Open with Neovim") and Windows' verbs ("Open Git Bash here") as live
// rows, each one a program run on a path that is not on the disk. Same rule as Terminal: greyed.
describe('the verbs and custom commands inside an archive', () => {
  const ZIP = 'C:\\t\\a.zip';
  const innerFile = `${ZIP}\u0000docs/a.txt`;
  const innerDir = `${ZIP}\u0000docs/sub`;
  const tail = (items: MenuItem[]) =>
    items.filter((i) => i.kind === 'item' && /^(verb|cmd):/.test(i.key));
  beforeEach(() => {
    shellVerbs.verbs = [
      { key: 'VSCode', label: 'Open with Code', command: 'code "%1"', icon: null, scope: 'file' },
      {
        key: 'git_shell',
        label: 'Open Git Bash here',
        command: 'bash',
        icon: null,
        scope: 'directory',
      },
      {
        key: 'git_gui',
        label: 'Open Git GUI here',
        command: 'gui',
        icon: null,
        scope: 'directory-background',
      },
    ];
    settings.customCommands = [
      {
        id: 'nvim',
        label: 'Open with Neovim',
        program: 'nvim',
        args: '%path%',
        scope: ['file', 'folder', 'background'],
      },
    ];
    run.verb.mockClear();
    run.custom.mockClear();
    tabs.active.location = archiveLocation(ZIP, 'docs');
  });
  afterEach(() => {
    tabs.active.location = pathLocation('C:\\scratch');
  });

  it('greys every verb and command on a file and a folder inside the archive, and runs none', async () => {
    for (const e of [entry(innerFile, false), entry(innerDir, true)]) {
      const rows = tail(rowMenuFor(e));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        if (row.kind !== 'item') continue;
        expect(row.enabled?.()).toBe(false);
        await row.run();
      }
    }
    expect(run.verb).not.toHaveBeenCalled();
    expect(run.custom).not.toHaveBeenCalled();
  });

  it('greys every verb and command on the empty space inside the archive, and runs none', async () => {
    const rows = tail(backgroundMenuFor());
    expect(rows.map((r) => (r.kind === 'item' ? r.label : ''))).toEqual([
      'Open Git GUI here',
      'Open with Neovim',
    ]);
    for (const row of rows) {
      if (row.kind !== 'item') continue;
      expect(row.enabled?.()).toBe(false);
      await row.run();
    }
    expect(run.verb).not.toHaveBeenCalled();
    expect(run.custom).not.toHaveBeenCalled();
  });

  it('leaves them live in a real folder', () => {
    tabs.active.location = pathLocation('C:\\docs');
    for (const row of [
      ...tail(backgroundMenuFor()),
      ...tail(rowMenuFor(entry('C:\\docs\\note.txt', false))),
    ]) {
      expect(row.kind === 'item' && row.enabled?.() !== false).toBe(true);
    }
  });
});

describe('the OneDrive items on a row (plan 05 5.4)', () => {
  const cloud = (name: string, cloudState?: FileEntry['cloudState']): FileEntry => ({
    ...entry(`C:\\OneDrive\\${name}`, false),
    cloudState,
  });
  const item = (focus: FileEntry, selected: FileEntry[], key: string) => {
    tabs.active.location = pathLocation('C:\\OneDrive');
    tabs.active.entries = [...new Set([focus, ...selected])];
    selection.replaceAll(selected.map((e) => e.path));
    selection.focused = focus.path;
    const found = rowMenuFor(focus).find((i) => i.key === key);
    if (found?.kind !== 'item') throw new Error(`no ${key} row`);
    return found;
  };

  afterEach(() => {
    selection.clear();
    tabs.active.entries = [];
    vi.restoreAllMocks();
  });

  it('are hidden on a file no cloud provider marked', () => {
    const plain = cloud('plain.txt');
    expect(item(plain, [plain], 'keep-on-device').visible?.()).toBe(false);
    expect(item(plain, [plain], 'free-up-space').visible?.()).toBe(false);
  });

  it('greys out what is already true: Keep on a pinned file, Free up space on an online one', () => {
    const pinned = cloud('kept.docx', 'pinned');
    const online = cloud('far.docx', 'online');
    expect(item(pinned, [pinned], 'keep-on-device').enabled?.()).toBe(false);
    expect(item(pinned, [pinned], 'free-up-space').enabled?.()).toBe(true);
    expect(item(online, [online], 'free-up-space').enabled?.()).toBe(false);
    expect(item(online, [online], 'keep-on-device').enabled?.()).toBe(true);
    // a mixed selection can do both
    expect(item(pinned, [pinned, online], 'keep-on-device').enabled?.()).toBe(true);
  });

  it('run the pin with keep true or false, on the selected cloud rows only', async () => {
    const local = cloud('here.docx', 'local');
    const plain = cloud('plain.txt');
    const spy = vi.spyOn(actions, 'setCloudPin').mockResolvedValue();
    await item(local, [local, plain], 'keep-on-device').run();
    expect(spy).toHaveBeenLastCalledWith(true);
    await item(local, [local, plain], 'free-up-space').run();
    expect(spy).toHaveBeenLastCalledWith(false);
    expect(actions.cloudSelection.map((e) => e.name)).toEqual(['here.docx']);
  });
});

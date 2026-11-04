import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeSettings, readSettings, writeSettings } from '$lib/api/settings';
import { changedFields, sanitize, settings } from './settings.svelte';

vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => null),
  writeSettings: vi.fn(async () => {}),
  mergeSettings: vi.fn(async () => {}),
}));

const written = vi.mocked(writeSettings);

describe('settings sanitize', () => {
  it('the palette preview is on at 320 px by default, its width clamped (plan 04 4.4)', () => {
    expect(sanitize({}).palettePreview).toBe(true);
    expect(sanitize({}).palettePreviewWidth).toBe(320);
    expect(sanitize({ palettePreview: false }).palettePreview).toBe(false);
    expect(sanitize({ palettePreview: 'no' }).palettePreview).toBe(true);
    expect(sanitize({ palettePreviewWidth: 360.4 }).palettePreviewWidth).toBe(360);
    expect(sanitize({ palettePreviewWidth: 10 }).palettePreviewWidth).toBe(240);
    expect(sanitize({ palettePreviewWidth: 9000 }).palettePreviewWidth).toBe(400);
    expect(sanitize({ palettePreviewWidth: 'wide' }).palettePreviewWidth).toBe(320);
  });

  // The chord is stored canonical and lowercase: two spellings of one chord would compare
  // unequal, and the "already registered" check would miss.
  it('normalises the spotlight chord and falls back when it is unusable', () => {
    expect(sanitize({ spotlightHotkey: '  Ctrl+Shift+P  ' }).spotlightHotkey).toBe('ctrl+shift+p');
    expect(sanitize({ spotlightHotkey: '' }).spotlightHotkey).toBe('alt+space');
    expect(sanitize({ spotlightHotkey: '   ' }).spotlightHotkey).toBe('alt+space');
    expect(sanitize({ spotlightHotkey: 42 }).spotlightHotkey).toBe('alt+space');
  });

  // Joy's pick 2026-10-23: a Linux box with no chord saved starts on Ctrl+Alt+Space (GNOME holds
  // Alt+Space), but a chord already in settings.json is the person's and is kept as written —
  // including alt+space, which an older install saved and cannot be told apart from a choice.
  it('defaults to ctrl+alt+space on Linux and keeps a saved chord', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'x' } });
    try {
      expect(sanitize(null).spotlightHotkey).toBe('ctrl+alt+space');
      expect(sanitize({ spotlightHotkey: '' }).spotlightHotkey).toBe('ctrl+alt+space');
      expect(sanitize({ spotlightHotkey: 'alt+space' }).spotlightHotkey).toBe('alt+space');
      expect(sanitize({ spotlightHotkey: 'ctrl+shift+p' }).spotlightHotkey).toBe('ctrl+shift+p');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // The template is handed straight to the OS's "open a URL" verb, so a value that cannot
  // build a web address must never survive the read — it falls back to the default instead.
  it('keeps a search template only when it has %s and an http(s) scheme', () => {
    const d = 'https://www.google.com/search?q=%s';
    const t = (raw: unknown) => sanitize({ spotlightSearchTemplate: raw }).spotlightSearchTemplate;
    expect(t('https://duckduckgo.com/?q=%s')).toBe('https://duckduckgo.com/?q=%s');
    expect(t('  http://localhost:8080/?q=%s  ')).toBe('http://localhost:8080/?q=%s');
    expect(t('HTTPS://Example.com/?q=%s')).toBe('HTTPS://Example.com/?q=%s');
    // no %s: nowhere to put the query
    expect(t('https://www.google.com/')).toBe(d);
    // not http(s): a scheme the OS would hand to something that is not a browser
    expect(t('javascript:alert(1)?q=%s')).toBe(d);
    expect(t('file:///C:/?q=%s')).toBe(d);
    expect(t('www.google.com/search?q=%s')).toBe(d);
    // not a string at all, or empty
    expect(t(42)).toBe(d);
    expect(t(undefined)).toBe(d);
    expect(t('')).toBe(d);
  });

  it('accentSource is sapphire unless the file says system', () => {
    const a = (raw: unknown) => sanitize({ accentSource: raw }).accentSource;
    expect(a('system')).toBe('system');
    expect(a('sapphire')).toBe('sapphire');
    for (const bad of ['SYSTEM', 'teal', '', 1, true, null, undefined]) {
      expect(a(bad)).toBe('sapphire');
    }
  });

  // A file written before the setting existed has no `theme`, and must keep following the OS.
  it('theme is system unless the file says light or dark', () => {
    const t = (raw: unknown) => sanitize({ theme: raw }).theme;
    expect(t('light')).toBe('light');
    expect(t('dark')).toBe('dark');
    for (const bad of ['Dark', 'blue', '', 1, null, undefined]) expect(t(bad)).toBe('system');
    expect(sanitize(null).theme).toBe('system');
  });

  it('null or garbage gives the defaults', () => {
    expect(sanitize(null)).toEqual({
      view: 'grid',
      columnWidths: {},
      columns: ['name', 'modifiedMs', 'ext', 'size'],
      sortKey: 'name',
      spotlightHotkey: 'alt+space',
      spotlightSearchTemplate: 'https://www.google.com/search?q=%s',
      sortDir: 'asc',
      groupKey: 'modifiedMs',
      foldersFirst: false,
      showHidden: false,
      accentSource: 'sapphire',
      theme: 'system',
      pins: [],
      paneWidth: 320,
      terminalHeight: 240,
      terminalFollow: true,
      defaultHandler: { applied: false, exePath: '' },
      sidebarCollapsed: [],
      sidebarWidth: 248,
      recentFolders: [],
      keepRunning: false,
      startWithWindows: false,
      restoreTabs: true,
      archivesOpenInside: true,
      startPlace: 'home',
      openTabs: [],
      hiddenKnownFolders: [],
      hiddenSidebarKeys: [],
      iconSize: 96,
      zoom: 1,
      customCommands: [],
      folderViews: [],
      tabSets: [],
      previewOpen: false,
      palettePreview: true,
      palettePreviewWidth: 320,
      comingFrom: 'native',
      folderSizes: 'local',
      indexOn: true,
      indexDrivesOff: [],
      indexSkipFolders: [],
      navPane: true,
      itemCheckboxes: false,
      compactView: false,
      showExtensions: true,
      shortcutOverrides: {},
    });
    expect(sanitize('nope')).toEqual(sanitize(null));
  });

  it('archivesOpenInside: on by default, a non-boolean falls back to on', () => {
    expect(sanitize({ archivesOpenInside: 'no' }).archivesOpenInside).toBe(true);
    expect(sanitize({ archivesOpenInside: false }).archivesOpenInside).toBe(false);
  });

  it('keeps known fields with the right types and drops the rest', () => {
    const s = sanitize({
      view: 'grid',
      columnWidths: { name: 300, size: 'wide', ext: 5, modifiedMs: 160 },
      showHidden: 'yes',
      pins: ['C:\\a', 7, 'D:\\b'],
      paneWidth: 5000,
      terminalHeight: 300,
      terminalFollow: false,
      defaultHandler: { applied: true, exePath: 'D:\\apps\\explorer.exe' },
      sidebarCollapsed: ['this-pc', 3],
      sidebarWidth: 300,
      recentFolders: ['D:\\work', '', 9],
      keepRunning: true,
      startWithWindows: 'yes',
      restoreTabs: false,
      archivesOpenInside: false,
      startPlace: 'home',
      openTabs: ['C:\\a', '', 4, 'D:\\b'],
      hiddenKnownFolders: ['downloads', 'attic', 7],
      future: { anything: true },
    });
    expect(s).toEqual({
      view: 'grid',
      columnWidths: { name: 300, ext: 60, modifiedMs: 160 },
      columns: ['name', 'modifiedMs', 'ext', 'size'],
      sortKey: 'name',
      spotlightHotkey: 'alt+space',
      spotlightSearchTemplate: 'https://www.google.com/search?q=%s',
      sortDir: 'asc',
      groupKey: null,
      foldersFirst: false,
      showHidden: false,
      accentSource: 'sapphire',
      theme: 'system',
      pins: ['C:\\a', 'D:\\b'],
      paneWidth: 320,
      terminalHeight: 300,
      terminalFollow: false,
      defaultHandler: { applied: true, exePath: 'D:\\apps\\explorer.exe' },
      sidebarCollapsed: ['drives'],
      sidebarWidth: 300,
      recentFolders: ['D:\\work'],
      keepRunning: true,
      startWithWindows: false,
      restoreTabs: false,
      archivesOpenInside: false,
      startPlace: 'home',
      openTabs: ['C:\\a', 'D:\\b'],
      hiddenKnownFolders: ['downloads'],
      hiddenSidebarKeys: [],
      iconSize: 48,
      zoom: 1,
      customCommands: [],
      folderViews: [],
      tabSets: [],
      previewOpen: false,
      palettePreview: true,
      palettePreviewWidth: 320,
      comingFrom: 'native',
      folderSizes: 'local',
      indexOn: true,
      indexDrivesOff: [],
      indexSkipFolders: [],
      navPane: true,
      itemCheckboxes: false,
      compactView: false,
      showExtensions: true,
      shortcutOverrides: {},
    });
  });

  // Plan 12 D5/D6: cards by default for a NEW install only. "New" is: no settings file, so
  // `raw` is not a record. A file that exists falls back to the OLD defaults, key by key.
  it('a new install (no file) opens as grouped Medium cards', () => {
    const s = sanitize(null);
    expect([s.view, s.iconSize, s.groupKey]).toEqual(['grid', 96, 'modifiedMs']);
  });

  it('an old file keeps its saved view and grouping untouched', () => {
    const s = sanitize({ view: 'details', iconSize: 256, groupKey: 'size', previewOpen: true });
    expect([s.view, s.iconSize, s.groupKey, s.previewOpen]).toEqual(['details', 256, 'size', true]);
    const none = sanitize({ view: 'list', groupKey: null });
    expect([none.view, none.groupKey]).toEqual(['list', null]);
  });

  // Plan 19, 1.2.1: "I'm coming from" — a missing key, an old file or junk is 'native'
  it('comingFrom keeps the three styles and turns anything else into native', () => {
    expect(sanitize(null).comingFrom).toBe('native');
    expect(sanitize({}).comingFrom).toBe('native');
    for (const style of ['windows', 'mac', 'linux'] as const) {
      expect(sanitize({ comingFrom: style }).comingFrom).toBe(style);
    }
    for (const junk of ['beos', 'native', 'Mac', 7, null, { os: 'mac' }]) {
      expect(sanitize({ comingFrom: junk }).comingFrom).toBe('native');
    }
  });

  // Plan 21 A (Joy, Q3): folder sizes on for local drives, for a new install and an old file
  it('folderSizes defaults to local drives and keeps only the three choices', () => {
    expect(sanitize(null).folderSizes).toBe('local');
    expect(sanitize({}).folderSizes).toBe('local');
    for (const choice of ['off', 'local', 'everywhere'] as const) {
      expect(sanitize({ folderSizes: choice }).folderSizes).toBe(choice);
    }
    for (const junk of ['on', true, 0, null]) {
      expect(sanitize({ folderSizes: junk }).folderSizes).toBe('local');
    }
  });

  it('an old file missing these keys keeps the old defaults, not the new-install ones', () => {
    for (const old of [{}, { pins: ['D:\\work'] }, { view: 'kanban', iconSize: 64 }]) {
      const s = sanitize(old);
      expect([s.view, s.iconSize, s.groupKey, s.previewOpen]).toEqual(['details', 48, null, false]);
    }
  });

  // Joy's real file at %APPDATA%\com.joyahmed.trove\settings.json has no `folderViews` — it was
  // written before per-folder view state existed. Its absence must be silent, and everything
  // else in it must come through untouched.
  it('a settings file written before per-folder views existed loads with none', () => {
    const old = {
      groupKey: null,
      sortKey: 'modifiedMs',
      sortDir: 'desc',
      view: 'grid',
      iconSize: 256,
      startPlace: 'this-pc',
      recentFolders: ['E:\\Tainment'],
    };
    const s = sanitize(old);
    expect(s.folderViews).toEqual([]);
    expect([s.groupKey, s.sortKey, s.sortDir]).toEqual([null, 'modifiedMs', 'desc']);
    expect([s.view, s.iconSize, s.startPlace]).toEqual(['grid', 256, 'this-pc']);
  });

  // A file from before the sidebar redesign: This PC was a node folded under 'this-pc', and
  // there was no `hiddenSidebarKeys`. Pins, hidden folders and commands must come through.
  it('a settings file written before the sidebar redesign keeps its pins and folds Drives', () => {
    const old = {
      pins: ['D:\\work', String.raw`\\wsl.localhost\Ubuntu\home\alex`],
      hiddenKnownFolders: ['music'],
      customCommands: [{ id: 'a', label: 'Code (WSL)', program: 'code', args: '', scope: ['wsl'] }],
      sidebarCollapsed: ['this-pc', 'quick-access', 'drives'],
      startPlace: 'this-pc',
    };
    const s = sanitize(old);
    expect(s.pins).toEqual(old.pins);
    expect(s.hiddenKnownFolders).toEqual(['music']);
    expect(s.customCommands).toEqual(old.customCommands);
    expect(s.sidebarCollapsed).toEqual(['drives', 'quick-access']);
    expect(s.hiddenSidebarKeys).toEqual([]);
    expect(s.startPlace).toBe('this-pc');
  });

  it('keeps only the sidebar keys it knows', () => {
    expect(
      sanitize({ hiddenSidebarKeys: ['home', 'downloads', 7, 'recycle-bin', 'home'] })
        .hiddenSidebarKeys,
    ).toEqual(['home', 'recycle-bin']);
    expect(sanitize({ hiddenSidebarKeys: 'home' }).hiddenSidebarKeys).toEqual([]);
  });

  it('checks the stored per-folder views like every other field', () => {
    expect(sanitize({ folderViews: 'nope' }).folderViews).toEqual([]);
    expect(
      sanitize({
        folderViews: [
          { path: 'C:\\Users\\alex\\Downloads\\', groupKey: 'modifiedMs', sortKey: 'name' },
          { path: 'E:\\a', groupKey: 'attic', sortKey: 'attic' },
        ],
      }).folderViews,
    ).toEqual([
      {
        path: 'c:\\users\\alex\\downloads',
        groupKey: 'modifiedMs',
        sortKey: 'name',
        sortDir: 'asc',
        view: null,
        iconSize: null,
      },
    ]);
  });

  it('keeps a stored column list in the person’s order, with Name forced in first (G.59)', () => {
    // a hand-edited file, and one written before Date created existed
    expect(sanitize({ columns: ['size', 'createdMs', 'nope'] }).columns).toEqual([
      'name',
      'size',
      'createdMs',
    ]);
    // a dragged order survives a restart; a repeat or a Name out of place is cleaned
    expect(sanitize({ columns: ['name', 'size', 'ext', 'size', 'modifiedMs'] }).columns).toEqual([
      'name',
      'size',
      'ext',
      'modifiedMs',
    ]);
    expect(sanitize({ columns: ['ext', 'name'] }).columns).toEqual(['name', 'ext']);
    expect(sanitize({ columns: [] }).columns).toEqual(['name']);
    expect(sanitize({ columns: 'size' }).columns).toEqual(['name', 'modifiedMs', 'ext', 'size']);
    // the Folder column belongs to search results; it is never a stored choice
    expect(sanitize({ columns: ['path'] }).columns).toEqual(['name']);
  });

  it('keeps a stored sort, and falls back on a column that does not exist', () => {
    expect(sanitize({ sortKey: 'createdMs', sortDir: 'desc' })).toMatchObject({
      sortKey: 'createdMs',
      sortDir: 'desc',
    });
    expect(sanitize({ sortKey: 'nope', sortDir: 'sideways' })).toMatchObject({
      sortKey: 'name',
      sortDir: 'asc',
    });
  });

  it('keeps a stored grouping; the Folder column is never one', () => {
    expect(sanitize({ groupKey: 'size' }).groupKey).toBe('size');
    // the Folder column belongs to search results, as in `columns` above
    expect(sanitize({ groupKey: 'path' }).groupKey).toBeNull();
    expect(sanitize({ groupKey: 'nope' }).groupKey).toBeNull();
  });

  it('keeps well-formed custom commands and drops the rest', () => {
    const s = sanitize({
      customCommands: [
        {
          id: 'a',
          label: ' Code (WSL) ',
          program: 'code',
          args: '%linuxpath%',
          scope: ['wsl', 'nope'],
        },
        { id: '', label: 'x', program: 'x' },
        { id: 'b', label: 'no program', program: '  ' },
        { id: 'c', label: '', program: 'zed', args: 7, scope: 'file' },
        'garbage',
      ],
    });
    expect(s.customCommands).toEqual([
      { id: 'a', label: 'Code (WSL)', program: 'code', args: '%linuxpath%', scope: ['wsl'] },
      { id: 'c', label: 'zed', program: 'zed', args: '', scope: [] },
    ]);
  });

  it('unpinning a built-in hides it; pinning its path again shows it instead of duplicating', () => {
    settings.hiddenKnownFolders = [];
    settings.pins = [];
    settings.toggleKnownFolder('downloads');
    expect(settings.isKnownFolderHidden('downloads')).toBe(true);
    settings.togglePin('C:\\Users\\alex\\Downloads', 'downloads');
    expect(settings.hiddenKnownFolders).toEqual([]);
    expect(settings.pins).toEqual([]);
    settings.toggleKnownFolder('music');
    settings.toggleKnownFolder('videos');
    settings.showDefaultFolders();
    expect(settings.hiddenKnownFolders).toEqual([]);
  });

  it('hiding Home leaves the start place alone; restore shows it and every built-in again', () => {
    settings.hiddenKnownFolders = [];
    settings.hiddenSidebarKeys = [];
    settings.startPlace = 'home';
    settings.toggleSidebarKey('home');
    settings.toggleKnownFolder('downloads');
    expect(settings.isSidebarKeyHidden('home')).toBe(true);
    expect(settings.startPlace).toBe('home');
    settings.restoreSidebarDefaults();
    expect(settings.isSidebarKeyHidden('home')).toBe(false);
    expect(settings.hiddenKnownFolders).toEqual([]);
  });

  it('caps the remembered tabs at twenty', () => {
    const many = Array.from({ length: 25 }, (_, i) => `C:\\t${i}`);
    expect(sanitize({ openTabs: many }).openTabs).toHaveLength(20);
  });

  it('keeps the sidebar width inside its bounds', () => {
    expect(sanitize({ sidebarWidth: 100 }).sidebarWidth).toBe(248);
    expect(sanitize({ sidebarWidth: 900 }).sidebarWidth).toBe(248);
  });

  it('clamps a stored column width to the column minimum and drops unknown keys', () => {
    const { columnWidths } = sanitize({
      columnWidths: { name: 40, size: 9999, path: 130.4, bogus: 200, ext: Infinity },
    });
    expect(columnWidths).toEqual({ name: 120, size: 2000, path: 130 });
  });

  it('a malformed defaultHandler falls back field by field', () => {
    expect(sanitize({ defaultHandler: 'yes' }).defaultHandler).toEqual({
      applied: false,
      exePath: '',
    });
    expect(
      sanitize({ defaultHandler: { applied: 'true', exePath: 'C:\\x.exe' } }).defaultHandler,
    ).toEqual({ applied: false, exePath: 'C:\\x.exe' });
  });

  it('keeps the terminal height inside its bounds', () => {
    expect(sanitize({ terminalHeight: 50 }).terminalHeight).toBe(240);
    expect(sanitize({ terminalHeight: 9000 }).terminalHeight).toBe(240);
  });

  it('keeps a pane width inside its bounds', () => {
    expect(sanitize({ paneWidth: 400 }).paneWidth).toBe(400);
    expect(sanitize({ paneWidth: 10 }).paneWidth).toBe(320);
  });

  it('an unknown view falls back to details', () => {
    expect(sanitize({ view: 'kanban' }).view).toBe('details');
  });

  it('keeps the icon size to the three the grid offers and the zoom inside its grid', () => {
    expect(sanitize({ iconSize: 96 }).iconSize).toBe(96);
    expect(sanitize({ iconSize: 64 }).iconSize).toBe(48);
    expect(sanitize({ zoom: 1.5 }).zoom).toBe(1.5);
    expect(sanitize({ zoom: 0.3 }).zoom).toBe(0.8);
    expect(sanitize({ zoom: 7 }).zoom).toBe(2);
    expect(sanitize({ zoom: 1.24 }).zoom).toBe(1.2);
    expect(sanitize({ zoom: 'big' }).zoom).toBe(1);
  });

  it('opens to Home unless the person chose This PC', () => {
    expect(sanitize({ startPlace: 'this-pc' }).startPlace).toBe('this-pc');
    expect(sanitize({ startPlace: 'desktop' }).startPlace).toBe('home');
  });
});

// The write is debounced by SAVE_DELAY_MS (400). On the SHIPPED defaults — `keepRunning: false`,
// default handler unapplied — closing the window destroys the webview, and a destroyed webview's
// timers never fire: a tab opened or a column dragged inside those 400 ms was silently lost.
// Fake timers that are never advanced are exactly that webview: the timer is pending and will
// never run. `flush` is the way the pending write gets out, and the close path must await it.
describe('settings save', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    written.mockReset();
    written.mockResolvedValue(undefined);
    settings.loaded = true;
  });

  afterEach(async () => {
    // drain anything a test left pending so it cannot write during the next one
    await settings.flush();
    vi.useRealTimers();
  });

  it('flushes a change made inside the debounce window — the close path must not lose it', async () => {
    settings.openTabs = ['C:\\just-opened'];
    settings.scheduleSave(settings.snapshot());
    // the window closes here: 400 ms have NOT passed, so the debounce has written nothing yet
    expect(written).not.toHaveBeenCalled();

    await settings.flush();

    expect(written).toHaveBeenCalledTimes(1);
    expect(written.mock.calls[0]?.[0]).toMatchObject({ openTabs: ['C:\\just-opened'] });
  });

  it('a flush with nothing pending writes nothing and still resolves', async () => {
    await expect(settings.flush()).resolves.toBeUndefined();
    expect(written).not.toHaveBeenCalled();
    // and again right after a flush that did write: the close path calls it unconditionally
    settings.zoom = 1.3;
    settings.scheduleSave(settings.snapshot());
    await settings.flush();
    expect(written).toHaveBeenCalledTimes(1);
    await settings.flush();
    expect(written).toHaveBeenCalledTimes(1);
  });

  it('keeps the debounce: a burst is still one write, and the timer still fires on its own', async () => {
    for (const px of [200, 210, 220, 248]) {
      settings.setSidebarWidth(px);
      settings.scheduleSave(settings.snapshot());
    }
    expect(written).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(written).toHaveBeenCalledTimes(1);
    expect(written.mock.calls[0]?.[0]).toMatchObject({ sidebarWidth: 248 });
  });

  it('nothing is written before load, flush included', async () => {
    settings.loaded = false;
    settings.showHidden = true;
    settings.scheduleSave(settings.snapshot());
    await settings.flush();
    await vi.advanceTimersByTimeAsync(400);
    expect(written).not.toHaveBeenCalled();
  });

  // Two whole-file writes in flight together are finished by Rust in whichever order its command
  // tasks happen to — so an older snapshot could land last and undo the newer one. `flush` makes
  // that overlap ordinary, which is why the writes are chained.
  it('a flush cannot land behind the write it overtook', async () => {
    const order: string[] = [];
    let finishTheOldWrite = () => {};
    written.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishTheOldWrite = () => {
            order.push('old');
            resolve();
          };
        }),
    );
    written.mockImplementationOnce(async () => void order.push('new'));

    settings.showHidden = false;
    settings.scheduleSave(settings.snapshot());
    await vi.advanceTimersByTimeAsync(400); // the old write is now in flight, and hangs

    settings.showHidden = true;
    settings.scheduleSave(settings.snapshot());
    const flushed = settings.flush();
    finishTheOldWrite();
    await flushed;

    expect(order).toEqual(['old', 'new']);
    expect(written.mock.calls[1]?.[0]).toMatchObject({ showHidden: true });
  });
});

// D6: the Preview pane opens by default on a wide window, on the first run only.
describe('settings load: Preview pane default', () => {
  const loadWith = async (raw: unknown, width: number) => {
    vi.mocked(readSettings).mockResolvedValueOnce(raw as never);
    vi.stubGlobal('innerWidth', width);
    settings.loaded = false;
    await settings.load();
  };
  afterEach(() => vi.unstubAllGlobals());

  it('a first run marks it open at any width — the pane hides itself while too narrow', async () => {
    await loadWith(null, 1400);
    expect(settings.previewOpen).toBe(true);
    // the window is still hidden at load, so the width read here is not its real one
    await loadWith(null, 0);
    expect(settings.previewOpen).toBe(true);
  });

  it('an existing file keeps its own choice, however wide the window', async () => {
    await loadWith({ pins: [] }, 1920);
    expect(settings.previewOpen).toBe(false);
    await loadWith({ previewOpen: true }, 800);
    expect(settings.previewOpen).toBe(true);
  });
});

// A setting changed in a second window: it tells the others (an event) and saves just its fields
// (`mergeSettings`), and a field received from another window is never sent back.
describe('settings across windows', () => {
  const merged = vi.mocked(mergeSettings);

  beforeEach(async () => {
    vi.useFakeTimers();
    written.mockReset();
    written.mockResolvedValue(undefined);
    merged.mockReset();
    merged.mockResolvedValue(undefined);
    vi.mocked(readSettings).mockResolvedValueOnce(null);
    settings.loaded = false;
    await settings.load();
    await settings.flush();
    written.mockClear();
  });

  afterEach(async () => {
    await settings.flush();
    vi.useRealTimers();
  });

  it('changedFields returns only the keys whose value differs', () => {
    const a = sanitize(null);
    const b = { ...a, theme: 'dark' as const, pins: [...a.pins] };
    expect(changedFields(a, b)).toEqual({ theme: 'dark' });
    expect(changedFields(a, { ...a })).toEqual({});
  });

  it('takeChanges hands a local change over once, then nothing', () => {
    settings.showHidden = !settings.showHidden;
    expect(settings.takeChanges(settings.snapshot())).toEqual({ showHidden: settings.showHidden });
    expect(settings.takeChanges(settings.snapshot())).toEqual({});
  });

  it('applyRemote takes known fields, drops unknown ones, and does not echo them back', () => {
    settings.takeChanges(settings.snapshot());
    settings.applyRemote({ theme: 'dark', bogus: 1 });
    expect(settings.theme).toBe('dark');
    expect('bogus' in settings).toBe(false);
    expect(settings.takeChanges(settings.snapshot())).toEqual({});
  });

  // M8's tab sets and M7's rebinds ride the same settings:changed patch as every other field:
  // `takeChanges` is what the window that saved them emits, `applyRemote` what another window does
  // with it (the Spotlight side is palette-settings.test.ts).
  it('a saved tab set and a rebind go out in the patch and land in the other window', () => {
    settings.takeChanges(settings.snapshot());
    const set = {
      name: 'Trove work',
      tabs: ['/Users/alex/a', '/Users/alex/b'],
      active: 1,
      savedAt: 1,
    };
    settings.tabSets = [set];
    settings.shortcutOverrides = { 'open-home': 'Ctrl+Alt+J' };
    const patch = settings.takeChanges(settings.snapshot());
    expect(patch).toEqual({
      tabSets: [set],
      shortcutOverrides: { 'open-home': 'CmdOrCtrl+Alt+J' },
    });

    // the other window: the patch, as JSON over the event, replaces its fields - and is not echoed
    settings.tabSets = [];
    settings.shortcutOverrides = {};
    settings.takeChanges(settings.snapshot());
    settings.applyRemote(JSON.parse(JSON.stringify(patch)));
    expect(settings.tabSets).toEqual([set]);
    expect(settings.shortcutOverrides).toEqual({ 'open-home': 'Ctrl+Alt+J' });
    expect(settings.takeChanges(settings.snapshot())).toEqual({});

    // a delete travels too: the emptied list is a change like any other
    settings.applyRemote({ tabSets: [], shortcutOverrides: {} });
    expect(settings.tabSets).toEqual([]);
    expect(settings.shortcutOverrides).toEqual({});
  });

  it('applyRemote before load is ignored', () => {
    settings.loaded = false;
    const before = settings.theme;
    settings.applyRemote({ theme: before === 'dark' ? 'light' : 'dark' });
    expect(settings.theme).toBe(before);
    settings.loaded = true;
  });

  it('schedulePatch + flush merges the fields and never writes the whole file', async () => {
    settings.schedulePatch({ theme: 'light' });
    settings.schedulePatch({ showHidden: true });
    await settings.flush();
    expect(merged).toHaveBeenCalledTimes(1);
    expect(merged.mock.calls[0]?.[0]).toEqual({ theme: 'light', showHidden: true });
    expect(written).not.toHaveBeenCalled();
  });
});

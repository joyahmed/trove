import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/default-handler', () => ({
  defaultHandlerStatus: vi.fn(async () => ({ kind: 'not-applied' })),
  defaultHandlerInfo: vi.fn(async () => ({ exePath: 'D:\\Apps\\Trove\\trove.exe', stable: true })),
  defaultHandlerApply: vi.fn(async () => {}),
  defaultHandlerRevert: vi.fn(async () => {}),
}));
vi.mock('$lib/api/shell-verbs', () => ({
  shellVerbs: vi.fn(async () => []),
  runShellVerb: vi.fn(async () => {}),
  runCustomCommand: vi.fn(async () => {}),
}));
vi.mock('$lib/api/palette', () => ({
  registerHotkey: vi.fn(async () => {}),
  onHotkeyFailed: vi.fn(),
  onSpotlightAction: vi.fn(),
  onSpotlightNavigate: vi.fn(),
  onSpotlightOpenFailed: vi.fn(),
  onSpotlightReveal: vi.fn(),
  onSpotlightSearch: vi.fn(),
}));

import { registerHotkey } from '$lib/api/palette';
import {
  resetToDefaults,
  SEARCH_ENGINES,
  settingsSections,
  STORE_DEFAULT_HANDLER_NOTE,
  type SettingRow,
} from './settings-sections';
import { confirm } from '$lib/state/confirm.svelte';
import { defaultHandler } from '$lib/state/default-handler.svelte';
import { sanitize, settings } from '$lib/state/settings.svelte';
import { spotlight } from '$lib/state/spotlight-bridge.svelte';

const row = (section: string, key: string): SettingRow => {
  const s = settingsSections.find((x) => x.key === section);
  const r = s?.rows().find((x) => x.key === key);
  if (!r) throw new Error(`no row ${section}/${key}`);
  return r;
};

describe('settings sections', () => {
  beforeEach(() => {
    settings.apply(sanitize(null));
    defaultHandler.status = { kind: 'not-applied' };
  });

  it('the Open-to radio round-trips settings.startPlace', () => {
    const r = row('general', 'start-place');
    if (r.kind !== 'radio') throw new Error('radio expected');
    expect(r.get()).toBe('home');
    r.set('this-pc');
    expect(settings.startPlace).toBe('this-pc');
    expect(r.get()).toBe('this-pc');
    r.set('home');
    expect(settings.startPlace).toBe('home');
  });

  // Plan 19, 1.5.1: "I'm coming from" — the host's own option stores 'native'
  describe("the I'm coming from row", () => {
    afterEach(() => vi.unstubAllGlobals());

    it('is offered on every host, marks the host, and stores native for the host', () => {
      for (const [os, host] of [
        ['windows', 'windows'],
        ['macos', 'mac'],
        ['linux', 'linux'],
      ] as const) {
        vi.stubGlobal('window', { __TROVE_PLATFORM__: { os, thisPcLabel: 'x' } });
        settings.comingFrom = 'native';
        const r = row('general', 'coming-from');
        if (r.kind !== 'radio') throw new Error('radio expected');
        expect(r.options.map((o) => o.key)).toEqual(['windows', 'mac', 'linux']);
        const marked = r.options.filter((o) => o.label.endsWith(' (this computer)'));
        expect(marked.map((o) => o.key)).toEqual([host]);
        expect(r.get()).toBe(host);
        for (const other of ['windows', 'mac', 'linux'].filter((k) => k !== host)) {
          r.set(other);
          expect(settings.comingFrom).toBe(other);
          expect(r.get()).toBe(other);
        }
        r.set(host);
        expect(settings.comingFrom).toBe('native');
        r.set('beos');
        expect(settings.comingFrom).toBe('native');
      }
    });

    it('sits right after Open Trove to, and its description names only words', () => {
      const keys = settingsSections
        .find((x) => x.key === 'general')
        ?.rows()
        .map((x) => x.key);
      expect(keys?.indexOf('coming-from')).toBe((keys?.indexOf('start-place') ?? -2) + 1);
      const r = row('general', 'coming-from');
      expect(r.label).toBe("I'm coming from");
      expect(r.description).toMatch(/^Changes only words/);
      expect(r.description).toContain('Trash or Recycle Bin');
      expect(r.description).toMatch(/and which shortcuts work$/);
    });
  });

  it('the Accent colour radio offers Sapphire and Match system and round-trips', () => {
    const r = row('appearance', 'accent-source');
    if (r.kind !== 'radio') throw new Error('radio expected');
    expect(r.options.map((o) => o.label)).toEqual(['Sapphire', 'Match system']);
    expect(r.get()).toBe('sapphire');
    r.set('system');
    expect(settings.accentSource).toBe('system');
    r.set('nonsense');
    expect(settings.accentSource).toBe('sapphire');
  });

  // Off Windows the row is hidden rather than greyed: RadioRow cannot disable one option.
  it('the Accent colour row is not offered off Windows', () => {
    const w = globalThis as { window?: unknown };
    const before = w.window;
    w.window = { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' } };
    try {
      const keys = settingsSections
        .find((x) => x.key === 'appearance')
        ?.rows()
        .map((x) => x.key);
      expect(keys).not.toContain('accent-source');
      expect(keys).toContain('default-view');
    } finally {
      w.window = before;
    }
  });

  it('keep running and start with Windows are on and locked while Trove is the default', () => {
    const keep = row('behaviour', 'keep-running');
    const start = row('behaviour', 'start-with-windows');
    if (keep.kind !== 'toggle' || start.kind !== 'toggle') throw new Error('toggle expected');
    expect(keep.get()).toBe(false);
    expect(keep.disabled?.()).toBe(false);
    settings.defaultHandler = { applied: true, exePath: 'D:\\Apps\\Trove\\trove.exe' };
    expect(keep.get()).toBe(true);
    expect(keep.disabled?.()).toBe(true);
    expect(start.get()).toBe(true);
    expect(start.disabled?.()).toBe(true);
    expect(keep.note?.()).toContain('default file manager');
  });

  it('reset restores the defaults but leaves the default-handler record alone', async () => {
    settings.zoom = 1.5;
    settings.restoreTabs = false;
    settings.startPlace = 'this-pc';
    settings.comingFrom = 'mac';
    settings.defaultHandler = { applied: true, exePath: 'D:\\Apps\\Trove\\trove.exe' };
    const asked = resetToDefaults();
    expect(confirm.pending?.okLabel).toBe('Reset');
    confirm.answer(true);
    expect(await asked).toBe(true);
    expect(settings.comingFrom).toBe('native');
    expect(settings.zoom).toBe(1);
    expect(settings.restoreTabs).toBe(true);
    expect(settings.startPlace).toBe('home');
    expect(settings.defaultHandler).toEqual({
      applied: true,
      exePath: 'D:\\Apps\\Trove\\trove.exe',
    });
  });

  it('the Sidebar section restores Home and the hidden folders, and shows each as a row', () => {
    expect(settingsSections.find((s) => s.key === 'quick-access')?.label).toBe('Sidebar');
    const restore = row('quick-access', 'restore-sidebar');
    if (restore.kind !== 'button') throw new Error('button expected');
    expect(restore.disabled?.()).toBe(true);
    settings.toggleSidebarKey('home');
    settings.toggleKnownFolder('music');
    expect(restore.disabled?.()).toBe(false);
    expect(row('quick-access', 'show-home').label).toBe('Home');
    expect(row('quick-access', 'show-music').label).toBe('Music');
    void restore.run();
    expect(settings.hiddenSidebarKeys).toEqual([]);
    expect(settings.hiddenKnownFolders).toEqual([]);
    expect(settings.startPlace).toBe('home');
  });

  it('an unpinned Applications row comes back from its "Applications" Show row', () => {
    settings.toggleSidebarKey('applications');
    const show = row('quick-access', 'show-applications');
    expect(show.label).toBe('Applications');
    if (show.kind !== 'button') throw new Error('button expected');
    void show.run();
    expect(settings.hiddenSidebarKeys).not.toContain('applications');
  });

  it('a declined reset changes nothing', async () => {
    settings.zoom = 1.3;
    const asked = resetToDefaults();
    confirm.answer(false);
    expect(await asked).toBe(false);
    expect(settings.zoom).toBe(1.3);
  });

  it('the Theme radio offers System, Light and Dark, round-trips, and defaults to System', () => {
    const r = row('appearance', 'theme');
    if (r.kind !== 'radio') throw new Error('radio expected');
    expect(r.options.map((o) => o.label)).toEqual(['System', 'Light', 'Dark']);
    expect(r.get()).toBe('system');
    r.set('dark');
    expect(settings.theme).toBe('dark');
    r.set('nonsense');
    expect(settings.theme).toBe('system');
  });

  const onOs = (os: string, run: () => void) => {
    const w = globalThis as { window?: unknown };
    const before = w.window;
    w.window = { __TROVE_PLATFORM__: { os, thisPcLabel: 'This Mac' } };
    try {
      run();
    } finally {
      w.window = before;
    }
  };
  const keysOf = (section: string) =>
    settingsSections
      .find((x) => x.key === section)
      ?.rows()
      .map((x) => x.key);

  it('off Windows: start at login on Mac and Linux, default file manager on Linux only, no registry verbs', () => {
    const rest = ['keep-running', 'start-with-windows', 'spotlight-hotkey'];
    onOs('macos', () => {
      expect(keysOf('behaviour')).toEqual([...rest, 'spotlight-search-engine']);
      expect(row('behaviour', 'start-with-windows').label).toBe('Start at login');
      expect(keysOf('context-menu')).toEqual(['customize']);
    });
    onOs('linux', () => {
      expect(keysOf('behaviour')).toEqual(['default-handler', ...rest, 'spotlight-search-engine']);
      expect(keysOf('context-menu')).toEqual(['customize']);
    });
    expect(keysOf('behaviour')).toContain('default-handler');
    expect(keysOf('behaviour')).toContain('start-with-windows');
  });

  it('names the zoom chords and the Bin the way each OS does', () => {
    const zoomText = () => row('appearance', 'zoom').description;
    const binText = () => row('quick-access', 'restore-sidebar').description;
    expect(zoomText()).toContain('(Ctrl + / Ctrl −)');
    expect(binText()).toContain('the Recycle Bin');
    onOs('macos', () => {
      expect(zoomText()).toContain('(⌘+ / ⌘−)');
      expect(binText()).toContain('the Trash');
    });
    onOs('linux', () => expect(zoomText()).toContain('(Ctrl + / Ctrl −)'));
  });

  it('Reset mentions the default file manager only on Windows', () => {
    const text = () => row('advanced', 'reset').description;
    expect(text()).toContain('default file manager is kept');
    for (const os of ['macos', 'linux']) {
      onOs(os, () => expect(text()).toBe('Back to the defaults'));
    }
  });
});

// Plan 22.2.4: the Store (MSIX) build cannot write the default-handler keys (virtualized), so
// the switch is hidden and one line says why; nothing is forced on by a record it never wrote.
describe('the Microsoft Store build', () => {
  const store = (channel?: 'direct' | 'msstore') =>
    vi.stubGlobal('window', {
      __TROVE_PLATFORM__: { os: 'windows', thisPcLabel: 'This PC', channel },
    });
  beforeEach(() => settings.apply(sanitize(null)));
  afterEach(() => vi.unstubAllGlobals());

  it('replaces the default-file-manager switch with one line saying why', () => {
    store('msstore');
    const r = row('behaviour', 'default-handler');
    expect(r.kind).toBe('info');
    expect(r.label).toBe('Use as default file manager');
    expect(r.description).toBe(STORE_DEFAULT_HANDLER_NOTE);
    expect('set' in r).toBe(false);
  });

  it('keeps the switch in the direct build, and when no channel is sent', () => {
    for (const c of ['direct', undefined] as const) {
      store(c);
      expect(row('behaviour', 'default-handler').kind).toBe('toggle');
    }
  });

  it('keeps Start with Windows as a switch, never locked by a default-handler record', () => {
    store('msstore');
    settings.defaultHandler = { applied: true, exePath: 'D:\\Apps\\Trove\\trove.exe' };
    const start = row('behaviour', 'start-with-windows');
    if (start.kind !== 'toggle') throw new Error('toggle expected');
    expect(start.label).toBe('Start with Windows');
    expect(start.get()).toBe(false);
    expect(start.disabled?.()).toBe(false);
    expect(start.note?.()).toBeNull();
  });
});

describe('settings wording off Windows', () => {
  const texts = () =>
    settingsSections
      .flatMap((s) => s.rows())
      .map((r) => ('description' in r ? (r.description ?? '') : ''))
      .join('\n');

  afterEach(() => vi.unstubAllGlobals());

  it('Mac says nothing about Explorer, hidden attributes or the default file manager', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'macos', thisPcLabel: 'This Mac' } });
    expect(texts()).not.toMatch(/Explorer|hidden attribute|default file manager/i);
  });

  it('Windows keeps its wording', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'windows', thisPcLabel: 'This PC' } });
    expect(texts()).toMatch(/Explorer/);
    expect(texts()).toMatch(/hidden attribute/);
    expect(texts()).toMatch(/default file manager is kept/);
  });
});

describe('background-app words follow the host', () => {
  afterEach(() => vi.unstubAllGlobals());
  const on = (os: string) =>
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os, thisPcLabel: 'x' } });
  const desc = (key: string) => {
    const r = row('behaviour', key);
    return 'description' in r ? (r.description ?? '') : '';
  };
  const sizes = () => {
    const r = row('general', 'folder-sizes');
    return 'description' in r ? (r.description ?? '') : '';
  };

  it('Windows: tray, logon, WSL', () => {
    on('windows');
    expect(desc('keep-running')).toBe('A tray icon; closing the last window hides it');
    expect(desc('start-with-windows')).toBe('Starts hidden in the tray at logon');
    expect(sizes()).toContain('network, USB and WSL');
  });

  it('Mac: menu bar, login, no WSL', () => {
    on('macos');
    expect(desc('keep-running')).toBe('A menu bar icon; closing the last window hides it');
    expect(desc('start-with-windows')).toBe('Starts hidden at login');
    expect(sizes()).not.toMatch(/WSL/);
  });

  it('Linux: system tray, login, no WSL', () => {
    on('linux');
    expect(desc('keep-running')).toBe('A system tray icon; closing the last window hides it');
    expect(desc('start-with-windows')).toBe('Starts hidden in the system tray at login');
    expect(sizes()).not.toMatch(/WSL/);
  });
});

describe('Spotlight web search engine row', () => {
  beforeEach(() => settings.apply(sanitize(null)));
  const engine = () => {
    const r = row('behaviour', 'spotlight-search-engine');
    if (r.kind !== 'engine') throw new Error('engine row expected');
    return r;
  };

  it('picking each named engine sets its template', () => {
    for (const e of SEARCH_ENGINES) {
      expect(engine().set(e.template)).toBeNull();
      expect(settings.spotlightSearchTemplate).toBe(e.template);
      expect(engine().get()).toBe(e.template);
    }
    expect(SEARCH_ENGINES.map((e) => e.label)).toEqual(['Google', 'Bing', 'DuckDuckGo']);
  });

  it('a valid custom template is kept, trimmed', () => {
    expect(engine().set('  https://example.com/s?q=%s ')).toBeNull();
    expect(settings.spotlightSearchTemplate).toBe('https://example.com/s?q=%s');
  });

  it('an invalid custom template is refused and nothing changes', () => {
    const before = settings.spotlightSearchTemplate;
    expect(engine().set('https://example.com/s?q=')).toMatch(/%s/);
    expect(engine().set('javascript:alert(%s)')).toMatch(/http/);
    expect(engine().set('example.com/%s')).toMatch(/http/);
    expect(engine().set('')).not.toBeNull();
    expect(settings.spotlightSearchTemplate).toBe(before);
  });

  describe('the Spotlight shortcut row', () => {
    const hotkey = () => {
      const r = row('behaviour', 'spotlight-hotkey');
      if (r.kind !== 'hotkey') throw new Error('hotkey expected');
      return r;
    };
    const settle = () => new Promise((r) => setTimeout(r, 0));

    it('saves the new chord only once the OS accepts it', async () => {
      vi.mocked(registerHotkey).mockResolvedValueOnce(null);
      hotkey().set('ctrl+shift+space');
      expect(settings.spotlightHotkey).toBe('alt+space');
      await settle();
      expect(settings.spotlightHotkey).toBe('ctrl+shift+space');
      expect(spotlight.hotkeyError).toBeNull();
    });

    it('keeps the previous chord and shows the error when the OS refuses', async () => {
      vi.mocked(registerHotkey).mockRejectedValueOnce('Super+Space could not be registered');
      hotkey().set('super+space');
      await settle();
      expect(settings.spotlightHotkey).toBe('alt+space');
      expect(hotkey().get()).toBe('alt+space');
      expect(hotkey().note?.()).toContain('could not be registered');
    });

    // D.5.2: the chord registers but GNOME binds it too. Saved, with GNOME's key in the note.
    it('saves a chord GNOME also binds and shows the conflict as the note', async () => {
      const note = 'Ctrl+Alt+T is also GNOME\'s "terminal" shortcut';
      vi.mocked(registerHotkey).mockResolvedValueOnce(note);
      hotkey().set('ctrl+alt+t');
      await settle();
      expect(settings.spotlightHotkey).toBe('ctrl+alt+t');
      expect(spotlight.hotkeyError).toBeNull();
      expect(hotkey().note?.()).toBe(note);
    });
  });
});

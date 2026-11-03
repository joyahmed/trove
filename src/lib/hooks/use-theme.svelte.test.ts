import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '$lib/state/settings.svelte';
import { theme } from '$lib/state/theme.svelte';
import {
  THEME_STORAGE_KEY,
  isExplorerLabel,
  nativeThemeFor,
  onSystemDark,
  syncNativeTheme,
  useTheme,
} from './use-theme.svelte';

const native = vi.hoisted(() => ({ label: 'main', calls: [] as ('light' | 'dark' | null)[] }));
vi.mock('$lib/api/window', () => ({
  windowLabel: () => native.label,
  setNativeTheme: async (t: 'light' | 'dark' | null) => {
    native.calls.push(t);
  },
}));

// The suite runs in node: stand in for the two browser globals the hook touches.
let store: Record<string, string>;
let root: { dataset: Record<string, string> };

beforeEach(() => {
  native.label = 'main';
  native.calls = [];
  store = {};
  root = { dataset: {} };
  vi.stubGlobal('document', { documentElement: root });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
});

afterEach(() => {
  settings.theme = 'system';
  settings.settled = false;
  vi.unstubAllGlobals();
});

describe('use-theme', () => {
  it('stores the choice, not the resolved colour', () => {
    settings.theme = 'dark';
    settings.settled = true;
    useTheme();
    expect(store[THEME_STORAGE_KEY]).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    settings.theme = 'system';
    theme.systemDark = true;
    useTheme();
    expect(store[THEME_STORAGE_KEY]).toBe('system');
    expect(root.dataset.theme).toBe('dark');
  });

  // Before settings are read the theme is System's guess: storing it would overwrite the real
  // Light/Dark choice the next window paints on its first frame (Spotlight, 2026-10-06).
  it('does not store a theme before settings are read', () => {
    store[THEME_STORAGE_KEY] = 'dark';
    settings.theme = 'light';
    useTheme();
    expect(root.dataset.theme).toBeUndefined(); // the inline script's paint stands
    expect(store[THEME_STORAGE_KEY]).toBe('dark');
  });

  it('keeps working when storage throws', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('blocked');
      },
    });
    settings.theme = 'light';
    settings.settled = true;
    useTheme();
    expect(root.dataset.theme).toBe('light');
  });
});

// The Mac glass follows the WINDOW's appearance, so the theme must be pushed onto the window.
describe('native window theme (macOS)', () => {
  it('forces Light/Dark and hands System back to the OS', () => {
    expect(nativeThemeFor('light', 'light')).toBe('light');
    expect(nativeThemeFor('dark', 'dark')).toBe('dark');
    expect(nativeThemeFor('system', 'dark')).toBeNull();
    expect(nativeThemeFor('system', 'light')).toBeNull();
  });

  it('only explorer windows count (Spotlight has no permission and no glass)', () => {
    expect(isExplorerLabel('main')).toBe(true);
    expect(isExplorerLabel('main-3')).toBe(true);
    expect(isExplorerLabel('palette')).toBe(false);
  });

  it('sets the window theme once settings are read, and System hands it back', async () => {
    settings.theme = 'light';
    await syncNativeTheme(true);
    expect(native.calls).toEqual([]); // not settled yet: the choice is a guess
    settings.settled = true;
    await syncNativeTheme(true);
    settings.theme = 'dark';
    await syncNativeTheme(true);
    settings.theme = 'system';
    await syncNativeTheme(true);
    expect(native.calls).toEqual(['light', 'dark', null]);
  });

  it('never touches the window off a Mac or in Spotlight', async () => {
    settings.theme = 'dark';
    settings.settled = true;
    await syncNativeTheme(false);
    expect(native.calls).toEqual([]);
  });

  it('drops the media-query echo of a forced appearance, not the real OS change', () => {
    theme.systemDark = true;
    settings.theme = 'light'; // forced Light on a dark Mac: the query now says light
    onSystemDark(true, false);
    expect(theme.systemDark).toBe(true);
    onSystemDark(false, false); // off a Mac nothing is forced: it is the OS
    expect(theme.systemDark).toBe(false);
    settings.theme = 'system';
    onSystemDark(true, true);
    expect(theme.systemDark).toBe(true);
  });
});

describe('app.html', () => {
  const html = readFileSync('src/app.html', 'utf8');
  it('sets data-theme from the same key, before the stylesheet', () => {
    const script = html.indexOf('dataset.theme');
    expect(script).toBeGreaterThan(-1);
    expect(html).toContain(`'${THEME_STORAGE_KEY}'`);
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain("t !== 'dark' && t !== 'light'"); // 'system' falls through to the OS
    expect(script).toBeLessThan(html.indexOf('%sveltekit.head%'));
  });
});

// useTheme's effects on Svelte's CLIENT runtime. The unit file (use-theme.svelte.test.ts) only
// sees the hook's first, direct apply; the two $effects — re-apply when the Theme setting
// changes, follow the OS live — never run on the server build, so they are checked here.
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '$lib/state/settings.svelte';
import { theme } from '$lib/state/theme.svelte';
import { THEME_STORAGE_KEY, useTheme } from './use-theme.svelte';

let store: Record<string, string>;
let root: { dataset: Record<string, string> };
let osListener: ((e: { matches: boolean }) => void) | null;
const removeListener = vi.fn();

beforeEach(() => {
  store = {};
  root = { dataset: {} };
  osListener = null;
  removeListener.mockClear();
  vi.stubGlobal('document', { documentElement: root });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: (_: string, f: (e: { matches: boolean }) => void) => (osListener = f),
    removeEventListener: removeListener,
  }));
});

afterEach(() => {
  settings.theme = 'system';
  settings.settled = false;
  theme.systemDark = false;
  vi.unstubAllGlobals();
});

describe('useTheme effects', () => {
  it('re-applies and stores the theme when the setting changes after mount', () => {
    settings.settled = true;
    const stop = $effect.root(() => useTheme());
    flushSync();
    expect(root.dataset.theme).toBe('light');

    settings.theme = 'dark';
    flushSync();
    expect(root.dataset.theme).toBe('dark');
    expect(store[THEME_STORAGE_KEY]).toBe('dark');
    stop();
  });

  it('follows the OS live while System is chosen, and stops listening on teardown', () => {
    settings.settled = true;
    const stop = $effect.root(() => useTheme());
    flushSync();
    // guard: the effect subscribed, so the assertions below really ran
    expect(osListener).not.toBeNull();

    osListener?.({ matches: true });
    flushSync();
    expect(root.dataset.theme).toBe('dark');

    stop();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });
});

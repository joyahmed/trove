// useComingFrom's $effect on Svelte's CLIENT runtime (plan 19, 1.3.3): the stored setting
// reaches the live style and the first-paint mirror, but only once settings are settled; a
// change from another window (`applyRemote`) flows through the same effect.
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSettings } from '$lib/api/settings';
import { COMING_FROM_STORAGE_KEY, comingFrom } from '$lib/state/coming-from.svelte';
import { settings } from '$lib/state/settings.svelte';
import { useComingFrom } from './use-coming-from.svelte';

vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => null),
  writeSettings: vi.fn(async () => {}),
  mergeSettings: vi.fn(async () => {}),
}));

let store: Record<string, string>;

beforeEach(() => {
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
});

afterEach(async () => {
  settings.comingFrom = 'native';
  settings.settled = false;
  comingFrom.choice = 'native';
  await settings.flush();
  vi.unstubAllGlobals();
});

describe('useComingFrom', () => {
  it('copies a settled choice to the style and the mirror', () => {
    settings.settled = true;
    settings.comingFrom = 'mac';
    const stop = $effect.root(() => useComingFrom());
    flushSync();
    expect(comingFrom.style).toBe('mac');
    expect(store[COMING_FROM_STORAGE_KEY]).toBe('mac');

    settings.comingFrom = 'linux';
    flushSync();
    expect(comingFrom.style).toBe('linux');
    expect(store[COMING_FROM_STORAGE_KEY]).toBe('linux');
    stop();
  });

  it('does nothing before settings are settled: the mirror already painted', () => {
    comingFrom.choice = 'mac'; // what the mirror painted
    store[COMING_FROM_STORAGE_KEY] = 'mac';
    settings.settled = false;
    settings.comingFrom = 'native'; // the default, not yet the person's
    const stop = $effect.root(() => useComingFrom());
    flushSync();
    expect(comingFrom.choice).toBe('mac');
    expect(store[COMING_FROM_STORAGE_KEY]).toBe('mac');
    stop();
  });

  it("follows another window's change through applyRemote", async () => {
    vi.mocked(readSettings).mockResolvedValueOnce(null);
    settings.loaded = false;
    await settings.load();
    settings.settled = true;
    const stop = $effect.root(() => useComingFrom());
    flushSync();
    expect(comingFrom.choice).toBe('native');

    settings.applyRemote({ comingFrom: 'linux' });
    flushSync();
    expect(comingFrom.style).toBe('linux');
    expect(store[COMING_FROM_STORAGE_KEY]).toBe('linux');
    stop();
  });

  it('survives storage that throws on write', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    settings.settled = true;
    settings.comingFrom = 'mac';
    const stop = $effect.root(() => useComingFrom());
    flushSync();
    expect(comingFrom.style).toBe('mac');
    stop();
  });
});

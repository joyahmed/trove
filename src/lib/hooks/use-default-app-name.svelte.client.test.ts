// useDefaultAppName on Svelte's client runtime: the default app's name for a path, nothing asked
// while there is no path, and a late answer for an old path never lands.
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWithApps } from '$lib/api/open-with';
import { playInLabel, useDefaultAppName } from './use-default-app-name.svelte';

vi.mock('$lib/api/open-with', () => ({ openWithApps: vi.fn() }));
const apps = vi.mocked(openWithApps);

const app = (name: string, isDefault: boolean) => ({ id: name, name, icon: null, isDefault });

afterEach(() => apps.mockReset());

describe('playInLabel', () => {
  it('names the app, or falls back while it is unknown', () => {
    expect(playInLabel('VLC media player')).toBe('Play in VLC media player');
    expect(playInLabel(null)).toBe('Play in your default app');
  });
});

describe('useDefaultAppName', () => {
  it('finds the default among the apps for the path', async () => {
    apps.mockResolvedValue([app('Videos', false), app('VLC media player', true)]);
    let hook!: ReturnType<typeof useDefaultAppName>;
    const stop = $effect.root(() => {
      hook = useDefaultAppName(() => '/v/big.mkv');
    });
    flushSync();
    await vi.waitFor(() => expect(hook.name).toBe('VLC media player'));
    expect(apps).toHaveBeenCalledWith('/v/big.mkv');
    stop();
  });

  it('asks nothing without a path, and is null when no app is the default', async () => {
    apps.mockResolvedValue([app('Videos', false)]);
    let path = $state<string | null>(null);
    let hook!: ReturnType<typeof useDefaultAppName>;
    const stop = $effect.root(() => {
      hook = useDefaultAppName(() => path);
    });
    flushSync();
    expect(apps).not.toHaveBeenCalled();
    path = '/v/a.mkv';
    flushSync();
    await vi.waitFor(() => expect(apps).toHaveBeenCalledTimes(1));
    expect(hook.name).toBeNull();
    stop();
  });

  it('drops a late answer for a path that is no longer shown', async () => {
    let answer!: (v: ReturnType<typeof app>[]) => void;
    apps.mockReturnValueOnce(new Promise((r) => (answer = r)));
    apps.mockResolvedValueOnce([app('Totem', true)]);
    let path = $state<string | null>('/v/old.mkv');
    let hook!: ReturnType<typeof useDefaultAppName>;
    const stop = $effect.root(() => {
      hook = useDefaultAppName(() => path);
    });
    flushSync();
    path = '/v/new.mkv';
    flushSync();
    await vi.waitFor(() => expect(hook.name).toBe('Totem'));
    answer([app('VLC media player', true)]);
    await Promise.resolve();
    expect(hook.name).toBe('Totem');
    stop();
  });
});

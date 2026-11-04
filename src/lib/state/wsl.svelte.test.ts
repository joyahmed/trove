import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wslDistros, wslRunningDistros } from '$lib/api/wsl';

vi.mock('$lib/api/wsl', () => ({
  wslDistros: vi.fn(async () => [{ name: 'Ubuntu', isDefault: true, uid: 1000 }]),
  wslHome: vi.fn(async () => String.raw`\\wsl.localhost\Ubuntu\home\alex`),
  wslRunningDistros: vi.fn(async () => [] as string[]),
}));
vi.mock('$lib/state/tabs.svelte', () => ({
  tabs: { active: { navigate: vi.fn(async () => {}), error: null } },
}));

const fresh = async () => {
  vi.resetModules();
  return (await import('./wsl.svelte')) as typeof import('./wsl.svelte');
};

describe('which WSL distros are running', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is asked on load and again on every poll', async () => {
    const { wsl, RUNNING_POLL_MS } = await fresh();
    vi.mocked(wslRunningDistros).mockResolvedValueOnce([]).mockResolvedValueOnce(['Ubuntu']);
    await wsl.load();
    expect(wsl.isRunning('Ubuntu')).toBe(false);
    await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS);
    expect(wsl.isRunning('Ubuntu')).toBe(true);
  });

  it('opening a distro asks again, since opening starts it', async () => {
    const { wsl } = await fresh();
    await wsl.load();
    vi.mocked(wslRunningDistros).mockResolvedValueOnce(['Ubuntu']);
    await wsl.open({ name: 'Ubuntu', isDefault: true, uid: 1000 });
    await vi.waitFor(() => expect(wsl.running).toEqual(['Ubuntu']));
  });

  it('a failed ask keeps the last answer: the dot does not flicker off', async () => {
    const { wsl, RUNNING_POLL_MS } = await fresh();
    vi.mocked(wslRunningDistros).mockResolvedValueOnce(['Ubuntu']);
    await wsl.load();
    vi.mocked(wslRunningDistros).mockRejectedValueOnce(new Error('wsl.exe timed out'));
    await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS);
    expect(wsl.running).toEqual(['Ubuntu']);
  });

  it('no distros installed: wsl.exe is never spawned', async () => {
    const { wsl, RUNNING_POLL_MS } = await fresh();
    vi.mocked(wslDistros).mockResolvedValueOnce([]);
    vi.mocked(wslRunningDistros).mockClear();
    await wsl.load();
    await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS * 2);
    expect(wslRunningDistros).not.toHaveBeenCalled();
  });
});

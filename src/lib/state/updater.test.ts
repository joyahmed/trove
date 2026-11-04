import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  updateReady: vi.fn<() => Promise<string | null>>(),
  updateRestart: vi.fn<() => Promise<void>>(),
  onUpdateReady: vi.fn<(cb: (version: string) => void) => Promise<() => void>>(),
}));
vi.mock('$lib/api/updater', () => api);
vi.mock('$lib/api/log', () => ({ logError: vi.fn() }));

// a fresh singleton per test: `start` runs once per window
const load = async () => {
  vi.resetModules();
  const { updater } = await import('./updater.svelte');
  const { notices } = await import('./notices.svelte');
  return { updater, notices };
};

let heard: ((version: string) => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  heard = undefined;
  api.updateReady.mockResolvedValue(null);
  api.updateRestart.mockResolvedValue();
  api.onUpdateReady.mockImplementation((cb) => {
    heard = cb;
    return Promise.resolve(() => {});
  });
});

describe('updater', () => {
  it('never asks Rust in a build that does not update itself', async () => {
    const { updater } = await load();
    updater.start(false);
    expect(api.updateReady).not.toHaveBeenCalled();
    expect(api.onUpdateReady).not.toHaveBeenCalled();
    expect(updater.version).toBeNull();
  });

  it('shows an update already waiting, and one that arrives later, asking only once', async () => {
    api.updateReady.mockResolvedValue('1.2.0');
    const { updater } = await load();
    updater.start(true);
    updater.start(true);
    await vi.waitFor(() => expect(updater.version).toBe('1.2.0'));
    expect(api.updateReady).toHaveBeenCalledTimes(1);
    heard?.('1.3.0');
    expect(updater.version).toBe('1.3.0');
  });

  it('installs only on the click, and only once while it runs', async () => {
    const { updater } = await load();
    updater.start(true);
    expect(api.updateRestart).not.toHaveBeenCalled();
    heard?.('1.3.0');
    void updater.restart();
    void updater.restart();
    expect(updater.restarting).toBe(true);
    expect(api.updateRestart).toHaveBeenCalledTimes(1);
  });

  it('does nothing on restart when no update is waiting', async () => {
    const { updater } = await load();
    await updater.restart();
    expect(api.updateRestart).not.toHaveBeenCalled();
  });

  it('a failed install hides the line and says so in an error notice', async () => {
    api.updateRestart.mockRejectedValue('signature mismatch');
    const { updater, notices } = await load();
    updater.start(true);
    heard?.('1.3.0');
    await updater.restart();
    expect(updater.restarting).toBe(false);
    expect(updater.version).toBeNull();
    expect(notices.list.at(-1)).toMatchObject({
      kind: 'error',
      title: 'The update did not install',
      message: 'signature mismatch',
    });
  });
});

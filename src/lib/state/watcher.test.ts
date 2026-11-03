import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unwatchPath, watchPath } from '$lib/api/watch';
import { notices } from './notices.svelte';
import { tabs } from './tabs.svelte';
import { watcher } from './watcher.svelte';
import { THIS_PC, pathLocation } from '$lib/utils/location';

vi.mock('$lib/api/watch', () => ({
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
  onFsChanged: vi.fn(async () => () => {}),
}));
vi.mock('$lib/api/fs', () => ({ readDir: vi.fn(async (path: string) => ({ path, entries: [] })) }));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));
vi.mock('$lib/api/transfer', () => ({
  transferConflicts: vi.fn(async () => []),
  startTransfer: vi.fn(async () => 1),
  cancelTransfer: vi.fn(async () => {}),
  restoreFromTrash: vi.fn(async () => {}),
  onTransferProgress: vi.fn(async () => () => {}),
  onTransferDone: vi.fn(async () => () => {}),
}));
vi.mock('$lib/api/clipboard', () => ({
  clipboardWritePaths: vi.fn(async () => {}),
  clipboardReadPaths: vi.fn(async () => null),
}));

const reset = () => {
  while (tabs.list.length > 1) tabs.close(tabs.list.length - 1);
  tabs.activate(0);
  tabs.active.location = pathLocation('');
  watcher.sync([]);
  vi.mocked(watchPath).mockClear();
  vi.mocked(unwatchPath).mockClear();
};

describe('watcher.sync', () => {
  beforeEach(reset);

  it('watches each open folder once and skips places and WSL shares', () => {
    watcher.sync(['C:\\a', 'c:\\A', '', '\\\\wsl.localhost\\Ubuntu\\home', 'C:\\b']);
    expect(vi.mocked(watchPath).mock.calls.map((c) => c[0])).toEqual(['C:\\a', 'C:\\b']);
    expect(unwatchPath).not.toHaveBeenCalled();
  });

  it('unwatches a folder once no tab shows it', () => {
    watcher.sync(['C:\\a', 'C:\\b']);
    watcher.sync(['C:\\b']);
    expect(vi.mocked(unwatchPath).mock.calls.map((c) => c[0])).toEqual(['C:\\a']);
    expect(watchPath).toHaveBeenCalledTimes(2);
  });
});

describe('watcher events', () => {
  beforeEach(reset);

  it('a change reloads only the tabs on that folder, case-insensitively', () => {
    const a = tabs.active;
    a.location = pathLocation('C:\\a');
    const b = tabs.open('');
    b.location = pathLocation('C:\\b');
    const ra = vi.spyOn(a, 'reload').mockResolvedValue();
    const rb = vi.spyOn(b, 'reload').mockResolvedValue();
    watcher.changed('c:\\A');
    expect(ra).toHaveBeenCalledTimes(1);
    expect(rb).not.toHaveBeenCalled();
  });

  it('a vanished folder sends its tab up and posts a notice', async () => {
    const tab = tabs.active;
    tab.location = pathLocation('C:\\was\\gone');
    watcher.gone('C:\\was\\gone');
    await vi.waitFor(() => expect(tab.location).toEqual(pathLocation('C:\\was')));
    expect(notices.list.at(-1)).toMatchObject({
      kind: 'warning',
      message: 'gone was moved or deleted',
    });
  });

  it('a vanished drive root sends its tab to This PC', async () => {
    const tab = tabs.active;
    tab.location = pathLocation('E:\\');
    watcher.gone('E:\\');
    await vi.waitFor(() => expect(tab.location).toEqual(THIS_PC));
  });
});

let epoch = 0;
const BUSY = 'C:' + String.fromCharCode(92) + 'busy';

describe('watcher under constant writes', () => {
  beforeEach(() => {
    reset();
    vi.useFakeTimers();
    // the tab singleton remembers when an earlier test's reload landed; start well after it
    vi.setSystemTime(Date.now() + (epoch += 600_000));
  });
  afterEach(() => vi.useRealTimers());

  const slowTab = () => {
    const tab = tabs.active;
    tab.location = pathLocation(BUSY);
    let land: () => void = () => {};
    const reload = vi
      .spyOn(tab, 'reload')
      .mockImplementation(() => new Promise<void>((r) => (land = r)));
    return { reload, land: () => land() };
  };

  it('does not start a second read while one is in flight, then reads once more when it lands', async () => {
    const { reload, land } = slowTab();
    watcher.changed(BUSY);
    expect(reload).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) watcher.changed(BUSY);
    expect(reload).toHaveBeenCalledTimes(1);
    land();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(reload).toHaveBeenCalledTimes(2);
    land();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('a folder written to forever still reloads within the max wait', async () => {
    const tab = tabs.active;
    tab.location = pathLocation(BUSY);
    const reload = vi.spyOn(tab, 'reload').mockResolvedValue();
    watcher.changed(BUSY);
    expect(reload).toHaveBeenCalledTimes(1);
    // an event every 100 ms keeps the quiet gap from ever elapsing
    for (let t = 0; t < 1600; t += 100) {
      await vi.advanceTimersByTimeAsync(100);
      watcher.changed(BUSY);
    }
    expect(reload.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEntry } from '$lib/types/palette';

// ⛔ No test starts an app: the IPC is mocked, nothing reaches the OS.
const spotlightApps = vi.fn<(refresh?: boolean) => Promise<AppEntry[]>>();
vi.mock('$lib/api/palette', () => ({
  spotlightApps: (refresh?: boolean) => spotlightApps(refresh),
  launchApp: vi.fn(),
}));

vi.mock('$lib/api/watch', () => ({
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
}));

import { unwatchPath, watchPath } from '$lib/api/watch';
import { APPS_REFRESH_MS, appFolders, applications, filterApps } from './applications.svelte';

const app = (name: string): AppEntry => ({
  name,
  lnkPath: '',
  target: '',
  aumid: `id.${name}`,
  openWith: null,
  path: '',
});

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('filterApps', () => {
  const list = [app('Calculator'), app('Calendar'), app('Paint'), app('Visual Studio Code')];

  it('keeps every app for blank text, in the order Rust sent them', () => {
    expect(filterApps(list, '')).toEqual(list);
    expect(filterApps(list, '   ')).toEqual(list);
  });

  it('matches a substring anywhere in the name, case-insensitively', () => {
    expect(filterApps(list, 'CALC').map((a) => a.name)).toEqual(['Calculator']);
    expect(filterApps(list, 'cal').map((a) => a.name)).toEqual(['Calculator', 'Calendar']);
    expect(filterApps(list, 'studio').map((a) => a.name)).toEqual(['Visual Studio Code']);
    expect(filterApps(list, ' paint ').map((a) => a.name)).toEqual(['Paint']);
  });

  it('is empty when nothing matches', () => {
    expect(filterApps(list, 'zzz')).toEqual([]);
  });
});

describe('applications state', () => {
  beforeEach(async () => {
    spotlightApps.mockReset();
    // start each test from a clean, settled state
    spotlightApps.mockResolvedValueOnce([]);
    await applications.reload();
    spotlightApps.mockReset();
    applications.loaded = false;
    applications.filter = '';
  });

  it('load reads the cached list once; reload asks Rust to walk again', async () => {
    spotlightApps.mockResolvedValue([app('Calculator'), app('Paint')]);
    await applications.load();
    expect(spotlightApps).toHaveBeenLastCalledWith(false);
    expect(applications.items.map((a) => a.name)).toEqual(['Calculator', 'Paint']);
    expect(applications.loaded).toBe(true);
    await applications.load();
    expect(spotlightApps).toHaveBeenCalledTimes(1);
    await applications.reload();
    expect(spotlightApps).toHaveBeenLastCalledWith(true);
    expect(spotlightApps).toHaveBeenCalledTimes(2);
  });

  it('a failed read says so and leaves loading down; a retry clears the error', async () => {
    spotlightApps.mockRejectedValueOnce('no apps folder');
    await applications.reload();
    expect(applications.error).toBe('no apps folder');
    expect(applications.loading).toBe(false);
    spotlightApps.mockResolvedValueOnce([app('Paint')]);
    await applications.reload();
    expect(applications.error).toBeNull();
    expect(applications.items.map((a) => a.name)).toEqual(['Paint']);
  });

  it('shown follows the filter text', async () => {
    spotlightApps.mockResolvedValue([app('Calculator'), app('Paint')]);
    await applications.load();
    applications.filter = 'calc';
    expect(applications.shown.map((a) => a.name)).toEqual(['Calculator']);
    applications.filter = '';
    expect(applications.shown).toHaveLength(2);
  });

  it('an older read that lands last writes nothing over the newer one', async () => {
    const older = deferred<AppEntry[]>();
    const newer = deferred<AppEntry[]>();
    spotlightApps.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = applications.reload();
    const second = applications.reload();
    newer.resolve([app('Newer')]);
    await second;
    older.resolve([app('Older')]);
    await first;
    expect(applications.items.map((a) => a.name)).toEqual(['Newer']);
    expect(applications.loading).toBe(false);
  });
});

// Plan 15 D.7 (Mac, 2026-10-21): an app put back from the Trash into /Applications did not show
// until F5, because nothing watched the folder. Now the place watches the apps' folders.
describe('applications live refresh', () => {
  // the tests run with no platform injected, which is Windows: Start Menu shortcuts
  const SM = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs';
  const at = (name: string, lnkPath: string): AppEntry => ({ ...app(name), lnkPath });

  beforeEach(async () => {
    applications.unwatch();
    spotlightApps.mockReset();
    vi.mocked(watchPath).mockClear();
    vi.mocked(unwatchPath).mockClear();
    spotlightApps.mockResolvedValueOnce([
      at('Safari', `${SM}\\Safari.lnk`),
      at('Notes', `${SM}\\Notes.lnk`),
      at('Terminal', `${SM}\\Utilities\\Terminal.lnk`),
      app('Store app with no file'),
    ]);
    await applications.reload();
    spotlightApps.mockClear();
  });

  it('appFolders names each app folder once and skips apps with no file', () => {
    expect(appFolders(applications.items)).toEqual([SM, `${SM}\\Utilities`]);
  });

  it('watch() watches those folders; unwatch() lets them go', () => {
    applications.watch();
    expect(vi.mocked(watchPath).mock.calls.map((c) => c[0])).toEqual([SM, `${SM}\\Utilities`]);
    applications.unwatch();
    expect(vi.mocked(unwatchPath).mock.calls.map((c) => c[0])).toEqual([SM, `${SM}\\Utilities`]);
  });

  it('a change in a watched folder asks the OS again once, after the burst settles', async () => {
    vi.useFakeTimers();
    try {
      applications.watch();
      spotlightApps.mockResolvedValue([
        at('Safari', `${SM}\\Safari.lnk`),
        at('Notes', `${SM}\\Notes.lnk`),
        at('Put Back', `${SM}\\Put Back.lnk`),
      ]);
      applications.changed(SM);
      applications.changed(SM);
      expect(spotlightApps).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(APPS_REFRESH_MS);
      expect(spotlightApps).toHaveBeenCalledTimes(1);
      expect(spotlightApps).toHaveBeenLastCalledWith(true);
      expect(applications.items.map((a) => a.name)).toContain('Put Back');
      // the new list no longer names Utilities, so that watch is dropped
      expect(unwatchPath).toHaveBeenCalledWith(`${SM}\\Utilities`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a folder that is not an app folder, and anything after unwatch', async () => {
    vi.useFakeTimers();
    try {
      applications.watch();
      applications.changed('C:\\Users\\a\\Documents');
      applications.unwatch();
      applications.changed(SM);
      await vi.advanceTimersByTimeAsync(APPS_REFRESH_MS * 2);
      expect(spotlightApps).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

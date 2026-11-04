import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REACHING_AFTER_MS, TabState } from './tab.svelte';
import { pathLocation } from '$lib/utils/location';
import { netSignIn, readDir } from '$lib/api/fs';
import type { DirListing } from '$lib/types/fs';

vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  oneDriveRoot: vi.fn(async () => null),
}));
vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(),
  pathKind: vi.fn(async () => 'dir'),
  netSignIn: vi.fn(),
}));
vi.mock('$lib/api/archive', () => ({ readArchiveDir: vi.fn() }));

// Backslashes are written as `/` and turned back, so no literal has to be read twice.
const win = (text: string) => text.replaceAll('/', String.fromCharCode(92));
const SHARE = win('//nas/media');
const LOCAL = win('C:/scratch');
const WSL = win('//wsl.localhost/Ubuntu/home');

/** A read the test settles by hand, like a share that answers whenever it likes. */
const hold = () => {
  let resolve!: (l: DirListing) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<DirListing>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('the "still reaching" state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(readDir).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('stays quiet for a share that answers quickly', async () => {
    const tab = new TabState();
    const read = hold();
    vi.mocked(readDir).mockReturnValueOnce(read.promise);
    const moving = tab.navigate(SHARE);
    vi.advanceTimersByTime(REACHING_AFTER_MS - 1);
    expect(tab.slowServer).toBeNull();
    read.resolve({ path: SHARE, entries: [] });
    await moving;
    vi.advanceTimersByTime(REACHING_AFTER_MS * 2);
    expect(tab.slowServer).toBeNull();
    expect(tab.loadingText).toBe('Loading…');
  });

  it('names the server once the share is slow, and clears when it answers', async () => {
    const tab = new TabState();
    const read = hold();
    vi.mocked(readDir).mockReturnValueOnce(read.promise);
    const moving = tab.navigate(win('//nas/media/film'));
    vi.advanceTimersByTime(REACHING_AFTER_MS);
    expect(tab.loading).toBe(true);
    expect(tab.slowServer).toBe('nas');
    expect(tab.loadingText).toBe('Still reaching nas…');
    read.resolve({ path: win('//nas/media/film'), entries: [] });
    await moving;
    expect(tab.slowServer).toBeNull();
    expect(tab.loading).toBe(false);
  });

  it('never shows for a local folder or a WSL path', async () => {
    for (const path of [LOCAL, WSL]) {
      const tab = new TabState();
      const read = hold();
      vi.mocked(readDir).mockReturnValueOnce(read.promise);
      const moving = tab.navigate(path);
      vi.advanceTimersByTime(REACHING_AFTER_MS * 5);
      expect(tab.slowServer).toBeNull();
      read.resolve({ path, entries: [] });
      await moving;
    }
  });

  it('Cancel returns to where the tab was and lowers loading', async () => {
    const tab = new TabState();
    vi.mocked(readDir).mockResolvedValueOnce({ path: LOCAL, entries: [] });
    await tab.navigate(LOCAL);
    const read = hold();
    vi.mocked(readDir).mockReturnValueOnce(read.promise);
    const moving = tab.navigate(SHARE);
    vi.advanceTimersByTime(REACHING_AFTER_MS);
    expect(tab.slowServer).toBe('nas');
    tab.cancelNavigation();
    expect(tab.loading).toBe(false);
    expect(tab.slowServer).toBeNull();
    expect(tab.location).toEqual(pathLocation(LOCAL));
    expect(tab.canGoBack).toBe(false);
    read.resolve({ path: SHARE, entries: [] });
    await moving;
    // the late answer is ignored
    expect(tab.location).toEqual(pathLocation(LOCAL));
    expect(tab.loading).toBe(false);
    expect(tab.canGoBack).toBe(false);
  });

  it('ignores a late failure after Cancel', async () => {
    const tab = new TabState();
    vi.mocked(readDir).mockResolvedValueOnce({ path: LOCAL, entries: [] });
    await tab.navigate(LOCAL);
    const read = hold();
    vi.mocked(readDir).mockReturnValueOnce(read.promise);
    const moving = tab.navigate(SHARE);
    tab.cancelNavigation();
    read.reject(`${SHARE} did not answer in 10 s`);
    await moving;
    expect(tab.error).toBeNull();
    expect(tab.location).toEqual(pathLocation(LOCAL));
  });

  it('Cancel on a Back step gives the history back', async () => {
    const tab = new TabState();
    vi.mocked(readDir).mockImplementation(async (path) => ({ path, entries: [] }));
    await tab.navigate(SHARE);
    await tab.navigate(LOCAL);
    expect(tab.canGoBack).toBe(true);
    const read = hold();
    vi.mocked(readDir).mockReturnValueOnce(read.promise);
    const stepping = tab.navigate(SHARE, { step: 'back' });
    expect(tab.canGoBack).toBe(false);
    tab.cancelNavigation();
    expect(tab.canGoBack).toBe(true);
    expect(tab.canGoForward).toBe(false);
    read.resolve({ path: SHARE, entries: [] });
    await stepping;
    expect(tab.location).toEqual(pathLocation(LOCAL));
  });

  it('Cancel with nothing under way does nothing', () => {
    const tab = new TabState();
    tab.cancelNavigation();
    expect(tab.loading).toBe(false);
  });

  it('a newer navigate resets the state of the one it replaced', async () => {
    const tab = new TabState();
    const slow = hold();
    vi.mocked(readDir).mockReturnValueOnce(slow.promise);
    void tab.navigate(SHARE);
    vi.advanceTimersByTime(REACHING_AFTER_MS);
    expect(tab.slowServer).toBe('nas');
    vi.mocked(readDir).mockResolvedValueOnce({ path: LOCAL, entries: [] });
    await tab.navigate(LOCAL);
    expect(tab.slowServer).toBeNull();
    expect(tab.loading).toBe(false);
  });
});

describe('the unreachable error', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(readDir).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the deadline message in plain words and offers a retry', async () => {
    const tab = new TabState();
    const message = `${SHARE} did not answer in 10 s`;
    vi.mocked(readDir).mockRejectedValueOnce(message);
    await tab.navigate(SHARE);
    expect(tab.error).toBe(message);
    expect(tab.unreachable).toBe(true);
    expect(tab.loading).toBe(false);
    expect(tab.slowServer).toBeNull();
    expect(tab.location).toEqual(pathLocation(SHARE));
  });

  it('does not call an ordinary failure unreachable', async () => {
    const tab = new TabState();
    vi.mocked(readDir).mockRejectedValueOnce('Access is denied.');
    await tab.navigate(SHARE);
    expect(tab.unreachable).toBe(false);
  });

  it('retry asks the same share again, with no new history entry, and clears the error', async () => {
    const tab = new TabState();
    vi.mocked(readDir).mockRejectedValueOnce(`${SHARE} did not answer in 10 s`);
    await tab.navigate(SHARE);
    vi.mocked(readDir).mockResolvedValueOnce({ path: SHARE, entries: [] });
    tab.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(readDir)).toHaveBeenLastCalledWith(SHARE);
    expect(tab.error).toBeNull();
    expect(tab.unreachable).toBe(false);
    expect(tab.canGoBack).toBe(false);
  });
});

describe('signing in to a share (5.3d)', () => {
  const DENIED = `${SHARE}: Access is denied. (os error 5)`;
  beforeEach(() => {
    vi.mocked(readDir).mockReset();
    vi.mocked(netSignIn).mockReset();
  });

  it('offers sign-in on access denied, connects, and lists the share again', async () => {
    const tab = new TabState();
    vi.mocked(readDir).mockRejectedValueOnce(DENIED);
    await tab.navigate(SHARE);
    expect(tab.signInCode).toBe(5);
    vi.mocked(netSignIn).mockResolvedValueOnce('connected');
    vi.mocked(readDir).mockResolvedValueOnce({ path: SHARE, entries: [] });
    await tab.signIn();
    await vi.waitFor(() => expect(tab.error).toBeNull());
    expect(netSignIn).toHaveBeenCalledWith(SHARE, 5);
  });

  it('offers it once: after Cancel the error stays and the offer is gone', async () => {
    const tab = new TabState();
    vi.mocked(readDir).mockRejectedValueOnce(DENIED);
    await tab.navigate(SHARE);
    vi.mocked(netSignIn).mockResolvedValueOnce('cancelled');
    await tab.signIn();
    expect(tab.error).toBe(DENIED);
    expect(tab.signInCode).toBeNull();
  });

  it('shows the plain reason when the connect fails', async () => {
    const tab = new TabState();
    vi.mocked(readDir).mockRejectedValueOnce(DENIED);
    await tab.navigate(SHARE);
    vi.mocked(netSignIn).mockRejectedValueOnce('wrong password');
    await tab.signIn();
    expect(tab.error).toBe('wrong password');
  });

  it('never offers it for WSL, a local folder, or another error', async () => {
    const tab = new TabState();
    for (const [path, err] of [
      [WSL, `${WSL}: Access is denied. (os error 5)`],
      [LOCAL, `${LOCAL}: Access is denied. (os error 5)`],
      [SHARE, `${SHARE}: not found (os error 53)`],
    ]) {
      vi.mocked(readDir).mockRejectedValueOnce(err);
      await tab.navigate(path);
      expect(tab.signInCode).toBeNull();
    }
  });
});

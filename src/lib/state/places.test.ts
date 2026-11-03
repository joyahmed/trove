// The three states This PC has to keep apart: **none**, **still asking**, **could not ask**.
// Collapsing the third into the first is the bug these tests exist to stop coming back —
// docs/plans/07-the-log-and-four-bugs.md Phase C.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveInfo, KnownFolder, KnownFolderKey } from '$lib/types/shell';

const api = vi.hoisted(() => ({
  folders: [] as KnownFolder[],
  driveList: [] as DriveInfo[],
  foldersFails: false,
  drivesFails: false,
  /** resolved by the test, so "drives is still in flight" is a state we can assert on */
  drivesGate: null as null | (() => void),
  /**
   * Manual mode: every call parks until the test settles it *by call index*, which is the only
   * way to write the interleavings this file cares about — two enumerations in flight at once,
   * settled in the wrong order. `drivesGate` can only hold one call.
   */
  manualDrives: false,
  manualFolders: false,
  driveCalls: [] as Deferred<DriveInfo[]>[],
  folderCalls: [] as Deferred<KnownFolder[]>[],
  drives: vi.fn(async () => {
    if (api.manualDrives) return await park(api.driveCalls);
    if (api.drivesGate) await new Promise<void>((r) => (api.drivesGate = r));
    if (api.drivesFails) throw new Error('the redirector gave up');
    return api.driveList;
  }),
  knownFolders: vi.fn(async () => {
    if (api.manualFolders) return await park(api.folderCalls);
    if (api.foldersFails) throw new Error('no profile');
    return api.folders;
  }),
  oneDriveRoot: vi.fn(async () => null),
}));
vi.mock('$lib/api/shell', () => api);
vi.mock('$lib/api/log', () => ({ logError: vi.fn() }));

import { places } from './places.svelte';

type Deferred<T> = { resolve: (value: T) => void; reject: (reason: unknown) => void };

/** Park a mocked call in `queue` until the test settles it. Registered synchronously. */
const park = <T>(queue: Deferred<T>[]) =>
  new Promise<T>((resolve, reject) => queue.push({ resolve, reject }));

const folder = (key: KnownFolderKey): KnownFolder => ({
  key,
  label: key,
  path: `C:\\Users\\alex\\${key}`,
});
const drive = (letter: string): DriveInfo => ({
  path: `${letter}:\\`,
  label: 'Local Disk',
  totalBytes: 100,
  freeBytes: 50,
});

describe('places state', () => {
  beforeEach(() => {
    api.folders = [folder('documents')];
    api.driveList = [drive('C'), drive('D')];
    api.foldersFails = false;
    api.drivesFails = false;
    api.drivesGate = null;
    api.manualDrives = false;
    api.manualFolders = false;
    api.driveCalls = [];
    api.folderCalls = [];
    api.drives.mockClear();
    api.knownFolders.mockClear();
    places.knownFolders = [];
    places.drives = [];
    places.foldersError = null;
    places.drivesError = null;
    places.foldersLoading = false;
    places.drivesLoading = false;
    places.loaded = false;
  });

  it('loads every source', async () => {
    await places.reload();
    expect(places.knownFolders).toHaveLength(1);
    expect(places.drives).toHaveLength(2);
    expect(places.loaded).toBe(true);
  });

  /**
   * The measured case: `drives` took 64 s on a cold start while `known_folders` took one. The
   * old `Promise.all` meant This PC painted nothing for the whole minute. Folders must be on
   * screen while drives is still outstanding — `allSettled` would not give this either.
   */
  it('paints the folders while drives is still outstanding', async () => {
    api.drivesGate = () => {};
    const done = places.reload();
    await vi.waitFor(() => expect(places.knownFolders).toHaveLength(1));
    expect(places.drivesLoading).toBe(true);
    expect(places.drives).toHaveLength(0);
    expect(places.drivesError).toBeNull(); // still asking is NOT a failure
    api.drivesGate?.();
    await done;
    expect(places.drives).toHaveLength(2);
  });

  /** ⛔ A failed source must not look like an empty one. */
  it('a failed drives call is an error, not an empty list', async () => {
    api.drivesFails = true;
    await places.reload();
    expect(places.drives).toHaveLength(0);
    expect(places.drivesError).toContain('the redirector gave up');
    // and it did not take the other sources down with it
    expect(places.knownFolders).toHaveLength(1);
    expect(places.foldersError).toBeNull();
  });

  it('one failed source does not stop the others — the old Promise.all did', async () => {
    api.foldersFails = true;
    await places.reload();
    expect(places.foldersError).toContain('no profile');
    expect(places.drives).toHaveLength(2);
  });

  /**
   * ⛔ `load()` skips when `loaded` is true, so marking a half-failed load as loaded would make
   * the gap permanent for the session with nothing left to re-ask.
   */
  it('does not mark itself loaded when a source failed', async () => {
    api.drivesFails = true;
    await places.reload();
    expect(places.loaded).toBe(false);
    // so a later load() really does ask again
    api.drivesFails = false;
    await places.load();
    expect(places.drives).toHaveLength(2);
    expect(places.loaded).toBe(true);
  });

  it('load() asks once and then skips — This PC must not re-enumerate on every navigation', async () => {
    await places.load();
    await places.load();
    expect(api.drives.mock.calls).toHaveLength(1);
  });

  /** ⚠️ The contract the call sites rely on: failures land in fields, never in a rejection. */
  it('reload never rejects, however badly it goes', async () => {
    api.foldersFails = true;
    api.drivesFails = true;
    await expect(places.reload()).resolves.toBeUndefined();
    expect(places.foldersError).not.toBeNull();
    expect(places.drivesError).not.toBeNull();
  });

  it('retrying one section does not re-ask the other', async () => {
    api.drivesFails = true;
    await places.reload();
    api.knownFolders.mockClear();
    api.drivesFails = false;
    await places.retryDrives();
    expect(places.drivesError).toBeNull();
    expect(places.drives).toHaveLength(2);
    expect(api.knownFolders.mock.calls).toHaveLength(0);
  });

  /**
   * ⛔ The whole point of the section below: drive enumeration is measured at 21–64 s, so a second
   * F5 / Retry / palette query lands *while the first is still waiting on the redirector*, and
   * nothing makes the two resolve in the order they were started.
   */
  describe('two runs of a source in flight at once', () => {
    it('does not let a superseded run latch `loaded` and lock the session out of retrying', async () => {
      api.manualDrives = true;
      const first = places.reload(); // the 64-second one; it will succeed LAST, with an old list
      const second = places.reload(); // F5 again; fails fast
      expect(api.driveCalls).toHaveLength(2);

      api.driveCalls[1].reject(new Error('the redirector gave up'));
      await second;
      expect(places.drivesError).toContain('the redirector gave up');
      expect(places.loaded).toBe(false);

      // ...and now the minute-old call finally answers, with the drive list from before
      api.driveCalls[0].resolve([drive('Z')]);
      await first;
      // the error must survive: PlaceView renders "Try again" only while it is non-null
      expect(places.drivesError).toContain('the redirector gave up');
      // and `loaded` must not have latched — this is the lockout itself
      expect(places.loaded).toBe(false);

      // the assertion that matters: a retry still reaches the OS and still fixes it
      api.manualDrives = false;
      api.drives.mockClear();
      await places.load();
      expect(api.drives.mock.calls).toHaveLength(1);
      expect(places.drives).toHaveLength(2);
      expect(places.drivesError).toBeNull();
      expect(places.loaded).toBe(true);
      // and the minute-old list never got a look in
      expect(places.drives).not.toContainEqual(drive('Z'));
    });

    it('does not let a stale drive list overwrite a newer one', async () => {
      api.manualDrives = true;
      const first = places.reload();
      const second = places.reload();
      api.driveCalls[1].resolve([drive('C'), drive('D')]);
      await second;
      api.driveCalls[0].resolve([drive('Z')]); // yesterday's mapping, answering a minute late
      await first;
      expect(places.drives.map((d) => d.path)).toEqual(['C:\\', 'D:\\']);
      expect(places.loaded).toBe(true);
    });

    it('does not lower the spinner while the newer call is still running', async () => {
      api.manualDrives = true;
      const first = places.reload();
      const second = places.reload();
      api.driveCalls[0].resolve([drive('Z')]); // the older call answers first
      await first;
      expect(places.drivesLoading).toBe(true); // the newer one still owns the spinner
      api.driveCalls[1].resolve([drive('C'), drive('D')]);
      await second;
      expect(places.drivesLoading).toBe(false);
    });

    it('lets a Retry that overtook a reload have the last word, `loaded` included', async () => {
      api.manualDrives = true;
      const reloading = places.reload(); // slow; this one is going to fail
      const retry = places.retryDrives(); // the person clicked "Try again" meanwhile
      expect(api.driveCalls).toHaveLength(2);

      api.driveCalls[0].reject(new Error('the redirector gave up'));
      await reloading;
      api.driveCalls[1].resolve([drive('C'), drive('D')]);
      await retry;

      expect(places.drivesError).toBeNull();
      expect(places.drives).toHaveLength(2);
      // `loaded` used to be written only by `reload()`, from shared error fields: the superseded
      // failure left it false forever, so every palette query re-enumerated every drive.
      expect(places.loaded).toBe(true);
      api.manualDrives = false;
      api.drives.mockClear();
      await places.load();
      expect(api.drives.mock.calls).toHaveLength(0);
    });

    /** Guards the choice of one generation *per source* rather than one for the whole store. */
    it('leaves a folders call in flight alone when only drives is retried', async () => {
      api.manualFolders = true;
      const reloading = places.reload();
      expect(api.folderCalls).toHaveLength(1);
      await places.retryDrives();
      api.folderCalls[0].resolve([folder('documents')]);
      await reloading;
      expect(places.knownFolders).toHaveLength(1);
      expect(places.foldersLoading).toBe(false);
      expect(places.foldersError).toBeNull();
      expect(places.loaded).toBe(true);
    });
  });
});

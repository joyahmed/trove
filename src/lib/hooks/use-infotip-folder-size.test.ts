// The folder total behind the card's Size row: who starts a walk, who stops it, and which
// batches are believed. The rule being protected is that a walk is expensive and a hover is
// free — so exactly one walk may exist, only the dwell may start it, and everything that takes
// a card down must end it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelFolderTotals, onFolderTotals, startFolderTotals } from '$lib/api/props';
import { FolderSizeJob, INFOTIP_DELAY_MS, useInfotip } from './use-infotip.svelte';
import type { FileEntry } from '$lib/types/fs';
import type { FolderTotals } from '$lib/types/props';

vi.mock('$lib/api/props', () => ({
  fileProps: vi.fn(),
  setFileAttributes: vi.fn(async () => {}),
  startFolderTotals: vi.fn(),
  cancelFolderTotals: vi.fn(async () => {}),
  onFolderTotals: vi.fn(async () => () => {}),
}));
// the hook reaches the list's state singletons; the IPC under them is not what is tested here
vi.mock('$lib/api/transfer', () => ({
  startTransfer: vi.fn(async () => 1),
  cancelTransfer: vi.fn(async () => {}),
  transferConflicts: vi.fn(async () => []),
  onTransferProgress: vi.fn(async () => () => {}),
  onTransferDone: vi.fn(async () => () => {}),
  dragOut: vi.fn(async () => ({ effect: 'none' })),
}));
vi.mock('$lib/api/clipboard', () => ({
  clipboardWritePaths: vi.fn(async () => {}),
  clipboardReadPaths: vi.fn(async () => null),
}));
vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  trashEntries: vi.fn(async () => {}),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
}));

const entry = (name: string, isDir: boolean): FileEntry => ({
  name,
  path: `C:\\scratch\\${name}`,
  isDir,
  size: isDir ? 0 : 4096,
  modifiedMs: null,
  createdMs: null,
  ext: isDir ? null : 'txt',
  isHidden: false,
  iconKey: isDir ? 'folder' : 'ext/txt',
  typeName: isDir ? 'File folder' : 'Text Document',
});

const dir = entry('src', true);
const file = entry('notes.txt', false);

const batch = (over: Partial<FolderTotals>): FolderTotals => ({
  jobId: 1,
  files: 1,
  folders: 0,
  bytes: 1024,
  sizeOnDisk: 4096,
  notCounted: 0,
  done: false,
  ...over,
});

/** A pointer-enter carries only the point; the hook reads nothing else off the event. */
const at = (x: number, y: number) => ({ clientX: x, clientY: y }) as PointerEvent;

/** Emit a `props:totals` batch to everything currently listening, as Tauri would. */
const emit = (t: FolderTotals) => {
  for (const [cb] of vi.mocked(onFolderTotals).mock.calls) cb(t);
};

const unlisten = vi.fn();
let nextJob = 1;

const cards: Tip[] = [];
type Tip = ReturnType<typeof useInfotip>;

/** One row's tip, registered for teardown. */
const mount = (e: FileEntry): Tip => {
  const tip = useInfotip(() => e);
  cards.push(tip);
  return tip;
};

beforeEach(() => {
  vi.useFakeTimers();
  // the node test environment has no DOM; the hook only asks whether a menu is rendered
  vi.stubGlobal('document', {
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
  nextJob = 1;
  unlisten.mockClear();
  vi.mocked(startFolderTotals).mockReset();
  vi.mocked(startFolderTotals).mockImplementation(async () => nextJob++);
  vi.mocked(cancelFolderTotals).mockClear();
  vi.mocked(onFolderTotals).mockClear();
  vi.mocked(onFolderTotals).mockImplementation(async () => unlisten);
});

// Every card is taken down at the end, the way unmounting a row does it. Without this a test
// that leaves a card up leaves its walk running into the next one — which is the very leak
// these tests are about, and `live` is module-wide, so it would show up as a stray cancel.
afterEach(() => {
  for (const tip of cards) tip.onpointerleave();
  cards.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Hover a row and let the dwell elapse, flushing the start's promise along with it. */
const dwellOn = async (tip: Tip) => {
  tip.onpointerenter(at(10, 10));
  await vi.advanceTimersByTimeAsync(INFOTIP_DELAY_MS);
};

describe("the infotip's folder walk", () => {
  it('starts on the dwell and never on pointer-enter', async () => {
    const tip = mount(dir);
    tip.onpointerenter(at(10, 10));
    expect(startFolderTotals).not.toHaveBeenCalled();
    expect(tip.folderSize).toBeNull();

    await vi.advanceTimersByTimeAsync(INFOTIP_DELAY_MS);
    expect(startFolderTotals).toHaveBeenCalledExactlyOnceWith(dir.path);
    // the card is up with nothing counted yet: the Size row says "Calculating…"
    expect(tip.folderSize).toEqual({ bytes: null, done: false, notCounted: 0, items: 0 });
  });

  it('sweeping past twenty folders starts nothing — no dwell, no walk', async () => {
    const tips = Array.from({ length: 20 }, (_, i) => mount(entry(`d${i}`, true)));
    for (const tip of tips) {
      tip.onpointerenter(at(10, 10));
      await vi.advanceTimersByTimeAsync(INFOTIP_DELAY_MS - 50);
      tip.onpointerleave();
    }
    await vi.advanceTimersByTimeAsync(INFOTIP_DELAY_MS);
    expect(startFolderTotals).not.toHaveBeenCalled();
  });

  it('a file shows its own size and starts no walk at all', async () => {
    const tip = mount(file);
    await dwellOn(tip);
    expect(tip.visible).toBe(true);
    expect(startFolderTotals).not.toHaveBeenCalled();
    expect(tip.folderSize).toBeNull();
  });

  it('carries what the walk did not count, and how many items it did walk', async () => {
    const tip = mount(dir);
    await dwellOn(tip);
    emit(batch({ jobId: 1, files: 0, folders: 0, bytes: 0, notCounted: 1, done: true }));
    expect(tip.folderSize).toEqual({ bytes: 0, done: true, notCounted: 1, items: 0 });
  });

  it('climbs with every batch of its own job and settles on done', async () => {
    const tip = mount(dir);
    await dwellOn(tip);
    emit(batch({ jobId: 1, bytes: 2048 }));
    expect(tip.folderSize).toMatchObject({ bytes: 2048, done: false });
    emit(batch({ jobId: 1, bytes: 9001, done: true }));
    expect(tip.folderSize).toMatchObject({ bytes: 9001, done: true });
    // done means the thread is over: nothing to cancel, and the listener is dropped
    await vi.advanceTimersByTimeAsync(0); // the unlisten handle is a promise, as Tauri's is
    expect(cancelFolderTotals).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("ignores a stale job's batches rather than taking the latest event", async () => {
    const tip = mount(dir);
    await dwellOn(tip);
    emit(batch({ jobId: 1, bytes: 2048 }));
    // job 7 is an older hover still draining; its number must never land on this card
    emit(batch({ jobId: 7, bytes: 999_999_999, done: true }));
    expect(tip.folderSize).toMatchObject({ bytes: 2048, done: false });
  });

  it('fills the card from batches that arrive before the job id does', async () => {
    let handOverId: (id: number) => void = () => {};
    vi.mocked(startFolderTotals).mockImplementation(
      () => new Promise<number>((resolve) => (handOverId = resolve)),
    );
    const tip = mount(dir);
    await dwellOn(tip);
    // a small folder: the whole walk finishes before the id is handed back
    emit(batch({ jobId: 5, bytes: 7777, done: true }));
    handOverId(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(tip.folderSize).toMatchObject({ bytes: 7777, done: true });
    expect(cancelFolderTotals).not.toHaveBeenCalled();
  });

  it("ignores a stale job's batch that arrived before the id did", async () => {
    let handOverId: (id: number) => void = () => {};
    vi.mocked(startFolderTotals).mockImplementation(
      () => new Promise<number>((resolve) => (handOverId = resolve)),
    );
    const tip = mount(dir);
    await dwellOn(tip);
    emit(batch({ jobId: 3, bytes: 999_999_999, done: true })); // an older hover, still draining
    emit(batch({ jobId: 5, bytes: 2048 }));
    handOverId(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(tip.folderSize).toMatchObject({ bytes: 2048, done: false });
  });

  it('hiding the card cancels the walk and stops listening', async () => {
    const tip = mount(dir);
    await dwellOn(tip);
    tip.onpointerleave();
    expect(cancelFolderTotals).toHaveBeenCalledExactlyOnceWith(1);
    expect(tip.folderSize).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(unlisten).toHaveBeenCalledOnce();
    // and a batch arriving after the cancel changes nothing
    emit(batch({ jobId: 1, bytes: 5_000_000, done: true }));
    expect(tip.folderSize).toBeNull();
  });

  it('cancels a walk whose id arrives after the pointer has already left', async () => {
    let handOverId: (id: number) => void = () => {};
    vi.mocked(startFolderTotals).mockImplementation(
      () => new Promise<number>((resolve) => (handOverId = resolve)),
    );
    const tip = mount(dir);
    await dwellOn(tip);
    tip.onpointerleave();
    expect(cancelFolderTotals).not.toHaveBeenCalled(); // there was no id to cancel yet
    handOverId(42);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelFolderTotals).toHaveBeenCalledExactlyOnceWith(42);
    expect(tip.folderSize).toBeNull();
  });

  it('keeps one walk alive across rows: a new dwell cancels the previous one', async () => {
    const first = mount(dir);
    const second = mount(entry('other', true));
    await dwellOn(first);
    await dwellOn(second);
    expect(cancelFolderTotals).toHaveBeenCalledExactlyOnceWith(1);
    expect(startFolderTotals).toHaveBeenCalledTimes(2);
    expect(first.folderSize).toBeNull();
    expect(second.folderSize).toEqual({ bytes: null, done: false, notCounted: 0, items: 0 });
  });
});

describe('FolderSizeJob', () => {
  it('is safe to stop when it never started', () => {
    const job = new FolderSizeJob();
    job.stop();
    job.stop();
    expect(cancelFolderTotals).not.toHaveBeenCalled();
    expect(job.size).toBeNull();
  });

  it('drops the row again when the walk cannot be started', async () => {
    vi.mocked(startFolderTotals).mockRejectedValueOnce(new Error('access denied'));
    const job = new FolderSizeJob();
    await job.start(dir);
    expect(job.size).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

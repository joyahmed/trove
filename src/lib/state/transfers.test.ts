import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transfers } from './transfers.svelte';
import { clipboard } from './clipboard.svelte';
import { undo } from './undo.svelte';
import { tabs } from './tabs.svelte';
import { selection } from './selection.svelte';
import {
  removeEmptiedFolders,
  removeMovedOriginals,
  replaceNoBin,
  restoreFromTrash,
  startTransfer,
  transferConflicts,
  undoReplace,
  binReadable,
} from '$lib/api/transfer';
import { deleteEntries, trashEntries } from '$lib/api/fs';
import { confirm } from './confirm.svelte';
import { UndoDeclined } from './undo.svelte';
import { notices, TIMEOUT_MS } from './notices.svelte';
import { comingFrom } from './coming-from.svelte';

vi.mock('$lib/api/transfer', () => ({
  startTransfer: vi.fn(async () => 1),
  cancelTransfer: vi.fn(async () => {}),
  removeMovedOriginals: vi.fn(async () => []),
  removeEmptiedFolders: vi.fn(async () => 0),
  transferConflicts: vi.fn(async () => [] as string[]),
  replaceNoBin: vi.fn(async () => null as string | null),
  undoReplace: vi.fn(async () => {}),
  binReadable: vi.fn(async () => {}),
  restoreFromTrash: vi.fn(async () => {}),
  onTransferProgress: vi.fn(async () => () => {}),
  onTransferDone: vi.fn(async () => () => {}),
}));
vi.mock('$lib/api/clipboard', () => ({
  clipboardWritePaths: vi.fn(async () => {}),
  clipboardReadPaths: vi.fn(async () => null),
}));
vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  trashEntries: vi.fn(async () => {}),
  deleteEntries: vi.fn(async () => {}),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
}));

let nextId = 1;

describe('transfers', () => {
  beforeEach(async () => {
    // an Undo waits for a running redo job: end the ones a test left running
    for (const j of transfers.jobs.filter((j) => !j.done)) {
      await transfers.applyDone({
        jobId: j.jobId,
        outputs: [],
        error: null,
        failed: [],
        cancelled: true,
      });
    }
    for (const j of [...transfers.jobs]) transfers.dismiss(j.jobId);
    transfers.pending = null;
    clipboard.clear();
    selection.clear();
    while (undo.canUndo) await undo.undo();
    vi.mocked(startTransfer).mockImplementation(async () => nextId++);
    tabs.active.location = { kind: 'path', path: 'D:\\dest' };
  });

  it('start lists the job and progress events update it', async () => {
    const id = await transfers.start(['C:\\a.txt'], 'D:\\dest', 'copy', 'skip');
    expect(transfers.jobs.map((j) => j.jobId)).toEqual([id]);
    transfers.applyProgress({ jobId: id, bytesDone: 10, bytesTotal: 40, current: 'C:\\a.txt' });
    expect(transfers.jobs[0]).toMatchObject({ bytesDone: 10, bytesTotal: 40, done: false });
    transfers.applyProgress({ jobId: 999, bytesDone: 1, bytesTotal: 1, current: '' });
    expect(transfers.jobs[0].bytesDone).toBe(10);
  });

  it('done pushes an undo entry, selects what landed and clears a cut clipboard', async () => {
    clipboard.set(['C:\\a.txt'], true);
    const id = await transfers.start(['C:\\a.txt'], 'D:\\dest', 'move', 'skip', {
      fromCut: true,
    });
    const pushed = vi.spyOn(undo, 'push');
    await transfers.applyDone({
      jobId: id,
      outputs: [{ from: 'C:\\a.txt', to: 'D:\\dest\\a.txt' }],
      error: null,
      failed: [],
      cancelled: false,
    });
    expect(transfers.jobs[0].done).toBe(true);
    expect(undo.undoLabel).toBe('Undo Move');
    // what the notice after the undo names, and where (another folder says so)
    expect(pushed.mock.calls[0][0]).toMatchObject({
      what: 'move of "a.txt" to "dest"',
      folder: 'D:\\dest',
    });
    pushed.mockRestore();
    expect(clipboard.has).toBe(false);
    expect(selection.has('D:\\dest\\a.txt')).toBe(true);
  });

  it('on Linux selects what landed only in the exact-cased folder', async () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' } });
    try {
      tabs.active.location = { kind: 'path', path: '/home/alex/Dest/' };
      const id = await transfers.start(['/tmp/a.txt', '/tmp/b.txt'], '/home/alex', 'copy', 'skip');
      await transfers.applyDone({
        jobId: id,
        outputs: [
          { from: '/tmp/a.txt', to: '/home/alex/Dest/a.txt' },
          { from: '/tmp/b.txt', to: '/home/alex/dest/b.txt' },
        ],
        error: null,
        failed: [],
        cancelled: false,
      });
      expect(selection.has('/home/alex/Dest/a.txt')).toBe(true);
      // `/home/alex/dest` is another folder on Linux, not the one the tab shows
      expect(selection.has('/home/alex/dest/b.txt')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('on Linux a Keep-both move of `a\\b.txt` goes back as `a\\b.txt`, not `b.txt`', async () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' } });
    try {
      const id = await transfers.start(['/src/a\\b.txt'], '/dest', 'move', 'keep-both');
      await transfers.applyDone({
        jobId: id,
        outputs: [{ from: '/src/a\\b.txt', to: '/dest/a\\b (2).txt' }],
        error: null,
        failed: [],
        cancelled: false,
      });
      await undo.undo();
      expect(startTransfer).toHaveBeenLastCalledWith(
        ['/dest/a\\b (2).txt'],
        '/src',
        'move',
        'skip',
        ['a\\b.txt'],
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('what a finished job saves for after a restart: move pairs, a copy, a Replace as other', async () => {
    const land = async (mode: 'move' | 'copy', replaced?: 'binned') => {
      const id = await transfers.start(['C:\\src\\a.txt'], 'D:\\dest', mode, 'skip');
      await transfers.applyDone({
        jobId: id,
        outputs: [
          { from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt', ...(replaced ? { replaced } : {}) },
        ],
        error: null,
        failed: [],
        cancelled: false,
      });
      return undo.saved().at(-1)?.record;
    };
    expect(await land('move')).toEqual({
      kind: 'move',
      pairs: [{ from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt' }],
    });
    expect(await land('copy')).toEqual({
      kind: 'copy',
      created: ['D:\\dest\\a.txt'],
      sources: ['C:\\src\\a.txt'],
      destination: 'D:\\dest',
    });
    expect(await land('copy', 'binned')).toEqual({
      kind: 'other',
      reason: 'it replaced older files',
    });
  });

  it('undoing a move moves the outputs back without recording again', async () => {
    const id = await transfers.start(['C:\\src\\a.txt'], 'D:\\dest', 'move', 'skip');
    await transfers.applyDone({
      jobId: id,
      outputs: [{ from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt' }],
      error: null,
      failed: [],
      cancelled: false,
    });
    await undo.undo();
    expect(startTransfer).toHaveBeenLastCalledWith(['D:\\dest\\a.txt'], 'C:\\src', 'move', 'skip');
    // the undo's own job lands and must not push a second entry
    const back = transfers.jobs.at(-1)!.jobId;
    await transfers.applyDone({
      jobId: back,
      outputs: [{ from: 'D:\\dest\\a.txt', to: 'C:\\src\\a.txt' }],
      error: null,
      failed: [],
      cancelled: false,
    });
    expect(undo.canUndo).toBe(false);
    expect(undo.canRedo).toBe(true);
  });

  it('undoing a Keep-both move puts it back under its original name, with Skip', async () => {
    const id = await transfers.start(['C:\\src\\a.txt'], 'D:\\dest', 'move', 'keep-both');
    await transfers.applyDone({
      jobId: id,
      outputs: [{ from: 'C:\\src\\a.txt', to: 'D:\\dest\\a (2).txt' }],
      error: null,
      failed: [],
      cancelled: false,
    });
    await undo.undo();
    // `a (2).txt` goes back as `a.txt`; Skip, so a new `a.txt` at the origin is never replaced
    expect(startTransfer).toHaveBeenLastCalledWith(
      ['D:\\dest\\a (2).txt'],
      'C:\\src',
      'move',
      'skip',
      ['a.txt'],
    );
  });

  it('a failed or cancelled job records nothing and keeps the error', async () => {
    const id = await transfers.start(['C:\\a.txt'], 'D:\\dest', 'copy', 'skip');
    await transfers.applyDone({
      jobId: id,
      outputs: [],
      error: 'Access denied',
      failed: [],
      cancelled: false,
    });
    expect(transfers.jobs[0].error).toBe('Access denied');
    expect(undo.canUndo).toBe(false);
  });

  it('a job that went on past failures keeps them, undoes what landed and keeps a cut', async () => {
    clipboard.set(['C:\\src'], true);
    const id = await transfers.start(['C:\\src', 'C:\\x.txt'], 'D:\\dest', 'move', 'replace', {
      fromCut: true,
    });
    const failed = [
      {
        path: 'C:\\src\\sub\\b.txt',
        destination: 'D:\\dest\\src\\sub',
        error: 'in use',
        kind: 'file' as const,
      },
      { path: 'C:\\x.txt', destination: 'D:\\dest', error: 'denied', kind: 'file' as const },
    ];
    await transfers.applyDone({
      jobId: id,
      outputs: [{ from: 'C:\\src', to: 'D:\\dest\\src' }],
      failed,
      error: '2 of 4 items could not be moved',
      cancelled: false,
    });
    const job = transfers.jobs.find((j) => j.jobId === id);
    expect(job?.failed).toEqual(failed);
    expect(job?.error).toBe('2 of 4 items could not be moved');
    expect(undo.undoLabel).toBe('Undo Move');
    expect(clipboard.has).toBe(true);
    expect(selection.has('D:\\dest\\src')).toBe(true);
  });

  it('retry failed starts a job with only the failed paths, same mode, answer and folder', async () => {
    const id = await transfers.start(['C:\\src', 'C:\\x.txt'], 'D:\\dest', 'copy', 'keep-both');
    await transfers.applyDone({
      jobId: id,
      outputs: [{ from: 'C:\\src', to: 'D:\\dest\\src' }],
      failed: [
        { path: 'C:\\src\\a.txt', destination: 'D:\\dest\\src', error: 'in use', kind: 'file' },
        { path: 'C:\\src\\b.txt', destination: 'D:\\dest\\src', error: 'in use', kind: 'file' },
        { path: 'C:\\x.txt', destination: 'D:\\dest', error: 'denied', kind: 'file' },
      ],
      error: '3 of 5 items could not be copied',
      cancelled: false,
    });
    vi.mocked(startTransfer).mockClear();
    await transfers.retryFailed(id);
    expect(vi.mocked(startTransfer).mock.calls).toEqual([
      [['C:\\src\\a.txt', 'C:\\src\\b.txt'], 'D:\\dest\\src', 'copy', 'keep-both'],
      [['C:\\x.txt'], 'D:\\dest', 'copy', 'keep-both'],
    ]);
    expect(transfers.jobs.some((j) => j.jobId === id)).toBe(false);
    expect(transfers.jobs.slice(-2).map((j) => [j.destination, j.mode, j.done])).toEqual([
      ['D:\\dest\\src', 'copy', false],
      ['D:\\dest', 'copy', false],
    ]);
  });

  it('retry merges a half-arrived folder; a renamed folder and files keep the job answer', async () => {
    const id = await transfers.start(['C:\\src', 'C:\\x.txt'], 'D:\\dest', 'copy', 'keep-both');
    await transfers.applyDone({
      jobId: id,
      outputs: [],
      failed: [
        { path: 'C:\\src\\sub', destination: 'D:\\dest\\src', error: 'cut off', kind: 'folder' },
        { path: 'C:\\src\\a.txt', destination: 'D:\\dest\\src', error: 'in use', kind: 'file' },
        { path: 'C:\\pics', destination: 'D:\\dest', error: 'cut off', kind: 'new-folder' },
        { path: 'C:\\x.txt', destination: 'D:\\dest', error: 'denied', kind: 'file' },
      ],
      error: '4 of 6 items could not be copied',
      cancelled: false,
    });
    vi.mocked(startTransfer).mockClear();
    vi.mocked(removeMovedOriginals).mockClear();
    await transfers.retryFailed(id);
    expect(vi.mocked(startTransfer).mock.calls).toEqual([
      [['C:\\src\\sub'], 'D:\\dest\\src', 'copy', 'replace'],
      [['C:\\src\\a.txt'], 'D:\\dest\\src', 'copy', 'keep-both'],
      [['C:\\pics', 'C:\\x.txt'], 'D:\\dest', 'copy', 'keep-both'],
    ]);
    expect(removeMovedOriginals).not.toHaveBeenCalled();
  });

  // the Ubuntu run: Retry of a failed move left the emptied source folders behind
  it('retry of a move, once done, removes the source folders it emptied (Rust keeps any not empty)', async () => {
    const id = await transfers.start(['C:\\src', 'C:\\x.txt'], 'D:\\dest', 'move', 'skip');
    await transfers.applyDone({
      jobId: id,
      outputs: [],
      failed: [
        {
          path: 'C:\\src\\sub\\c.txt',
          destination: 'D:\\dest\\src\\sub',
          error: 'in use',
          kind: 'file',
        },
        { path: 'C:\\x.txt', destination: 'D:\\dest', error: 'denied', kind: 'file' },
      ],
      error: '2 of 4 items could not be moved',
      cancelled: false,
    });
    vi.mocked(removeEmptiedFolders).mockClear();
    vi.mocked(startTransfer).mockResolvedValueOnce(41).mockResolvedValueOnce(42);
    await transfers.retryFailed(id);
    expect(removeEmptiedFolders).not.toHaveBeenCalled();
    for (const [jobId, from, to] of [
      [41, 'C:\\src\\sub\\c.txt', 'D:\\dest\\src\\sub\\c.txt'],
      [42, 'C:\\x.txt', 'D:\\dest\\x.txt'],
    ] as const) {
      await transfers.applyDone({
        jobId,
        outputs: [{ from, to }],
        error: null,
        failed: [],
        cancelled: false,
      });
    }
    await vi.waitFor(() => expect(removeEmptiedFolders).toHaveBeenCalledTimes(1));
    // up to the top-level source, never the folder it was moved out of (`C:\`)
    expect(removeEmptiedFolders).toHaveBeenCalledWith(['C:\\src\\sub', 'C:\\src']);
  });

  it('retry of a copy removes no folders', async () => {
    const id = await transfers.start(['C:\\src'], 'D:\\dest', 'copy', 'skip');
    await transfers.applyDone({
      jobId: id,
      outputs: [],
      failed: [
        {
          path: 'C:\\src\\sub\\c.txt',
          destination: 'D:\\dest\\src\\sub',
          error: 'in use',
          kind: 'file',
        },
      ],
      error: '1 of 3 items could not be copied',
      cancelled: false,
    });
    vi.mocked(removeEmptiedFolders).mockClear();
    vi.mocked(startTransfer).mockResolvedValueOnce(43);
    await transfers.retryFailed(id);
    await transfers.applyDone({
      jobId: 43,
      outputs: [{ from: 'C:\\src\\sub\\c.txt', to: 'D:\\dest\\src\\sub\\c.txt' }],
      error: null,
      failed: [],
      cancelled: false,
    });
    expect(removeEmptiedFolders).not.toHaveBeenCalled();
  });

  it('retry of an original that could not be deleted only deletes it, never copies', async () => {
    const id = await transfers.start(['C:\\src'], 'D:\\dest', 'move', 'skip');
    const stuck = {
      path: 'C:\\src\\b.txt',
      destination: 'D:\\dest\\src',
      error: 'in use',
      kind: 'not-removed' as const,
    };
    const other = { ...stuck, path: 'C:\\src\\c.txt' };
    await transfers.applyDone({
      jobId: id,
      outputs: [{ from: 'C:\\src', to: 'D:\\dest\\src' }],
      failed: [stuck, other],
      error: '2 item(s) arrived, but the original could not be deleted',
      cancelled: false,
    });
    vi.mocked(startTransfer).mockClear();
    vi.mocked(removeMovedOriginals).mockResolvedValueOnce([{ ...stuck, error: 'still in use' }]);
    await transfers.retryFailed(id);
    expect(startTransfer).not.toHaveBeenCalled();
    expect(removeMovedOriginals).toHaveBeenLastCalledWith([stuck, other]);
    expect(transfers.jobs.some((j) => j.jobId === id)).toBe(false);
    const row = transfers.jobs.at(-1)!;
    expect(row.jobId).toBeLessThan(0);
    expect(row).toMatchObject({
      done: true,
      mode: 'move',
      error: '1 item(s) arrived, but the original could not be deleted',
      failed: [{ ...stuck, error: 'still in use' }],
    });
    // that row's own Retry asks again; all gone this time, so it finishes clean
    vi.mocked(removeMovedOriginals).mockResolvedValueOnce([]);
    await transfers.retryFailed(row.jobId);
    expect(startTransfer).not.toHaveBeenCalled();
    expect(transfers.jobs.at(-1)).toMatchObject({ done: true, error: null, failed: [] });
  });

  it('a retry that lands fewer than it sent is not a success', async () => {
    clipboard.set(['C:\\a.txt', 'C:\\b.txt'], true);
    const id = await transfers.start(['C:\\a.txt', 'C:\\b.txt'], 'D:\\dest', 'move', 'skip', {
      fromCut: true,
    });
    await transfers.applyDone({
      jobId: id,
      outputs: [],
      failed: [
        { path: 'C:\\a.txt', destination: 'D:\\dest', error: 'in use', kind: 'file' },
        { path: 'C:\\b.txt', destination: 'D:\\dest', error: 'in use', kind: 'file' },
      ],
      error: '2 of 2 items could not be moved',
      cancelled: false,
    });
    await transfers.retryFailed(id);
    const retry = transfers.jobs.at(-1)!;
    // Skip met a b.txt that appeared at the destination meanwhile: one output, no error
    await transfers.applyDone({
      jobId: retry.jobId,
      outputs: [{ from: 'C:\\a.txt', to: 'D:\\dest\\a.txt' }],
      failed: [],
      error: null,
      cancelled: false,
    });
    expect(retry.done).toBe(true);
    expect(retry.error).toBe('1 of 2 were not retried: something with that name is already there');
    // b.txt never moved, so the cut stays on the clipboard
    expect(clipboard.has).toBe(true);
  });

  it('a done that arrives while start awaits its id is applied once the job is listed', async () => {
    let release: (id: number) => void = () => {};
    vi.mocked(startTransfer).mockImplementationOnce(
      () => new Promise<number>((r) => (release = r)),
    );
    const started = transfers.start(['C:\\a.txt'], 'D:\\dest', 'copy', 'skip');
    await transfers.applyDone({
      jobId: 77,
      outputs: [{ from: 'C:\\a.txt', to: 'D:\\dest\\a.txt' }],
      error: null,
      failed: [],
      cancelled: false,
    });
    release(77);
    await started;
    expect(transfers.jobs.find((j) => j.jobId === 77)?.done).toBe(true);
    expect(undo.undoLabel).toBe('Undo Copy');
  });

  it("a job another window started is not this window's business", async () => {
    const before = transfers.jobs.length;
    await transfers.applyDone({
      jobId: 9001,
      outputs: [{ from: 'C:\\x.txt', to: 'D:\\dest\\x.txt' }],
      error: null,
      failed: [],
      cancelled: false,
    });
    transfers.applyProgress({ jobId: 9001, bytesDone: 1, bytesTotal: 2, current: 'x' });
    expect(transfers.jobs.length).toBe(before);
    expect(undo.undoLabel).not.toBe('Undo Copy');
    // and it is not held for a later start either
    vi.mocked(startTransfer).mockResolvedValueOnce(9001);
    await transfers.start(['C:\\y.txt'], 'D:\\dest', 'move', 'skip');
    expect(transfers.jobs.find((j) => j.jobId === 9001)?.done).toBe(false);
  });

  it('the pending question resolves into a job or is cancelled', async () => {
    transfers.pending = {
      sources: ['C:\\a.txt'],
      destination: 'D:\\dest',
      mode: 'copy',
      conflicts: ['D:\\dest\\a.txt'],
      fromCut: false,
    };
    transfers.cancelPending();
    expect(transfers.pending).toBeNull();
    transfers.pending = {
      sources: ['C:\\a.txt'],
      destination: 'D:\\dest',
      mode: 'copy',
      conflicts: ['D:\\dest\\a.txt'],
      fromCut: false,
    };
    transfers.resolve('replace');
    expect(transfers.pending).toBeNull();
    await vi.waitFor(() =>
      expect(startTransfer).toHaveBeenLastCalledWith(['C:\\a.txt'], 'D:\\dest', 'copy', 'replace'),
    );
  });

  // Rust names the copy (ops::copy_name, per platform) and reports no conflict for a source
  // pasted into its own folder; this side must then ask nothing and treat the copy as landed.
  it('a copy pasted into its own folder starts at once and selects the new copy', async () => {
    vi.mocked(transferConflicts).mockResolvedValueOnce([]);
    await transfers.request(['D:\\dest\\a.txt'], 'D:\\dest', 'copy');
    expect(transfers.pending).toBeNull();
    expect(startTransfer).toHaveBeenLastCalledWith(['D:\\dest\\a.txt'], 'D:\\dest', 'copy', 'skip');
    const id = transfers.jobs.at(-1)?.jobId ?? -1;
    await transfers.applyDone({
      jobId: id,
      outputs: [{ from: 'D:\\dest\\a.txt', to: 'D:\\dest\\a - Copy.txt' }],
      error: null,
      failed: [],
      cancelled: false,
    });
    expect([...selection.paths]).toEqual(['D:\\dest\\a - Copy.txt']);
    await undo.undo();
    expect(trashEntries).toHaveBeenLastCalledWith(['D:\\dest\\a - Copy.txt']);
  });

  it('a cut pasted into its own folder lands nothing and records no undo', async () => {
    vi.mocked(transferConflicts).mockResolvedValueOnce([]);
    await transfers.request(['D:\\dest\\a.txt'], 'D:\\dest', 'move', { fromCut: true });
    expect(transfers.pending).toBeNull();
    const id = transfers.jobs.at(-1)?.jobId ?? -1;
    await transfers.applyDone({
      jobId: id,
      outputs: [],
      error: null,
      failed: [],
      cancelled: false,
    });
    expect(undo.canUndo).toBe(false);
  });

  describe('undoing a copy', () => {
    const noBin = () =>
      Object.assign(new Error('N: has no Recycle Bin, so nothing was deleted'), {
        name: 'NoRecycleBin',
        place: 'N:',
      });
    const copied = async (to: string[]) => {
      const id = await transfers.start(['C:\\a.txt'], 'N:\\', 'copy', 'skip');
      await transfers.applyDone({
        jobId: id,
        outputs: to.map((t) => ({ from: 'C:\\a.txt', to: t })),
        error: null,
        failed: [],
        cancelled: false,
      });
    };
    const settle = () => new Promise((r) => setTimeout(r, 0));

    beforeEach(() => {
      vi.mocked(trashEntries).mockReset().mockResolvedValue(undefined);
      vi.mocked(deleteEntries).mockReset().mockResolvedValue(undefined);
    });

    it('a local copy goes to the bin with no question', async () => {
      await copied(['D:\\dest\\a.txt']);
      await undo.undo();
      expect(trashEntries).toHaveBeenCalledWith(['D:\\dest\\a.txt']);
      expect(confirm.pending).toBeNull();
      expect(deleteEntries).not.toHaveBeenCalled();
    });

    it('no bin, answered yes: asks, then deletes the copies for good', async () => {
      await copied(['N:\\a.txt', 'N:\\b.txt']);
      vi.mocked(trashEntries).mockRejectedValueOnce(noBin());
      const run = undo.undo();
      await settle();
      expect(confirm.pending?.message).toBe(
        'N: has no Recycle Bin — permanently delete the 2 copies?',
      );
      confirm.answer(true);
      await run;
      expect(deleteEntries).toHaveBeenCalledWith(['N:\\a.txt', 'N:\\b.txt']);
      expect(undo.canRedo).toBe(true);
    });

    it('no bin, answered no: nothing deleted, entry dropped, declined news', async () => {
      await copied(['N:\\a.txt']);
      vi.mocked(trashEntries).mockRejectedValueOnce(noBin());
      const run = undo.undo();
      const caught = run.catch((e: unknown) => e);
      await settle();
      confirm.answer(false);
      const e = await caught;
      expect(e).toBeInstanceOf(UndoDeclined);
      expect((e as Error).message).toBe('Undo cancelled — the copies were not deleted');
      expect(deleteEntries).not.toHaveBeenCalled();
      expect(undo.canUndo).toBe(false);
      expect(undo.canRedo).toBe(false);
    });

    // Plan 19, 1.4.3: the bin's word follows "I'm coming from"; the question is still asked
    it('no bin under Mac style: the question says Trash, and nothing goes until yes', async () => {
      comingFrom.choice = 'mac';
      try {
        await copied(['N:\\a.txt']);
        vi.mocked(trashEntries).mockRejectedValueOnce(noBin());
        const run = undo.undo();
        const caught = run.catch((e: unknown) => e);
        await settle();
        expect(confirm.pending?.message).toBe('N: has no Trash — permanently delete the copy?');
        expect(confirm.pending?.danger).toBe(true);
        confirm.answer(false);
        await caught;
        expect(deleteEntries).not.toHaveBeenCalled();
      } finally {
        comingFrom.choice = 'native';
      }
    });

    it('any other error is rethrown as it is, with no question', async () => {
      await copied(['N:\\a.txt']);
      const boom = new Error('access denied');
      vi.mocked(trashEntries).mockRejectedValueOnce(boom);
      await expect(undo.undo()).rejects.toBe(boom);
      expect(confirm.pending).toBeNull();
      expect(deleteEntries).not.toHaveBeenCalled();
    });
  });

  describe('redo, cancel and failed starts', () => {
    const done = (jobId: number, outputs: { from: string; to: string }[], cancelled = false) =>
      transfers.applyDone({ jobId, outputs, error: null, failed: [], cancelled });

    beforeEach(() => {
      notices.clear();
      vi.mocked(trashEntries).mockReset().mockResolvedValue(undefined);
    });
    /** an undo that removes a cancelled job's half copy asks first (#confirmPartial) */
    const undoAnswering = async (ok: boolean) => {
      const run = undo.undo();
      await new Promise((r) => setTimeout(r, 0));
      expect(confirm.pending?.okLabel).toBe('Remove');
      confirm.answer(ok);
      await run;
    };

    it('a Keep-both copy redoes as Keep both, never Replace', async () => {
      const id = await transfers.start(['C:\\a.txt'], 'D:\\dest', 'copy', 'keep-both');
      await done(id, [{ from: 'C:\\a.txt', to: 'D:\\dest\\a (2).txt' }]);
      await undo.undo();
      await undo.redo();
      expect(startTransfer).toHaveBeenLastCalledWith(
        ['C:\\a.txt'],
        'D:\\dest',
        'copy',
        'keep-both',
      );
      expect(vi.mocked(startTransfer).mock.calls.some((c) => c[3] === 'replace')).toBe(false);
    });

    it('a copy that asked nothing redoes as Keep both', async () => {
      vi.mocked(transferConflicts).mockResolvedValueOnce([]);
      await transfers.request(['C:\\a.txt'], 'D:\\dest', 'copy');
      const id = transfers.jobs.at(-1)!.jobId;
      await done(id, [{ from: 'C:\\a.txt', to: 'D:\\dest\\a.txt' }]);
      await undo.undo();
      await undo.redo();
      expect(startTransfer).toHaveBeenLastCalledWith(
        ['C:\\a.txt'],
        'D:\\dest',
        'copy',
        'keep-both',
      );
    });

    it('a cancelled job records undo for what landed and reloads, cut kept', async () => {
      const reload = vi.spyOn(tabs.active, 'reload');
      clipboard.set(['C:\\a.txt', 'C:\\b.txt'], true);
      const id = await transfers.start(['C:\\a.txt', 'C:\\b.txt'], 'D:\\dest', 'move', 'skip', {
        fromCut: true,
      });
      await done(id, [{ from: 'C:\\a.txt', to: 'D:\\dest\\a.txt' }], true);
      expect(undo.canUndo).toBe(true);
      expect(reload).toHaveBeenCalled();
      expect(clipboard.has).toBe(true);
      reload.mockRestore();
    });

    it('a copy cancelled inside a folder is undoable: only what it created goes', async () => {
      const id = await transfers.start(['C:\\src'], 'D:\\dest', 'copy', 'replace');
      await transfers.applyDone({
        jobId: id,
        outputs: [],
        error: null,
        failed: [],
        cancelled: true,
        partial: {
          from: 'C:\\src',
          to: 'D:\\dest\\src',
          created: ['D:\\dest\\src\\a.txt', 'D:\\dest\\src\\new'],
        },
      });
      expect(undo.undoLabel).toBe('Undo Copy');
      await undoAnswering(true);
      expect(trashEntries).toHaveBeenLastCalledWith(['D:\\dest\\src\\a.txt', 'D:\\dest\\src\\new']);
      await undo.redo();
      expect(startTransfer).toHaveBeenLastCalledWith(['C:\\src'], 'D:\\dest', 'copy', 'replace');
    });

    it('a move cancelled inside a folder: undo removes the half copy, moves back the rest', async () => {
      const id = await transfers.start(
        ['C:\\src\\a.txt', 'C:\\src\\tree'],
        'D:\\dest',
        'move',
        'skip',
      );
      const calls = vi.mocked(startTransfer).mock.calls.length;
      await transfers.applyDone({
        jobId: id,
        outputs: [{ from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt' }],
        error: null,
        failed: [],
        cancelled: true,
        partial: { from: 'C:\\src\\tree', to: 'D:\\dest\\tree', created: ['D:\\dest\\tree'] },
      });
      await undoAnswering(true);
      // the source of the cancelled item was never deleted: its copy goes, nothing moves onto it
      expect(trashEntries).toHaveBeenLastCalledWith(['D:\\dest\\tree']);
      const sent = vi.mocked(startTransfer).mock.calls.slice(calls);
      expect(sent).toEqual([[['D:\\dest\\a.txt'], 'C:\\src', 'move', 'skip']]);
    });

    it('undo of a half copy asks first; a no removes nothing, moves nothing, drops the entry', async () => {
      const id = await transfers.start(
        ['C:\\src\\a.txt', 'C:\\src\\tree'],
        'D:\\dest',
        'move',
        'skip',
      );
      await transfers.applyDone({
        jobId: id,
        outputs: [{ from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt' }],
        error: null,
        failed: [],
        cancelled: true,
        partial: { from: 'C:\\src\\tree', to: 'D:\\dest\\tree', created: ['D:\\dest\\tree'] },
      });
      vi.mocked(trashEntries).mockClear();
      const calls = vi.mocked(startTransfer).mock.calls.length;
      const run = undo.undo();
      await new Promise((r) => setTimeout(r, 0));
      // the person may have put files into the new folder since the cancel
      expect(confirm.pending).toMatchObject({
        title: 'Undo Move',
        message:
          'The cancelled move made "tree" in "dest". Undo removes it, with anything put inside since. Remove?',
        danger: true,
      });
      confirm.answer(false);
      await expect(run).rejects.toBeInstanceOf(UndoDeclined);
      expect(trashEntries).not.toHaveBeenCalled();
      expect(vi.mocked(startTransfer).mock.calls.length).toBe(calls);
      expect(undo.canUndo).toBe(false);
      expect(undo.canRedo).toBe(false);
    });

    it('undo, redo to the end, undo: moves the whole tree back, bins nothing', async () => {
      const id = await transfers.start(
        ['C:\\src\\a.txt', 'C:\\src\\tree'],
        'D:\\dest',
        'move',
        'skip',
      );
      await transfers.applyDone({
        jobId: id,
        outputs: [{ from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt' }],
        error: null,
        failed: [],
        cancelled: true,
        partial: { from: 'C:\\src\\tree', to: 'D:\\dest\\tree', created: ['D:\\dest\\tree'] },
      });
      await undoAnswering(true);
      await undo.redo();
      const redo = transfers.jobs.at(-1)!.jobId;
      expect(startTransfer).toHaveBeenLastCalledWith(
        ['C:\\src\\a.txt', 'C:\\src\\tree'],
        'D:\\dest',
        'move',
        'skip',
      );
      // the redo finishes: C:\src\tree is gone, D:\dest\tree is the only copy
      await done(redo, [
        { from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt' },
        { from: 'C:\\src\\tree', to: 'D:\\dest\\tree' },
      ]);
      vi.mocked(trashEntries).mockClear();
      const calls = vi.mocked(startTransfer).mock.calls.length;
      await undo.undo();
      expect(confirm.pending).toBeNull();
      expect(trashEntries).not.toHaveBeenCalled();
      expect(vi.mocked(startTransfer).mock.calls.slice(calls)).toEqual([
        [['D:\\dest\\a.txt', 'D:\\dest\\tree'], 'C:\\src', 'move', 'skip'],
      ]);
    });

    it('undo pressed while a redo still runs waits for it, then moves what landed back', async () => {
      const id = await transfers.start(['C:\\src\\a.txt'], 'D:\\dest', 'move', 'skip');
      await done(id, [{ from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt' }]);
      await undo.undo();
      await undo.redo();
      const redo = transfers.jobs.at(-1)!.jobId;
      const calls = vi.mocked(startTransfer).mock.calls.length;
      const run = undo.undo();
      await new Promise((r) => setTimeout(r, 0));
      // the redo job has not finished: nothing is sent yet
      expect(vi.mocked(startTransfer).mock.calls.length).toBe(calls);
      await done(redo, [{ from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt' }]);
      await run;
      expect(vi.mocked(startTransfer).mock.calls.slice(calls)).toEqual([
        [['D:\\dest\\a.txt'], 'C:\\src', 'move', 'skip'],
      ]);
      expect(undo.undoLabel).toBe('Undo');
      expect(undo.redoLabel).toBe('Redo Move');
    });

    it('a redo that is itself cancelled inside a folder: undo removes only its half copy', async () => {
      const id = await transfers.start(['C:\\src\\tree'], 'D:\\dest', 'copy', 'replace');
      await done(id, [{ from: 'C:\\src\\tree', to: 'D:\\dest\\tree' }]);
      await undo.undo();
      expect(trashEntries).toHaveBeenLastCalledWith(['D:\\dest\\tree']);
      await undo.redo();
      const redo = transfers.jobs.at(-1)!.jobId;
      await transfers.applyDone({
        jobId: redo,
        outputs: [],
        error: null,
        failed: [],
        cancelled: true,
        partial: { from: 'C:\\src\\tree', to: 'D:\\dest\\tree', created: ['D:\\dest\\tree\\a'] },
      });
      vi.mocked(trashEntries).mockClear();
      await undoAnswering(true);
      expect(trashEntries).toHaveBeenCalledTimes(1);
      expect(trashEntries).toHaveBeenLastCalledWith(['D:\\dest\\tree\\a']);
    });

    it('a redo cancelled before anything landed leaves nothing for undo to remove', async () => {
      const id = await transfers.start(['C:\\src\\a.txt'], 'D:\\dest', 'copy', 'replace');
      await done(id, [{ from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt' }]);
      await undo.undo();
      await undo.redo();
      await done(transfers.jobs.at(-1)!.jobId, [], true);
      vi.mocked(trashEntries).mockClear();
      await undo.undo();
      expect(trashEntries).not.toHaveBeenCalled();
    });

    it('a start that fails after the dialog shows an error toast', async () => {
      vi.mocked(startTransfer).mockRejectedValueOnce(new Error('access denied'));
      transfers.pending = {
        sources: ['C:\\a.txt'],
        destination: 'D:\\dest',
        mode: 'copy',
        conflicts: ['D:\\dest\\a.txt'],
        fromCut: false,
      };
      await transfers.resolve('keep-both');
      expect(notices.list.at(-1)).toMatchObject({
        kind: 'error',
        title: 'Copy did not start',
        message: 'access denied',
      });
    });

    it('an undo move-back that falls short shows a warning with counts', async () => {
      const id = await transfers.start(
        ['C:\\src\\a.txt', 'C:\\src\\b.txt'],
        'D:\\dest',
        'move',
        'skip',
      );
      await done(id, [
        { from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt' },
        { from: 'C:\\src\\b.txt', to: 'D:\\dest\\b.txt' },
      ]);
      await undo.undo();
      const back = transfers.jobs.at(-1)!.jobId;
      await done(back, [{ from: 'D:\\dest\\a.txt', to: 'C:\\src\\a.txt' }]);
      const n = notices.list.at(-1);
      expect(n).toMatchObject({ kind: 'warning', title: 'Undo Move did not finish' });
      expect(n?.message).toContain('1 of 2 moved back');
    });
  });

  // Windows 2026-10-21: a refused extract ("locked.7z needs a password") sat on screen through
  // every later action for 5+ minutes. Nothing re-sends an archive's entries, so its row has no
  // Retry failed and no End task: it goes like an error notice does. A failed copy keeps its row.
  describe('how long a failed row stays', () => {
    const failure = (path: string) => ({
      path,
      destination: 'D:\\dest',
      error: 'Password-protected, not supported yet',
      kind: 'file' as const,
    });
    const shown = (id: number) => transfers.jobs.some((j) => j.jobId === id);

    it('a failed extract goes after the error notice time, not before', async () => {
      vi.useFakeTimers();
      try {
        const id = await transfers.adopt(
          Promise.resolve(7001),
          'extract',
          'D:\\dest',
          'keep-both',
          {
            archive: 'D:\\dest\\locked.7z',
          },
        );
        await transfers.applyDone({
          jobId: id,
          outputs: [],
          error: '1 of 1 items could not be extracted',
          failed: [failure('a.txt')],
          cancelled: false,
        });
        vi.advanceTimersByTime(TIMEOUT_MS.error - 1);
        expect(shown(id)).toBe(true);
        vi.advanceTimersByTime(1);
        expect(shown(id)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a failed copy keeps its row (Retry failed and End task live there) until dismissed', async () => {
      vi.useFakeTimers();
      try {
        const id = await transfers.start(['C:\\a.txt'], 'D:\\dest', 'copy', 'skip');
        await transfers.applyDone({
          jobId: id,
          outputs: [],
          error: '1 of 1 items could not be copied',
          failed: [failure('C:\\a.txt')],
          cancelled: false,
        });
        vi.advanceTimersByTime(10 * 60_000);
        expect(shown(id)).toBe(true);
        transfers.dismiss(id);
        expect(shown(id)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // plan 15 G.2: a Replace sends the old file to the bin first, and Undo brings it back
  describe('replace keeps the old file', () => {
    beforeEach(() => {
      notices.clear();
      vi.mocked(trashEntries).mockReset().mockResolvedValue(undefined);
      vi.mocked(undoReplace).mockClear();
      vi.mocked(restoreFromTrash).mockClear();
    });

    it('undo of a copy Replace bins the copy and brings the old file back, in one call', async () => {
      const id = await transfers.start(['C:\\a.txt', 'C:\\b.txt'], 'D:\\dest', 'copy', 'replace');
      await transfers.applyDone({
        jobId: id,
        outputs: [
          { from: 'C:\\a.txt', to: 'D:\\dest\\a.txt', replaced: 'binned' },
          { from: 'C:\\b.txt', to: 'D:\\dest\\b.txt' },
        ],
        error: null,
        failed: [],
        cancelled: false,
      });
      await undo.undo();
      // the plain copy goes to the bin as before; the replacing one goes through `undoReplace`,
      // which picks the old file BEFORE the copy joins it in the bin
      expect(trashEntries).toHaveBeenCalledWith(['D:\\dest\\b.txt']);
      expect(undoReplace).toHaveBeenCalledWith([{ path: 'D:\\dest\\a.txt', binnedAt: 0 }], true);
      expect(restoreFromTrash).not.toHaveBeenCalled();
    });

    it('undo of a copy Replace hands the bin item id on, so the undo restores that very item', async () => {
      const id = await transfers.start(['C:\\a.txt'], 'D:\\dest', 'copy', 'replace');
      await transfers.applyDone({
        jobId: id,
        outputs: [
          {
            from: 'C:\\a.txt',
            to: 'D:\\dest\\a.txt',
            replaced: 'binned',
            binnedAt: 42,
            binnedId: 'C:\\$Recycle.Bin\\S-1\\$R1.txt',
          },
        ],
        error: null,
        failed: [],
        cancelled: false,
      });
      await undo.undo();
      expect(undoReplace).toHaveBeenCalledWith(
        [{ path: 'D:\\dest\\a.txt', binnedAt: 42, binnedId: 'C:\\$Recycle.Bin\\S-1\\$R1.txt' }],
        true,
      );
    });

    it('a copy whose old file was lost undoes as before and never asks the bin for it', async () => {
      const id = await transfers.start(['C:\\a.txt'], 'N:\\dest', 'copy', 'replace');
      await transfers.applyDone({
        jobId: id,
        outputs: [{ from: 'C:\\a.txt', to: 'N:\\dest\\a.txt', replaced: 'lost' }],
        error: null,
        failed: [],
        cancelled: false,
      });
      await undo.undo();
      expect(trashEntries).toHaveBeenCalledWith(['N:\\dest\\a.txt']);
      expect(undoReplace).not.toHaveBeenCalled();
    });

    it('undo of a move Replace moves the file back, THEN restores the old one', async () => {
      const id = await transfers.start(['C:\\src\\a.txt'], 'D:\\dest', 'move', 'replace');
      await transfers.applyDone({
        jobId: id,
        outputs: [{ from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt', replaced: 'binned' }],
        error: null,
        failed: [],
        cancelled: false,
      });
      const run = undo.undo();
      await vi.waitFor(() =>
        expect(startTransfer).toHaveBeenLastCalledWith(
          ['D:\\dest\\a.txt'],
          'C:\\src',
          'move',
          'skip',
        ),
      );
      // the old file cannot come back while the moved one still holds its place
      expect(undoReplace).not.toHaveBeenCalled();
      const back = transfers.jobs.at(-1)!.jobId;
      await transfers.applyDone({
        jobId: back,
        outputs: [{ from: 'D:\\dest\\a.txt', to: 'C:\\src\\a.txt' }],
        error: null,
        failed: [],
        cancelled: false,
      });
      await run;
      expect(undoReplace).toHaveBeenCalledWith([{ path: 'D:\\dest\\a.txt', binnedAt: 0 }], false);
    });

    it('an unreadable bin stops a Move undo before anything moves', async () => {
      const id = await transfers.start(['C:\\src\\a.txt'], 'D:\\dest', 'move', 'replace');
      await transfers.applyDone({
        jobId: id,
        outputs: [
          { from: 'C:\\src\\a.txt', to: 'D:\\dest\\a.txt', replaced: 'binned', binnedAt: 42 },
        ],
        error: null,
        failed: [],
        cancelled: false,
      });
      vi.mocked(binReadable).mockRejectedValueOnce(new Error('bin unreadable'));
      vi.mocked(startTransfer).mockClear();
      await expect(undo.undo()).rejects.toThrow('bin unreadable');
      expect(startTransfer).not.toHaveBeenCalled();
      expect(undoReplace).not.toHaveBeenCalled();
    });

    it('a Replace that overwrote old files for good warns in plain words', async () => {
      const id = await transfers.start(['C:\\a.txt', 'C:\\b.txt'], 'N:\\dest', 'copy', 'replace');
      await transfers.applyDone({
        jobId: id,
        outputs: [
          { from: 'C:\\a.txt', to: 'N:\\dest\\a.txt', replaced: 'lost' },
          { from: 'C:\\b.txt', to: 'N:\\dest\\b.txt', replaced: 'lost' },
        ],
        error: null,
        failed: [],
        cancelled: false,
      });
      expect(notices.list.at(-1)).toMatchObject({
        kind: 'warning',
        title: 'Old files overwritten for good',
        message:
          'The 2 files it replaced could not go to the Recycle Bin, so Undo cannot bring them back.',
      });
    });

    it('a Replace whose old files went to the bin raises no warning', async () => {
      const id = await transfers.start(['C:\\a.txt'], 'D:\\dest', 'copy', 'replace');
      await transfers.applyDone({
        jobId: id,
        outputs: [{ from: 'C:\\a.txt', to: 'D:\\dest\\a.txt', replaced: 'binned' }],
        error: null,
        failed: [],
        cancelled: false,
      });
      expect(notices.list).toEqual([]);
    });

    it('the conflict question knows when the place has no bin', async () => {
      vi.mocked(transferConflicts).mockResolvedValueOnce(['N:\\dest\\a.txt']);
      vi.mocked(replaceNoBin).mockResolvedValueOnce('N:');
      await transfers.request(['C:\\a.txt'], 'N:\\dest', 'copy');
      expect(replaceNoBin).toHaveBeenCalledWith(['N:\\dest\\a.txt']);
      expect(transfers.pending?.noBin).toBe('N:');
    });

    it('a failed bin check still asks the question, with nothing said about the bin', async () => {
      vi.mocked(transferConflicts).mockResolvedValueOnce(['D:\\dest\\a.txt']);
      vi.mocked(replaceNoBin).mockRejectedValueOnce(new Error('boom'));
      await transfers.request(['C:\\a.txt'], 'D:\\dest', 'copy');
      expect(transfers.pending?.conflicts).toEqual(['D:\\dest\\a.txt']);
      expect(transfers.pending?.noBin).toBeNull();
    });
  });
});

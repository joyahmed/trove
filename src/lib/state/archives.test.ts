// Archive jobs on the transfer panel (plan 16, Phase 1). Every IPC is mocked: no test touches
// a real file, the real Recycle Bin or the clipboard.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archives, canExtract } from './archives.svelte';
import { transfers } from './transfers.svelte';
import { undo } from './undo.svelte';
import { tabs } from './tabs.svelte';
import { selection } from './selection.svelte';
import { confirm } from './confirm.svelte';
import { archiveConflicts, startCompress, startExtract, startExtractHere } from '$lib/api/archive';
import { startTransfer } from '$lib/api/transfer';
import { deleteEntries, trashEntries } from '$lib/api/fs';
import type { ArchiveOutput } from '$lib/types/archive';

vi.mock('$lib/api/archive', () => ({
  archiveConflicts: vi.fn(async () => [] as string[]),
  startExtract: vi.fn(async () => 0),
  startExtractHere: vi.fn(async () => 0),
  startCompress: vi.fn(async () => 0),
}));
vi.mock('$lib/api/transfer', () => ({
  startTransfer: vi.fn(async () => 0),
  cancelTransfer: vi.fn(async () => {}),
  removeMovedOriginals: vi.fn(async () => []),
  transferConflicts: vi.fn(async () => [] as string[]),
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

let nextId = 100;
const ZIP = 'D:\\in\\photos.zip';
const OUT = 'D:\\out';

const out = (to: string, created: boolean): ArchiveOutput => ({ from: ZIP, to, created });

const done = (jobId: number, outputs: ArchiveOutput[], failed = 0) =>
  transfers.applyDone({
    jobId,
    outputs,
    failed: Array.from({ length: failed }, (_, i) => ({
      path: `${ZIP}\\bad${i}`,
      destination: OUT,
      error: 'Unsafe path in archive, skipped: ../evil.txt',
      kind: 'file' as const,
    })),
    error: failed > 0 ? `${failed} of 3 items could not be extracted` : null,
    cancelled: false,
  });

/** A NoRecycleBin as `$lib/api/fs` throws it (duck-typed, see utils/no-bin). */
const noBin = () =>
  Object.assign(new Error('no bin'), { name: 'NoRecycleBin', place: 'E:', reason: 'noBin' });

describe('archives', () => {
  beforeEach(async () => {
    for (const j of [...transfers.jobs]) transfers.dismiss(j.jobId);
    transfers.pending = null;
    selection.clear();
    while (undo.canUndo) await undo.undo();
    vi.clearAllMocks();
    for (const start of [startExtract, startExtractHere, startCompress]) {
      vi.mocked(start).mockImplementation(async () => nextId++);
    }
    vi.mocked(archiveConflicts).mockResolvedValue([]);
    tabs.active.location = { kind: 'path', path: OUT };
  });

  it('canExtract: a .zip and a .7z (Phase 3) yes; a .txt and a .rar (Phase 5) not yet', () => {
    expect(canExtract('photos.zip')).toBe(true);
    expect(canExtract('PHOTOS.ZIP')).toBe(true);
    expect(canExtract('note.txt')).toBe(false);
    expect(canExtract('old.rar')).toBe(false);
    expect(canExtract('a.7z')).toBe(true);
    expect(canExtract('A.7Z')).toBe(true);
  });

  it('canExtract: the tar family (Phase 2), compound or short', () => {
    for (const name of [
      'a.tar.gz',
      'a.tgz',
      'a.tar.xz',
      'a.txz',
      'a.tar.zst',
      'a.TZST',
      'a.tar',
      'n.txt.gz',
    ])
      expect(canExtract(name), name).toBe(true);
    expect(canExtract('a.tar.bz2')).toBe(false);
  });

  it('a conflict raises the question and starts no job', async () => {
    vi.mocked(archiveConflicts).mockResolvedValue(['a.txt']);
    expect(await archives.extractTo(ZIP, OUT)).toBeNull();
    expect(archiveConflicts).toHaveBeenCalledWith(ZIP, OUT, null);
    expect(transfers.pending).toMatchObject({
      destination: OUT,
      conflicts: ['a.txt'],
      extract: { archive: ZIP, entries: null },
    });
    expect(startExtract).not.toHaveBeenCalled();
    expect(transfers.jobs).toHaveLength(0);
  });

  it('no conflict starts at once with skip, as an extract row', async () => {
    const id = await archives.extractTo(ZIP, OUT);
    expect(startExtract).toHaveBeenCalledWith(ZIP, OUT, null, 'skip');
    expect(transfers.jobs).toMatchObject([{ jobId: id, mode: 'extract', destination: OUT }]);
  });

  it("the dialog's Replace goes to the extract, not to a copy", async () => {
    vi.mocked(archiveConflicts).mockResolvedValue(['a.txt']);
    await archives.extractTo(ZIP, OUT, ['a.txt']);
    await transfers.resolve('replace');
    expect(startExtract).toHaveBeenCalledWith(ZIP, OUT, ['a.txt'], 'replace');
    expect(startTransfer).not.toHaveBeenCalled();
    expect(transfers.pending).toBeNull();
  });

  it('undo after Keep both bins only the (2) copy it made', async () => {
    const id = (await archives.extractTo(ZIP, OUT, null, 'keep-both')) as number;
    await done(id, [out(`${OUT}\\a (2).txt`, true)]);
    expect(undo.undoLabel).toBe('Undo Extract');
    await undo.undo();
    expect(trashEntries).toHaveBeenCalledWith([`${OUT}\\a (2).txt`]);
  });

  it('undo after a Replace pushes nothing: a replaced file is never binned', async () => {
    const id = (await archives.extractTo(ZIP, OUT, null, 'replace')) as number;
    await done(id, [out(`${OUT}\\a.txt`, false)]);
    expect(undo.canUndo).toBe(false);
  });

  it('undo after a Replace-merge into a folder bins only the files it created there', async () => {
    const id = (await archives.extractTo(ZIP, OUT, null, 'replace')) as number;
    await done(id, [out(`${OUT}\\f\\new.txt`, true), out(`${OUT}\\f\\old.txt`, false)]);
    await undo.undo();
    expect(trashEntries).toHaveBeenCalledWith([`${OUT}\\f\\new.txt`]);
    expect(vi.mocked(trashEntries).mock.calls.flat(2)).not.toContain(`${OUT}\\f`);
  });

  it('undo where there is no bin asks first, and a no deletes nothing', async () => {
    const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(false);
    vi.mocked(trashEntries).mockRejectedValueOnce(noBin());
    const id = (await archives.extractTo(ZIP, OUT)) as number;
    await done(id, [out(`${OUT}\\a.txt`, true)]);
    await expect(undo.undo()).rejects.toThrow(/not deleted/);
    expect(ask).toHaveBeenCalledOnce();
    expect(deleteEntries).not.toHaveBeenCalled();
    ask.mockRestore();
  });

  it('undo where there is no bin deletes for good after a yes', async () => {
    const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(true);
    vi.mocked(trashEntries).mockRejectedValueOnce(noBin());
    const id = (await archives.extractTo(ZIP, OUT)) as number;
    await done(id, [out(`${OUT}\\a.txt`, true)]);
    await undo.undo();
    expect(deleteEntries).toHaveBeenCalledWith([`${OUT}\\a.txt`]);
    ask.mockRestore();
  });

  it('redo of an extract that asked nothing re-runs with Keep both, then undoes the new run', async () => {
    const id = (await archives.extractTo(ZIP, OUT)) as number;
    await done(id, [out(`${OUT}\\a.txt`, true)]);
    await undo.undo();
    await undo.redo();
    expect(startExtract).toHaveBeenLastCalledWith(ZIP, OUT, null, 'keep-both');
    const redoId = transfers.jobs.at(-1)!.jobId;
    await done(redoId, [out(`${OUT}\\a (2).txt`, true)]);
    expect(undo.canUndo).toBe(true); // the redo's own done pushed no second entry
    await undo.undo();
    expect(trashEntries).toHaveBeenLastCalledWith([`${OUT}\\a (2).txt`]);
  });

  it('extract here lists its row beside the archive and selects the new folder', async () => {
    tabs.active.location = { kind: 'path', path: 'D:\\in' };
    const id = await archives.extractHere(ZIP);
    expect(startExtractHere).toHaveBeenCalledWith(ZIP);
    expect(transfers.jobs[0]).toMatchObject({ mode: 'extract', destination: 'D:\\in' });
    await done(id, [out('D:\\in\\photos', true)]);
    expect(selection.has('D:\\in\\photos')).toBe(true);
    await undo.undo();
    expect(trashEntries).toHaveBeenCalledWith(['D:\\in\\photos']);
  });

  it('compress names the archive on its row, then the name Rust chose', async () => {
    const id = await archives.compress(['D:\\in\\photos'], 'zip');
    expect(startCompress).toHaveBeenCalledWith(['D:\\in\\photos'], 'zip');
    expect(transfers.jobs[0]).toMatchObject({ mode: 'compress', label: 'photos.zip' });
    await done(id, [{ from: 'D:\\in\\photos', to: 'D:\\in\\photos (2).zip', created: true }]);
    expect(transfers.jobs[0].label).toBe('photos (2).zip');
    expect(undo.undoLabel).toBe('Undo Compress');
    await undo.undo();
    expect(trashEntries).toHaveBeenCalledWith(['D:\\in\\photos (2).zip']);
  });

  // macOS with Finder's Apple Events denied and the file manager failing too (core/trash_mac.rs):
  // the zip-undo asks the plain question, and Cancel deletes nothing — never a raw error toast.
  it('undo of a zip where macOS refused the Trash asks, and Cancel deletes nothing', async () => {
    const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(false);
    const id = await archives.compress(['D:\\in\\photos'], 'zip');
    await done(id, [{ from: 'D:\\in\\photos', to: 'D:\\in\\photos.zip', created: true }]);
    vi.mocked(trashEntries).mockRejectedValueOnce(
      Object.assign(new Error('macOS did not let Trove use the Trash'), {
        name: 'NoRecycleBin',
        place: 'This Mac',
        reason: 'denied',
        paths: ['D:\\in\\photos.zip'],
      }),
    );
    await expect(undo.undo()).rejects.toThrow(/not deleted/);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0][0].message).toMatch(
      /^macOS did not let Trove use the (Trash|Recycle Bin) — permanently delete the ZIP file\?$/,
    );
    expect(deleteEntries).not.toHaveBeenCalled();
    ask.mockRestore();
  });

  it('compress of several items is called Archive.zip', async () => {
    await archives.compress(['D:\\in\\a.txt', 'D:\\in\\b.txt']);
    expect(transfers.jobs[0].label).toBe('Archive.zip');
  });

  it('a done that beats the job id is kept for the adopted row', async () => {
    let release!: (id: number) => void;
    vi.mocked(startExtractHere).mockImplementationOnce(
      () => new Promise<number>((r) => (release = r)),
    );
    const started = archives.extractHere(ZIP);
    await done(555, [out('D:\\in\\photos', true)]);
    release(555);
    await started;
    expect(transfers.jobs[0]).toMatchObject({ jobId: 555, done: true });
  });

  it('Retry failed does nothing on an archive row', async () => {
    const id = (await archives.extractTo(ZIP, OUT)) as number;
    await done(id, [out(`${OUT}\\a.txt`, true)], 1);
    await transfers.retryFailed(id);
    expect(startTransfer).not.toHaveBeenCalled();
    expect(startExtract).toHaveBeenCalledOnce();
    expect(transfers.jobs[0].failed).toHaveLength(1);
  });
});

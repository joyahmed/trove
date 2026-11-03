import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transfers } from '$lib/state/transfers.svelte';
import { comingFrom } from '$lib/state/coming-from.svelte';
import { useTransferPanel } from './use-transfer-panel.svelte';
import { startCompress, startExtract, startExtractHere } from '$lib/api/archive';
import { startTransfer } from '$lib/api/transfer';

vi.mock('$lib/api/archive', () => ({
  archiveConflicts: vi.fn(async () => [] as string[]),
  startExtract: vi.fn(async () => 0),
  startExtractHere: vi.fn(async () => 0),
  startCompress: vi.fn(async () => 0),
}));
vi.mock('$lib/api/transfer', () => ({
  startTransfer: vi.fn(async () => 1),
  cancelTransfer: vi.fn(async () => {}),
  removeMovedOriginals: vi.fn(async () => []),
  transferConflicts: vi.fn(async () => [] as string[]),
  onTransferProgress: vi.fn(async () => () => {}),
  onTransferDone: vi.fn(async () => () => {}),
}));
vi.mock('$lib/api/clipboard', () => ({}));
vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  trashEntries: vi.fn(async () => {}),
  deleteEntries: vi.fn(async () => {}),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
}));

const { archives } = await import('$lib/state/archives.svelte');

describe('useTransferPanel with archive rows', () => {
  beforeEach(() => {
    for (const j of [...transfers.jobs]) transfers.dismiss(j.jobId);
  });

  it('a compress row names its archive; an extract row its folder; neither offers Retry', async () => {
    vi.mocked(startCompress).mockResolvedValueOnce(201);
    vi.mocked(startExtract).mockResolvedValueOnce(202);
    await archives.compress(['C:\\in\\photos'], 'zip');
    await archives.extractTo('C:\\in\\photos.zip', 'C:\\out');
    await transfers.start(['C:\\a.txt'], 'C:\\out', 'copy', 'skip');
    const rows = useTransferPanel().rows;
    expect(rows.map((r) => r.title)).toEqual([
      'Compressing photos.zip',
      'Extracting to out',
      'Copying to out',
    ]);
    expect(rows.map((r) => r.canRetry)).toEqual([false, false, true]);
  });

  it('a running job not sized yet says Preparing, never "0 B of 0 B"; sized, it shows the bytes', async () => {
    await transfers.start(['C:\\a.txt'], 'C:\\out', 'copy', 'skip');
    const id = transfers.jobs[0].jobId;
    expect(useTransferPanel().rows[0].amount).toBe('Preparing…');
    transfers.applyProgress({ jobId: id, bytesDone: 10, bytesTotal: 40, current: 'C:\\a.txt' });
    expect(useTransferPanel().rows[0].amount).toBe('10 B of 40 B');
    // a real 0-byte job ends: its row keeps its own done text, with no amount
    await transfers.applyDone({
      jobId: id,
      outputs: [],
      failed: [],
      error: null,
      cancelled: false,
    });
    const row = useTransferPanel().rows[0];
    expect(row.amount).toBe('');
    expect(row.title).toMatch(/^Copied to /);
  });

  it('done rows say Compressed / Extracted', async () => {
    vi.mocked(startCompress).mockResolvedValueOnce(301);
    vi.mocked(startExtract).mockResolvedValueOnce(302);
    await archives.compress(['C:\\in\\photos'], 'zip');
    await archives.extractTo('C:\\in\\photos.zip', 'C:\\out');
    const base = { failed: [], error: null, cancelled: false };
    await transfers.applyDone({ jobId: 301, outputs: [], ...base });
    await transfers.applyDone({ jobId: 302, outputs: [], ...base });
    expect(useTransferPanel().rows.map((r) => r.title)).toEqual([
      'Compressed photos.zip',
      'Extracted to out',
    ]);
  });

  it('a refused password-protected extract says so, not "Extracted to"', async () => {
    vi.mocked(startExtract).mockResolvedValueOnce(306);
    await archives.extractTo('C:\\in\\locked.7z', 'C:\\out');
    const failed = [
      {
        path: 'secret.txt',
        destination: 'C:\\out',
        error: 'Password-protected, not supported yet',
        kind: 'file' as const,
      },
    ];
    await transfers.applyDone({ jobId: 306, outputs: [], failed, error: null, cancelled: false });
    expect(useTransferPanel().rows.map((r) => r.title)).toEqual([
      "locked.7z needs a password - Trove can't open protected archives yet",
    ]);
  });

  it('an extract that fails otherwise names the archive; a partial one says some failed', async () => {
    vi.mocked(startExtract).mockResolvedValueOnce(307).mockResolvedValueOnce(308);
    await archives.extractTo('C:\\in\\bad.zip', 'C:\\out');
    await archives.extractTo('C:\\in\\half.zip', 'C:\\out');
    const base = { cancelled: false };
    await transfers.applyDone({ jobId: 307, outputs: [], failed: [], error: 'disk full', ...base });
    const failed = [
      { path: 'b.txt', destination: 'C:\\out', error: 'nope', kind: 'file' as const },
    ];
    const outputs = [{ from: 'C:\\in\\half.zip', to: 'C:\\out\\a.txt', created: true }];
    await transfers.applyDone({ jobId: 308, outputs, failed, error: null, ...base });
    expect(useTransferPanel().rows.map((r) => r.title)).toEqual([
      'Could not extract bad.zip',
      'Extracted to out, but 1 item could not be',
    ]);
  });

  it('an extract that created a folder names that folder, not the one it started in', async () => {
    vi.mocked(startExtractHere).mockResolvedValueOnce(303);
    await archives.extractHere('C:\\in\\pack.tar.gz');
    const base = { failed: [], error: null, cancelled: false };
    const outputs = [
      { from: 'C:\\in\\pack.tar.gz', to: 'C:\\in\\trove-tar-test\\pack', created: true },
    ];
    await transfers.applyDone({ jobId: 303, outputs, ...base });
    expect(useTransferPanel().rows.map((r) => r.title)).toEqual(['Extracted to pack']);
  });

  it('an extract that only replaced files names the target folder', async () => {
    vi.mocked(startExtract).mockResolvedValueOnce(304);
    await archives.extractTo('C:\\in\\pack.tar.gz', 'C:\\in\\trove-tar-test', null, 'replace');
    const base = { failed: [], error: null, cancelled: false };
    const outputs = [
      { from: 'C:\\in\\pack.tar.gz', to: 'C:\\in\\trove-tar-test\\a.txt', created: false },
    ];
    await transfers.applyDone({ jobId: 304, outputs, ...base });
    expect(useTransferPanel().rows.map((r) => r.title)).toEqual(['Extracted to trove-tar-test']);
  });

  it('a single loose file extracted into an existing folder names that folder', async () => {
    vi.mocked(startExtract).mockResolvedValueOnce(305);
    await archives.extractTo('C:\\in\\pack.tar.gz', 'C:\\in\\trove-tar-test', null, 'skip');
    const base = { failed: [], error: null, cancelled: false };
    const outputs = [
      { from: 'C:\\in\\pack.tar.gz', to: 'C:\\in\\trove-tar-test\\a.txt', created: true },
    ];
    await transfers.applyDone({ jobId: 305, outputs, ...base });
    expect(useTransferPanel().rows.map((r) => r.title)).toEqual(['Extracted to trove-tar-test']);
  });
});

describe('the row action label', () => {
  it('is Cancel while a copy, move or compress runs, Dismiss once it ended', async () => {
    for (const j of [...transfers.jobs]) transfers.dismiss(j.jobId);
    vi.mocked(startCompress).mockResolvedValueOnce(401);
    await archives.compress(['C:\\in\\photos'], 'zip');
    await transfers.start(['C:\\a.txt'], 'C:\\out', 'move', 'skip');
    expect(useTransferPanel().rows.map((r) => r.actionLabel)).toEqual(['Cancel', 'Cancel']);
    await transfers.applyDone({
      jobId: 401,
      outputs: [],
      failed: [],
      error: null,
      cancelled: false,
    });
    expect(useTransferPanel().rows.map((r) => r.actionLabel)).toEqual(['Dismiss', 'Cancel']);
  });
});

describe('the headline of a copy or move that ended short', () => {
  const sources = ['C:\\out\\a.txt', 'C:\\out\\b.txt', 'C:\\out\\c.txt'];
  const undo = { purpose: 'undo' as const, sent: 3, record: false };
  const landed = (n: number) =>
    sources.slice(0, n).map((from) => ({ from, to: from.replace('out', 'src') }));
  const finish = async (jobId: number, outputs: { from: string; to: string }[]) => {
    await transfers.applyDone({ jobId, outputs, failed: [], error: null, cancelled: false });
    return useTransferPanel().rows.find((r) => r.jobId === jobId)?.title;
  };

  beforeEach(() => {
    for (const j of [...transfers.jobs]) transfers.dismiss(j.jobId);
  });

  it('an undo where all 3 were skipped: "Nothing moved back", not "Moved to src"', async () => {
    vi.mocked(startTransfer).mockResolvedValueOnce(501);
    await transfers.start(sources, 'C:\\src', 'move', 'skip', undo);
    expect(await finish(501, [])).toBe('Nothing moved back');
  });

  it('an undo that moved 1 of 3 back says so', async () => {
    vi.mocked(startTransfer).mockResolvedValueOnce(502);
    await transfers.start(sources, 'C:\\src', 'move', 'skip', undo);
    expect(await finish(502, landed(1))).toBe('Moved 1 of 3 back to src');
  });

  it('an undo that moved all 3 back keeps the plain headline', async () => {
    vi.mocked(startTransfer).mockResolvedValueOnce(503);
    await transfers.start(sources, 'C:\\src', 'move', 'skip', undo);
    expect(await finish(503, landed(3))).toBe('Moved to src');
  });

  it('a retried copy that landed 2 of 3 counts them', async () => {
    vi.mocked(startTransfer).mockResolvedValueOnce(504);
    await transfers.start(sources, 'C:\\in', 'copy', 'skip', { purpose: 'retry', sent: 3 });
    expect(await finish(504, landed(2))).toBe('Copied 2 of 3 to in');
  });

  it('a paste where nothing arrived: "Nothing copied" / "Nothing moved"', async () => {
    const failed = sources.map((path) => ({
      path,
      destination: 'C:\\in',
      error: 'Access is denied. (os error 5)',
      kind: 'file' as const,
    }));
    for (const [jobId, mode, word] of [
      [505, 'copy', 'copied'],
      [506, 'move', 'moved'],
    ] as const) {
      vi.mocked(startTransfer).mockResolvedValueOnce(jobId);
      await transfers.start(sources, 'C:\\in', mode, 'skip');
      await transfers.applyDone({
        jobId,
        outputs: [],
        failed,
        error: `3 of 3 items could not be ${word}`,
        cancelled: false,
      });
      expect(useTransferPanel().rows.find((r) => r.jobId === jobId)?.title).toBe(`Nothing ${word}`);
    }
  });

  it('a paste where some arrived keeps "Copied to in": the red line has the file count', async () => {
    vi.mocked(startTransfer).mockResolvedValueOnce(507);
    await transfers.start(sources, 'C:\\in', 'copy', 'skip');
    const error = '1 of 3 items could not be copied';
    await transfers.applyDone({
      jobId: 507,
      outputs: landed(2),
      failed: [],
      error,
      cancelled: false,
    });
    expect(useTransferPanel().rows.find((r) => r.jobId === 507)?.title).toBe('Copied to in');
  });
});

// Plan 19 Q3 / 3.2 (Joy 2026-10-19): a Rust sentence about the bin names it in the "I'm coming
// from" word. Rust writes the host's word ("Recycle Bin" on Windows, "Trash" on a Mac); the
// panel rewrites it when it shows the row. Fails on the old panel, which showed Rust's text as is.
describe('useTransferPanel names the bin by the coming-from style', () => {
  const reason =
    'the file it would replace could not go to the Recycle Bin, so nothing was replaced: Access is denied.';
  const jobError =
    'C:\\in\\a.txt failed. The file it was replacing is in the Recycle Bin: put it back from there';

  beforeEach(() => {
    for (const j of [...transfers.jobs]) transfers.dismiss(j.jobId);
  });
  afterEach(() => {
    comingFrom.choice = 'native';
  });

  it('the failed item and the red line say Trash in Mac style, Recycle Bin in Windows style', async () => {
    vi.mocked(startTransfer).mockResolvedValueOnce(801);
    await transfers.start(['C:\\a\\Trash.txt'], 'C:\\in', 'copy', 'replace');
    await transfers.applyDone({
      jobId: 801,
      outputs: [],
      failed: [
        {
          path: 'C:\\a\\Trash.txt',
          destination: 'C:\\in',
          error: `${reason} (os error 5)`,
          kind: 'file' as const,
        },
      ],
      error: jobError,
      cancelled: false,
    });
    const row = () => useTransferPanel().rows.find((r) => r.jobId === 801);

    comingFrom.choice = 'mac';
    expect(row()?.failed[0].reason).toBe(
      'the file it would replace could not go to the Trash, so nothing was replaced: Access is denied.',
    );
    expect(row()?.failed[0].name).toBe('Trash.txt');
    expect(row()?.error).toBe(
      'C:\\in\\a.txt failed. The file it was replacing is in the Trash: put it back from there',
    );

    comingFrom.choice = 'windows';
    expect(row()?.failed[0].reason).toBe(reason);
    expect(row()?.error).toBe(jobError);
  });
});

describe('a stopped or retried row', () => {
  beforeEach(() => {
    for (const j of [...transfers.jobs]) transfers.dismiss(j.jobId);
  });

  it('a cancelled row keeps its real progress and says it was cancelled, not a full bar', async () => {
    vi.mocked(startTransfer).mockResolvedValueOnce(601);
    await transfers.start(['C:\\big.bin'], 'C:\\out', 'copy', 'skip');
    transfers.applyProgress({ jobId: 601, bytesDone: 10, bytesTotal: 40, current: 'C:\\big.bin' });
    await transfers.applyDone({
      jobId: 601,
      outputs: [],
      failed: [],
      error: null,
      cancelled: true,
    });
    expect(useTransferPanel().rows[0]).toMatchObject({
      title: 'Cancelled',
      percent: 25,
      cancelled: true,
    });
  });

  it('a finished row still reads 100 and is not cancelled', async () => {
    vi.mocked(startTransfer).mockResolvedValueOnce(602);
    await transfers.start(['C:\\a.txt'], 'C:\\out', 'copy', 'skip');
    transfers.applyProgress({ jobId: 602, bytesDone: 1, bytesTotal: 40, current: 'a.txt' });
    await transfers.applyDone({
      jobId: 602,
      outputs: [],
      failed: [],
      error: null,
      cancelled: false,
    });
    expect(useTransferPanel().rows[0]).toMatchObject({ percent: 100, cancelled: false });
  });

  it('Retry of an undeleted original names the folder moved to, not the copy of the source folder', async () => {
    vi.mocked(startTransfer).mockResolvedValueOnce(603);
    const id = await transfers.start(['C:\\tmp\\rk'], 'D:\\usbmnt', 'move', 'skip');
    await transfers.applyDone({
      jobId: id,
      outputs: [{ from: 'C:\\tmp\\rk', to: 'D:\\usbmnt\\rk' }],
      // the copy sits in D:\usbmnt\rk: a folder named like the source
      failed: [
        {
          path: 'C:\\tmp\\rk\\x.txt',
          destination: 'D:\\usbmnt\\rk',
          error: 'Permission denied',
          kind: 'not-removed',
        },
      ],
      error: '1 item(s) arrived, but the original could not be deleted',
      cancelled: false,
    });
    await transfers.retryFailed(id);
    expect(useTransferPanel().rows.at(-1)!.title).toBe('Moved to usbmnt');
  });
});

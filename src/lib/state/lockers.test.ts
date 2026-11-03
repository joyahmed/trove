import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockedPath, Locker } from '$lib/api/lockers';
import { confirm } from './confirm.svelte';
import { notices } from './notices.svelte';
import {
  endTask,
  lockedMessage,
  notifyLocked,
  OTHER_SESSION,
  TERMINAL_HAS_IT,
  TROVE_ITSELF,
  WINDOWS_NEEDS,
} from './lockers.svelte';
import { transfers } from './transfers.svelte';
import { useTransferPanel } from '$lib/hooks/use-transfer-panel.svelte';

const whoIsLocking = vi.fn<(paths: string[], error: string) => Promise<LockedPath[]>>(
  async () => [],
);
const endLockingApp = vi.fn<(path: string, pid: number, force: boolean) => Promise<string>>(
  async () => 'ended',
);
vi.mock('$lib/api/lockers', () => ({
  whoIsLocking: (paths: string[], error: string) => whoIsLocking(paths, error),
  endLockingApp: (path: string, pid: number, force: boolean) => endLockingApp(path, pid, force),
}));
vi.mock('$lib/api/log', () => ({ logError: vi.fn() }));
vi.mock('$lib/api/transfer', () => ({
  startTransfer: vi.fn(async () => 1),
  cancelTransfer: vi.fn(async () => {}),
  removeMovedOriginals: vi.fn(async () => []),
  transferConflicts: vi.fn(async () => [] as string[]),
  onTransferProgress: vi.fn(async () => () => {}),
  onTransferDone: vi.fn(async () => () => {}),
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

const DOC = 'C:\\trove-test\\report.docx';
const IN_USE =
  'The process cannot access the file because it is being used by another process. (os error 32)';
const word: Locker = {
  pid: 4242,
  app: 'Microsoft Word',
  exe: 'WINWORD.EXE',
  canEnd: true,
  noEnd: null,
};
const critical: Locker = {
  pid: 600,
  app: 'Windows Explorer',
  exe: 'explorer.exe',
  canEnd: false,
  noEnd: 'windows',
};
const trove: Locker = { pid: 77, app: 'Trove', exe: 'trove.exe', canEnd: false, noEnd: 'trove' };
const shell: Locker = {
  pid: 78,
  app: 'PowerShell',
  exe: 'pwsh.exe',
  canEnd: false,
  noEnd: 'terminal',
};

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  notices.clear();
  confirm.answer(false);
  whoIsLocking.mockReset().mockResolvedValue([]);
  endLockingApp.mockReset().mockResolvedValue('ended');
});

describe('the notice for a file in use', () => {
  it('names the app and the file, with Retry and End task', async () => {
    whoIsLocking.mockResolvedValue([{ path: DOC, lockers: [word] }]);
    const retry = vi.fn();
    expect(await notifyLocked([DOC], IN_USE, retry)).toBe(true);
    expect(whoIsLocking).toHaveBeenCalledWith([DOC], IN_USE);
    const [n] = notices.list;
    expect(n.message).toBe('Microsoft Word has report.docx open');
    expect(n.action?.label).toBe('Retry');
    expect(n.second?.label).toBe('End task');
    n.action?.run();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('a program Windows needs gets no End task, and says to close it yourself', async () => {
    whoIsLocking.mockResolvedValue([{ path: DOC, lockers: [critical] }]);
    await notifyLocked([DOC], IN_USE, vi.fn());
    const [n] = notices.list;
    expect(n.message).toBe(`Windows Explorer has report.docx open. ${WINDOWS_NEEDS}`);
    expect(n.action?.label).toBe('Retry');
    expect(n.second).toBeUndefined();
  });

  it('nobody holds it (any other error, or not Windows): no notice, the caller shows its own', async () => {
    expect(await notifyLocked([DOC], 'Access is denied. (os error 5)', vi.fn())).toBe(false);
    expect(notices.list).toHaveLength(0);
  });

  it('a failed lookup counts as nobody', async () => {
    whoIsLocking.mockRejectedValue(new Error('no backend'));
    expect(await notifyLocked([DOC], IN_USE, vi.fn())).toBe(false);
  });

  it('Trove itself, or its terminal, holding it says so — no End task', async () => {
    whoIsLocking.mockResolvedValue([{ path: DOC, lockers: [trove] }]);
    await notifyLocked([DOC], IN_USE, vi.fn());
    expect(notices.list[0].message).toBe(TROVE_ITSELF);
    expect(notices.list[0].second).toBeUndefined();
    notices.clear();
    whoIsLocking.mockResolvedValue([{ path: DOC, lockers: [shell] }]);
    await notifyLocked([DOC], IN_USE, vi.fn());
    expect(notices.list[0].message).toBe(TERMINAL_HAS_IT);
    expect(notices.list[0].second).toBeUndefined();
  });

  it('a program in another Windows session: named, and why there is no End task', async () => {
    const other: Locker = { ...word, canEnd: false, noEnd: 'otherSession' };
    whoIsLocking.mockResolvedValue([{ path: DOC, lockers: [other] }]);
    await notifyLocked([DOC], IN_USE, vi.fn());
    expect(notices.list[0].message).toBe(`Microsoft Word has report.docx open. ${OTHER_SESSION}`);
  });

  it('a batch delete: the held file is named, and the others that failed are not dropped', async () => {
    const other = 'C:\\trove-test\\b.txt: Access is denied. (os error 5)';
    const error = `2 items could not be deleted — ${DOC}: ${IN_USE}; ${other}`;
    whoIsLocking.mockResolvedValue([{ path: DOC, lockers: [word] }]);
    await notifyLocked([DOC, 'C:\\trove-test\\b.txt'], error, vi.fn());
    expect(notices.list[0].message).toBe(
      `Microsoft Word has report.docx open + 1 other item could not be deleted — ${other}`,
    );
  });

  it('a batch where only held files failed adds nothing', async () => {
    const error = `1 items could not be deleted — ${DOC}: ${IN_USE}`;
    whoIsLocking.mockResolvedValue([{ path: DOC, lockers: [word] }]);
    await notifyLocked([DOC], error, vi.fn());
    expect(notices.list[0].message).toBe('Microsoft Word has report.docx open');
  });

  it('two programs are both named', () => {
    const excel = { ...word, pid: 7, app: 'Excel' };
    expect(lockedMessage(DOC, [word, excel])).toBe(
      'Microsoft Word and Excel have report.docx open',
    );
  });
});

describe('End task', () => {
  it('asks first, with Cancel as the default; Cancel ends nothing and retries nothing', async () => {
    const retry = vi.fn();
    const done = endTask(DOC, word, retry);
    await settle();
    expect(confirm.pending?.title).toBe('End task');
    expect(confirm.pending?.message).toBe('End Microsoft Word? Unsaved work in it will be lost.');
    expect(confirm.pending?.cancelDefault).toBe(true);
    expect(confirm.pending?.danger).toBe(true);
    confirm.answer(false);
    expect(await done).toBe(false);
    expect(endLockingApp).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('yes: closes politely (no force), then retries once by itself', async () => {
    const retry = vi.fn();
    const done = endTask(DOC, word, retry);
    await settle();
    confirm.answer(true);
    expect(await done).toBe(true);
    expect(endLockingApp).toHaveBeenCalledExactlyOnceWith(DOC, 4242, false);
    expect(retry).toHaveBeenCalledOnce();
  });

  it('still running after the polite close: Force end is a second question', async () => {
    endLockingApp.mockResolvedValueOnce('stillRunning');
    const retry = vi.fn();
    const done = endTask(DOC, word, retry);
    await settle();
    confirm.answer(true);
    await settle();
    expect(confirm.pending?.title).toBe('Force end');
    expect(confirm.pending?.message).toBe(
      'Microsoft Word did not close. It may be asking you to save — check it first. Force end it? Unsaved work will be lost.',
    );
    expect(confirm.pending?.cancelDefault).toBe(true);
    confirm.answer(true);
    expect(await done).toBe(true);
    expect(endLockingApp.mock.calls).toEqual([
      [DOC, 4242, false],
      [DOC, 4242, true],
    ]);
    expect(retry).toHaveBeenCalledOnce();
  });

  it('no to Force end: it is left running and nothing retries', async () => {
    endLockingApp.mockResolvedValueOnce('stillRunning');
    const retry = vi.fn();
    const done = endTask(DOC, word, retry);
    await settle();
    confirm.answer(true);
    await settle();
    confirm.answer(false);
    expect(await done).toBe(false);
    expect(endLockingApp).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('a program Windows needs is never ended, not even asked about', async () => {
    expect(await endTask(DOC, critical, vi.fn())).toBe(false);
    expect(confirm.pending).toBeNull();
    expect(endLockingApp).not.toHaveBeenCalled();
    expect(notices.list[0].message).toContain(WINDOWS_NEEDS);
  });

  it('Trove itself is never ended either, and says so', async () => {
    expect(await endTask(DOC, trove, vi.fn())).toBe(false);
    expect(confirm.pending).toBeNull();
    expect(endLockingApp).not.toHaveBeenCalled();
    expect(notices.list[0].message).toBe(TROVE_ITSELF);
  });
});

describe('the progress row of a move whose original is in use', () => {
  it('names the app instead of the OS sentence and offers End task', async () => {
    whoIsLocking.mockImplementation(async (paths) =>
      paths[0] === DOC ? [{ path: DOC, lockers: [word] }] : [],
    );
    for (const j of [...transfers.jobs]) transfers.dismiss(j.jobId);
    await transfers.start([DOC], 'C:\\out', 'move', 'skip');
    const [job] = transfers.jobs;
    await transfers.applyDone({
      jobId: job.jobId,
      outputs: [],
      failed: [
        { path: DOC, destination: 'C:\\out', error: IN_USE, kind: 'not-removed' },
        {
          path: 'C:\\trove-test\\b.txt',
          destination: 'C:\\out',
          error: 'Access is denied. (os error 5)',
          kind: 'file',
        },
      ],
      error: '2 of 2 items could not be moved',
      cancelled: false,
    });
    await settle();
    const [row] = useTransferPanel().rows;
    expect(row.failed[0].locked).toEqual({
      message: 'Microsoft Word has report.docx open',
      locker: word,
    });
    expect(row.failed[1].locked).toBeNull();
    expect(row.failed[1].reason).toBe('Access is denied.');
    expect(row.canRetry).toBe(true);
  });

  it('only programs Windows needs: the row says so and has no End task', async () => {
    whoIsLocking.mockResolvedValue([{ path: DOC, lockers: [critical] }]);
    for (const j of [...transfers.jobs]) transfers.dismiss(j.jobId);
    await transfers.start([DOC], 'C:\\out', 'move', 'skip');
    const [job] = transfers.jobs;
    await transfers.applyDone({
      jobId: job.jobId,
      outputs: [],
      failed: [{ path: DOC, destination: 'C:\\out', error: IN_USE, kind: 'file' }],
      error: '1 of 1 items could not be moved',
      cancelled: false,
    });
    await settle();
    const [row] = useTransferPanel().rows;
    expect(row.failed[0].locked?.locker).toBeNull();
    expect(row.failed[0].locked?.message).toContain(WINDOWS_NEEDS);
  });

  it('after End task worked, a row still shown has no End task for that file', async () => {
    whoIsLocking.mockResolvedValue([{ path: DOC, lockers: [word] }]);
    for (const j of [...transfers.jobs]) transfers.dismiss(j.jobId);
    await transfers.start([DOC], 'C:\\out', 'move', 'skip');
    const [job] = transfers.jobs;
    await transfers.applyDone({
      jobId: job.jobId,
      outputs: [],
      failed: [{ path: DOC, destination: 'C:\\out', error: IN_USE, kind: 'file' }],
      error: '1 of 1 items could not be moved',
      cancelled: false,
    });
    await settle();
    // an archive job's row: Retry failed cannot re-send it, so the row stays after End task
    job.mode = 'extract';
    expect(useTransferPanel().rows[0].failed[0].locked?.locker).toEqual(word);
    const done = transfers.endTask(job.jobId, DOC, word);
    await settle();
    confirm.answer(true);
    await done;
    expect(endLockingApp).toHaveBeenCalledExactlyOnceWith(DOC, 4242, false);
    expect(useTransferPanel().rows[0].failed[0].locked).toBeNull();
  });
});

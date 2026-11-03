// The progress panel's reactivity: one row per running or just-finished job, with the text
// the row shows. Returns getters so the component stays live.
import { isTransferMode, transfers, type TransferJob } from '$lib/state/transfers.svelte';
import type { LockedPath, Locker } from '$lib/api/lockers';
import { endable, heldMessage } from '$lib/state/lockers.svelte';
import type { TransferFailure } from '$lib/types/transfer';
import { fmtSpace } from '$lib/utils/format';
import { locationLabel, pathLocation } from '$lib/utils/location';
import { inBinWords } from '$lib/utils/platform';

export interface TransferRowView {
  jobId: number;
  /** "Copying to Documents" / "Moved to Documents" / "Cancelled" */
  title: string;
  /** "12.5 MB of 1.20 GB" while running, empty when done */
  amount: string;
  current: string;
  /** 0–100; a cancelled row keeps how far it got */
  percent: number;
  /** the job was cancelled: its bar stays where it stopped, in a muted colour */
  cancelled: boolean;
  running: boolean;
  /** what the row's one "×" does and is called: Cancel while it runs, Dismiss once it ended */
  actionLabel: 'Cancel' | 'Dismiss';
  error: string | null;
  /** the first few items that did not arrive */
  failed: FailedItemView[];
  /** how many more did not arrive beyond `failed` ("+N more") */
  moreFailed: number;
  /** Retry failed is offered: a copy / move only — an archive's failed entries are inside an
   * archive, and nothing re-sends them */
  canRetry: boolean;
}

export interface FailedItemView {
  /** the file or folder name */
  name: string;
  /** the OS's reason without its "(os error 32)" tail */
  reason: string;
  /** the full path, for the hover */
  path: string;
  /** a program holds it open (plan 21B): what the row says instead of `reason`, and the one
   * End task would close — null when only programs Windows needs hold it (no End task) */
  locked: { message: string; locker: Locker | null } | null;
}

/** How many failed items a row names before "+N more". */
const FAILED_SHOWN = 5;

const VERB: Record<TransferJob['mode'], [running: string, done: string]> = {
  copy: ['Copying', 'Copied'],
  move: ['Moving', 'Moved'],
  compress: ['Compressing', 'Compressed'],
  extract: ['Extracting', 'Extracted'],
};

/**
 * "Copied to Documents"; a job with a label names that instead ("Compressed photos.zip").
 *
 * ⛔ A copy / move that ended short says so in the headline too: an Undo Move where all 3 were
 * skipped read "Moved to src" above a red "3 of 3 did not move back" (Mac, 2026-10-12). Nothing
 * landed: "Nothing moved back" / "Nothing copied". Some of what a Retry, Undo or Redo sent:
 * "Moved 1 of 3 back to src". A plain paste names no count: Rust's line under it counts files
 * inside folders, and the headline would disagree with it.
 */
/**
 * ⛔ An extract that was refused or failed never reads "Extracted to <folder>" (Ubuntu C.8.3: a
 * password-protected 7z, refused rightly, still said it). Refused: the archive's name and why;
 * partly done: what landed and that some did not.
 */
const extractShortTitle = (job: TransferJob, what: string) => {
  const name = job.archive!.split(/[\\/]/).at(-1) || job.archive!;
  const reasons = [job.error ?? '', ...job.failed.map((f) => f.error)];
  if (job.landed) {
    const n = job.failed.length;
    return n > 0
      ? `Extracted ${what}, but ${n} ${n === 1 ? 'item' : 'items'} could not be`
      : `Extracted ${what}, but it stopped early`;
  }
  if (reasons.some((r) => /password/i.test(r)))
    return `${name} needs a password - Trove can't open protected archives yet`;
  return `Could not extract ${name}`;
};

const titleOf = (job: TransferJob) => {
  if (job.cancelled) return 'Cancelled';
  const [running, done] = VERB[job.mode];
  const folder = locationLabel(pathLocation(job.destination));
  const what = job.label ?? `to ${folder}`;
  if (!job.done) return `${running} ${what}`;
  const short = job.error !== null || job.failed.length > 0;
  if (short && job.mode === 'extract' && job.archive) return extractShortTitle(job, what);
  const back = job.purpose === 'undo';
  if (short && job.landed === 0) return `Nothing ${done.toLowerCase()}${back ? ' back' : ''}`;
  if (short && job.landed !== undefined && job.sent !== undefined && job.landed < job.sent)
    return `${done} ${job.landed} of ${job.sent} ${back ? `back to ${folder}` : what}`;
  return `${done} ${what}`;
};

/** ⛔ A cancelled job is `done` but did not finish: its bar shows how far it got, not 100 (Mac C.2.9). */
const percentOf = (job: TransferJob) =>
  job.done && !job.cancelled
    ? 100
    : job.bytesTotal > 0
      ? Math.round((job.bytesDone / job.bytesTotal) * 100)
      : 0;

/** ⛔ Total 0 while running is "not sized yet", never "0 B of 0 B" (it flashed for ~0.3 s). */
const amountOf = (job: TransferJob) =>
  job.done
    ? ''
    : job.bytesTotal > 0
      ? `${fmtSpace(job.bytesDone)} of ${fmtSpace(job.bytesTotal)}`
      : 'Preparing…';

const lockedView = (f: TransferFailure, locked: LockedPath[] | undefined) => {
  const held = locked?.find((l) => l.path === f.path);
  if (!held) return null;
  return { message: heldMessage(f.path, held.lockers), locker: endable(held.lockers) };
};

const failedView = (f: TransferFailure, locked: LockedPath[] | undefined): FailedItemView => ({
  name: f.path.split(/[\\/]/).at(-1) || f.path,
  // Rust names the host's bin ("could not go to the Recycle Bin"): say it in the chosen style's
  // word (plan 19 Q3 / 3.2), at display time so a settings change renames it live
  reason: inBinWords(f.error.replace(/\s*\(os error -?\d+\)\s*$/, '')),
  path: f.path,
  locked: lockedView(f, locked),
});

export const useTransferPanel = () => {
  const rows = $derived<TransferRowView[]>(
    transfers.jobs.map((job) => ({
      jobId: job.jobId,
      title: titleOf(job),
      amount: amountOf(job),
      current: job.current.split(/[\\/]/).at(-1) ?? '',
      percent: percentOf(job),
      cancelled: job.cancelled,
      running: !job.done,
      actionLabel: job.done ? 'Dismiss' : 'Cancel',
      error: job.error === null ? null : inBinWords(job.error),
      failed: job.failed.slice(0, FAILED_SHOWN).map((f) => failedView(f, job.locked)),
      moreFailed: Math.max(0, job.failed.length - FAILED_SHOWN),
      canRetry: isTransferMode(job.mode),
    })),
  );

  return {
    get rows() {
      return rows;
    },
    cancel: (jobId: number) => void transfers.cancel(jobId),
    dismiss: (jobId: number) => transfers.dismiss(jobId),
    retry: (jobId: number) => void transfers.retryFailed(jobId),
    /** End task on the program holding a failed item: asks first, then Retry failed once */
    endTask: (jobId: number, path: string, locker: Locker) =>
      void transfers.endTask(jobId, path, locker),
  };
};

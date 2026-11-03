// Running copy / move jobs and the one conflict question waiting for an answer. Rust owns the
// loop and reports over two events; this is the list the progress panel renders, plus what
// happens when a job ends: refresh, select what landed, remember how to undo it.
import * as fs from '$lib/api/fs';
import {
  cancelTransfer,
  onTransferDone,
  onTransferProgress,
  removeEmptiedFolders,
  removeMovedOriginals,
  replaceNoBin,
  binReadable,
  startTransfer,
  transferConflicts,
  undoReplace,
} from '$lib/api/transfer';
import type { LockedPath, Locker } from '$lib/api/lockers';
import { logError } from '$lib/api/log';
import { confirm } from '$lib/state/confirm.svelte';
import { endTask, findLocked } from '$lib/state/lockers.svelte';
import { notices, TIMEOUT_MS } from '$lib/state/notices.svelte';
import { clipboard } from '$lib/state/clipboard.svelte';
import { selection } from '$lib/state/selection.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { NoRecycleBin } from '$lib/api/fs';
import { noBinQuestion, noRecycleBin, replaceLostNotice } from '$lib/utils/no-bin';
import { undo, UndoDeclined, type UndoEntry } from '$lib/state/undo.svelte';
import type { ArchiveMode, ArchiveOutput } from '$lib/types/archive';
import type {
  PartialOutput,
  Resolution,
  TransferDone,
  TransferFailure,
  TransferMode,
  TransferOutput,
  TransferProgress,
} from '$lib/types/transfer';
import { nameOf, parentOf, samePath } from '$lib/utils/path';
import { onWindows } from '$lib/utils/platform';

const DISMISS_MS = 4000;
/** How many of a job's failures are asked about "who holds it" (the row names five). */
const LOCK_LOOKUPS = 5;

export interface TransferJob {
  jobId: number;
  /** a copy / move, or an archive job (state/archives) adopted onto the same panel */
  mode: TransferMode | ArchiveMode;
  /** what the row names instead of "to <folder>" (a compress names its archive) */
  label?: string;
  /** an extract's archive, so a refusal names it (`needs a password`) */
  archive?: string;
  destination: string;
  /** the answer it started with; Retry failed asks the same */
  resolution: Resolution;
  /** the answer a Redo of this job re-runs with (see `StartOptions.redoAs`) */
  redoAs: Resolution;
  fromCut: boolean;
  bytesDone: number;
  bytesTotal: number;
  current: string;
  done: boolean;
  error: string | null;
  /** what did not arrive (the job went on past each one) */
  failed: TransferFailure[];
  /** the failures a program holds open, and who (plan 21B); filled in just after `done` */
  locked?: LockedPath[];
  cancelled: boolean;
  /** a Retry failed, Undo or Redo: how many items it sent (`StartOptions.sent`) */
  sent?: number;
  /** what started it (`StartOptions.purpose`): an undo's row says "back" */
  purpose?: StartOptions['purpose'];
  /** a copy / move once done: how many of its items landed, for the row's headline */
  landed?: number;
}

/** A paste whose targets already exist, waiting for Replace / Skip / Keep both. */
export interface PendingTransfer {
  sources: string[];
  destination: string;
  mode: TransferMode;
  conflicts: string[];
  fromCut: boolean;
  /** the place with no Recycle Bin where a Replace would overwrite the old files for good
   * (`replaceNoBin`); the dialog says so under Replace. Absent: the bin keeps them */
  noBin?: string | null;
  /** an extract waiting for the answer (state/archives): `sources` is the archive alone, and
   * `resolve` hands the answer to `archives.extractTo` instead of starting a transfer */
  extract?: { archive: string; entries: string[] | null };
}

export interface StartOptions {
  /** the sources came from a cut clipboard: clear it when the move lands */
  fromCut?: boolean;
  /** push an undo entry when the job lands (false for the undo / redo of another) */
  record?: boolean;
  /** a Retry failed, Undo or Redo job: how many items it sent. Fewer outputs and no error
   * means some were skipped (their name is taken), which is not a success */
  sent?: number;
  /** what started it, for the words of a short finish; an undo's also raises a toast */
  purpose?: 'retry' | 'undo' | 'redo';
  /**
   * The answer a Redo re-runs with; the job's own answer when absent. ⛔ Never `replace` unless
   * the person chose Replace: a Redo of a Keep-both copy re-ran with Replace and overwrote the
   * person's ORIGINAL file, the one they had chosen to keep. A copy that asked nothing (no
   * conflict then) redoes as Keep both: whatever has that name by now is new, and is kept.
   */
  redoAs?: Resolution;
  /**
   * The job's own undo (archive jobs, and a Redo learning what it landed): called with what
   * landed, whenever something did, plus the item a cancel stopped inside (copy / move only);
   * the entry it returns is pushed unless `record` is false. Without it a copy / move gets
   * `#undoEntry` and an archive job gets none.
   */
  undo?: (outputs: TransferOutput[], partial: PartialOutput | null) => UndoEntry | null;
  /** called once the job's `done` has been handled (after `undo` above), whatever it landed */
  settled?: () => void;
  /** the name each source lands under, one per source (the undo of a Keep-both move puts
   * `a (2).txt` back as `a.txt`); each its own name when absent */
  names?: string[];
  /** the row's name instead of "to <folder>" (see `TransferJob.label`) */
  label?: string;
  /** an extract's archive path (see `TransferJob.archive`) */
  archive?: string;
  /** Extract here: the one output is always a NEW folder, so the row names it. Any other
   * extract may land one loose file in an existing folder, and the row names that folder. */
  newFolder?: boolean;
}

const SHORT: Record<NonNullable<StartOptions['purpose']>, string> = {
  retry: 'were not retried',
  undo: 'did not move back',
  redo: 'were not redone',
};

const MODE_LABEL: Record<TransferJob['mode'], string> = {
  copy: 'Copy',
  move: 'Move',
  compress: 'Compress',
  extract: 'Extract',
};

/** A copy or a move — the only jobs Retry failed and `#undoEntry` know how to re-run. */
export const isTransferMode = (mode: TransferJob['mode']): mode is TransferMode =>
  mode === 'copy' || mode === 'move';

/** Trailing separators ignored, then `samePath`: case folded on Windows only (plan 10, D.2). */
const sameFolder = (a: string | null, b: string) => {
  const trailing = onWindows() ? /[\\/]+$/ : /\/+$/;
  return a !== null && samePath(a.replace(trailing, ''), b.replace(trailing, ''));
};

/**
 * `to` paths grouped by the folder their `from` came from, for moving back, each with the name
 * it goes back under: its original one. ⛔ A Keep-both move landed `a.txt` as `a (2).txt`, and
 * the undo used to bring it back as `a (2).txt`.
 */
const groupByOrigin = (outputs: TransferOutput[]) => {
  const groups: Record<string, { paths: string[]; names: string[] }> = {};
  for (const o of outputs) {
    const parent = parentOf(o.from);
    if (parent === null) continue;
    const group = (groups[parent] ??= { paths: [], names: [] });
    group.paths.push(o.to);
    group.names.push(nameOf(o.from));
  }
  return Object.entries(groups);
};

/**
 * The source folders above a failed item of a move, up to its top-level source: as many as
 * `destination` (the folder it was on its way to, `dest\src\sub`) is below the job's own
 * (`dest`). A top-level item has none — its folder is the one the person moved out of.
 */
const foldersAbove = (f: TransferFailure, jobDestination: string) => {
  let depth = 0;
  let at: string | null = f.destination;
  while (at !== null && !sameFolder(at, jobDestination)) {
    at = parentOf(at);
    depth++;
  }
  if (at === null) return [];
  const above: string[] = [];
  for (let dir = parentOf(f.path); dir !== null && above.length < depth; dir = parentOf(dir))
    above.push(dir);
  return above;
};

class TransfersState {
  jobs = $state<TransferJob[]>([]);
  pending = $state<PendingTransfer | null>(null);
  #options = new Map<number, StartOptions>();
  /** a `done` that arrived before `start` returned its id (a tiny job) */
  #early = new Map<number, TransferDone>();
  /** the highest id `start` has handed this window; events are process-wide, so a job another
   * window started (a higher id than any of ours, or one we never listed) is not ours */
  #mine = new Set<number>();
  #starting = 0;
  /** ids for rows this side makes itself (Retry of `not-removed`); Rust's ids start at 1 */
  #localId = 0;

  hasJobs = $derived(this.jobs.length > 0);

  async start(
    sources: string[],
    destination: string,
    mode: TransferMode,
    resolution: Resolution,
    options: StartOptions = {},
  ) {
    const launch = options.names
      ? startTransfer(sources, destination, mode, resolution, options.names)
      : startTransfer(sources, destination, mode, resolution);
    const jobId = await this.#launch(launch);
    return this.#register(jobId, mode, destination, resolution, options);
  }

  /**
   * An archive job (state/archives) on the same row, `#mine`, early-done and options handling
   * as a copy. Pass the start call's promise, not its awaited id: a tiny job's `done` can come
   * before the id does, and only a launch this side is waiting on keeps that `done` for it.
   */
  async adopt(
    launch: Promise<number>,
    mode: ArchiveMode,
    destination: string,
    resolution: Resolution,
    options: StartOptions = {},
  ) {
    const jobId = await this.#launch(launch);
    return this.#register(jobId, mode, destination, resolution, options);
  }

  async #launch(launch: Promise<number>) {
    this.#starting += 1;
    try {
      return await launch;
    } finally {
      this.#starting -= 1;
    }
  }

  /** The tail `start` and `adopt` share, so the two never drift. */
  async #register(
    jobId: number,
    mode: TransferJob['mode'],
    destination: string,
    resolution: Resolution,
    options: StartOptions,
  ) {
    this.#mine.add(jobId);
    this.#options.set(jobId, options);
    this.jobs.push({
      jobId,
      mode,
      label: options.label,
      archive: options.archive,
      destination,
      resolution,
      redoAs: options.redoAs ?? resolution,
      fromCut: options.fromCut === true,
      bytesDone: 0,
      bytesTotal: 0,
      current: '',
      done: false,
      error: null,
      failed: [],
      cancelled: false,
      sent: options.sent,
      purpose: options.purpose,
    });
    const early = this.#early.get(jobId);
    if (early) {
      this.#early.delete(jobId);
      await this.applyDone(early);
    }
    return jobId;
  }

  /**
   * A paste or a drop: ask Rust which targets already exist, then either raise the conflict
   * question or start at once. Rejects only when the conflict check itself fails.
   *
   * A source pasted into the folder it is already in is never a conflict (Rust's
   * `transfer::conflicts`): a copy lands beside it under the platform's copy name ("a - Copy.txt",
   * "a copy.txt", "a (copy).txt") and a cut does nothing — as Explorer and Finder do, no question.
   */
  async request(
    sources: string[],
    destination: string,
    mode: TransferMode,
    options: StartOptions = {},
  ) {
    if (sources.length === 0) return;
    const conflicts = await transferConflicts(sources, destination);
    if (conflicts.length > 0) {
      const noBin = await this.#noBin(conflicts);
      this.pending = {
        sources,
        destination,
        mode,
        conflicts,
        fromCut: options.fromCut === true,
        noBin,
      };
    } else {
      // nothing was asked: a Redo must not Skip (or Replace) what has that name by then
      const redoAs: Resolution = mode === 'copy' ? 'keep-both' : 'skip';
      await this.start(sources, destination, mode, 'skip', { redoAs, ...options });
    }
  }

  /** Where a Replace would lose the old files (no bin there). A check that fails says nothing
   * here: the job still finds out, and `applyDone` warns afterwards. */
  async #noBin(conflicts: string[]) {
    try {
      return (await replaceNoBin(conflicts)) ?? null;
    } catch {
      return null;
    }
  }

  cancel = (jobId: number) => cancelTransfer(jobId).catch(() => {});

  dismiss(jobId: number) {
    const i = this.jobs.findIndex((j) => j.jobId === jobId);
    if (i >= 0) this.jobs.splice(i, 1);
  }

  /** The conflict dialog's answer. A job that cannot start says so — it used to vanish. */
  resolve = async (resolution: Resolution) => {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    try {
      if (p.extract) {
        // loaded on use: archives imports this module, so a static import would be a cycle
        const { archives } = await import('$lib/state/archives.svelte');
        await archives.extractTo(p.extract.archive, p.destination, p.extract.entries, resolution);
      } else {
        await this.start(p.sources, p.destination, p.mode, resolution, { fromCut: p.fromCut });
      }
    } catch (e) {
      notices.push({
        kind: 'error',
        title: `${p.extract ? MODE_LABEL.extract : MODE_LABEL[p.mode]} did not start`,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Send what a finished job could not carry again, each item into the folder it was on its
   * way to (one job per folder and answer — usually just one), with the same mode. A file, or
   * a folder whose copy took a new name, gets the job's own answer; a half-arrived folder is
   * merged into its copy (`replace`), since Skip would skip it whole and Keep both would start
   * a second copy beside it. A move's item that arrived but whose original could not be
   * deleted is not sent again: only its original is deleted. The finished row gives way to
   * the new jobs.
   */
  async retryFailed(jobId: number) {
    const job = this.jobs.find((j) => j.jobId === jobId);
    // an archive job's failures are entries inside an archive: nothing here can re-send them
    if (!job?.done || job.failed.length === 0 || !isTransferMode(job.mode)) return;
    const { mode, resolution, fromCut, redoAs } = job;
    const notRemoved = job.failed.filter((f) => f.kind === 'not-removed');
    const groups: Record<string, { destination: string; answer: Resolution; paths: string[] }> = {};
    for (const f of job.failed) {
      if (f.kind === 'not-removed') continue;
      const answer: Resolution = f.kind === 'folder' ? 'replace' : resolution;
      const key = JSON.stringify([answer, f.destination]);
      (groups[key] ??= { destination: f.destination, answer, paths: [] }).paths.push(f.path);
    }
    // ⛔ a move's retry carried only the items deep inside: the folders above them were left
    // behind, empty. Once its jobs are done, each goes if empty (Rust never removes one that
    // still holds anything), as the first pass does.
    const emptied =
      mode === 'move' ? job.failed.flatMap((f) => foldersAbove(f, job.destination)) : [];
    const runs: Promise<void>[] = [];
    this.dismiss(jobId);
    if (notRemoved.length > 0)
      await this.#removeOriginals(notRemoved, job.destination, resolution, fromCut);
    for (const { destination, answer, paths } of Object.values(groups)) {
      let settled!: () => void;
      runs.push(new Promise<void>((r) => (settled = r)));
      try {
        await this.start(paths, destination, mode, answer, {
          fromCut,
          sent: paths.length,
          purpose: 'retry',
          // a merge into a half copy is this side's answer, not the person's: never redone as one
          redoAs: answer === resolution ? redoAs : 'keep-both',
          settled,
        });
      } catch (e) {
        settled();
        throw e;
      }
    }
    if (emptied.length === 0) return;
    // not awaited: Retry returns once its jobs start, as before
    void Promise.all(runs)
      .then(() => removeEmptiedFolders(emptied))
      .then((removed) => (removed > 0 ? tabs.active.reload() : undefined))
      .catch((e) => logError('transfers', e));
  }

  /** Retry of `not-removed`: delete the originals, shown as a row of its own. */
  async #removeOriginals(
    failed: TransferFailure[],
    destination: string,
    resolution: Resolution,
    fromCut: boolean,
  ) {
    const jobId = --this.#localId;
    this.jobs.push({
      jobId,
      mode: 'move',
      // ⛔ the job's own destination, never a failure's: that is the folder the COPY sits in,
      // which for a folder move is the copy of the source folder ("Moved to rk", Mac C.2.13)
      destination,
      resolution,
      redoAs: resolution,
      fromCut,
      bytesDone: 0,
      bytesTotal: 0,
      current: '',
      done: false,
      error: null,
      failed: [],
      cancelled: false,
    });
    let left: TransferFailure[];
    try {
      left = await removeMovedOriginals(failed);
    } catch (e) {
      left = failed.map((f) => ({ ...f, error: String(e) }));
    }
    const row = this.jobs.find((j) => j.jobId === jobId);
    if (row) {
      row.done = true;
      row.failed = left;
      row.error =
        left.length > 0
          ? `${left.length} item(s) arrived, but the original could not be deleted`
          : null;
      if (left.length === 0) setTimeout(() => this.dismiss(jobId), DISMISS_MS);
      else void this.#findLockers(jobId);
    }
    if (left.length < failed.length) await tabs.active.reload();
  }

  /**
   * Which of a finished job's first failures a program holds open (plan 21B): the row then
   * says "Microsoft Word has report.docx open" with End task. Rust decides from each error;
   * a failure that is not "in use", or any OS but Windows, finds nobody and the row is as before.
   */
  async #findLockers(jobId: number) {
    const job = this.jobs.find((j) => j.jobId === jobId);
    if (!job) return;
    const shown = job.failed.slice(0, LOCK_LOOKUPS);
    const found = (await Promise.all(shown.map((f) => findLocked([f.path], f.error)))).flat();
    // read the row again: it may have been dismissed (or retried) while Windows answered
    const row = this.jobs.find((j) => j.jobId === jobId);
    if (row && found.length > 0) row.locked = found;
  }

  /**
   * The row's End task for the program holding `path`: asks first (state/lockers), and once
   * the program is gone runs Retry failed once by itself. A row still shown after that (an
   * archive job's, which Retry cannot re-send) loses its End task: that program is gone.
   */
  endTask = async (jobId: number, path: string, locker: Locker) => {
    if (!(await endTask(path, locker, () => this.retryFailed(jobId)))) return;
    const row = this.jobs.find((j) => j.jobId === jobId);
    if (row?.locked) row.locked = row.locked.filter((l) => l.path !== path);
  };

  cancelPending = () => {
    this.pending = null;
  };

  /** Subscribe to Rust's events; returns the unlisten function for the mount effect. */
  attach() {
    const progress = onTransferProgress((p) => this.applyProgress(p));
    const done = onTransferDone((d) => void this.applyDone(d));
    return () => {
      void progress.then((f) => f());
      void done.then((f) => f());
    };
  }

  applyProgress(p: TransferProgress) {
    const job = this.jobs.find((j) => j.jobId === p.jobId);
    if (!job) return;
    job.bytesDone = p.bytesDone;
    job.bytesTotal = p.bytesTotal;
    job.current = p.current;
  }

  async applyDone(d: TransferDone) {
    const job = this.jobs.find((j) => j.jobId === d.jobId);
    if (!job) {
      // ours but not listed yet: `start` is still awaiting its id — keep the `done` for it;
      // otherwise another window's job, which is none of this window's business
      if (this.#starting > 0 && !this.#mine.has(d.jobId)) this.#early.set(d.jobId, d);
      return;
    }
    const options = this.#options.get(d.jobId) ?? {};
    this.#options.delete(d.jobId);
    // a retry that sent N and landed fewer, with no error, skipped some because their name is
    // taken — a "done" there would say they arrived when they did not
    const { sent } = options;
    const short = sent !== undefined && !d.cancelled && d.error === null && d.outputs.length < sent;
    const error = short
      ? `${sent - d.outputs.length} of ${sent} ${SHORT[options.purpose ?? 'retry']}: something with that name is already there`
      : d.error;
    job.done = true;
    job.error = error;
    job.failed = d.failed;
    if (d.failed.length > 0) void this.#findLockers(d.jobId);
    job.cancelled = d.cancelled;
    if (isTransferMode(job.mode) || job.mode === 'extract') job.landed = d.outputs.length;
    // a cancelled job keeps how far it got: the row's bar stops there instead of filling
    if (!d.cancelled) job.bytesDone = job.bytesTotal;
    job.current = '';
    // the archive's real name: Rust numbered it (`photos (2).zip`) if the first was taken
    const made =
      job.mode === 'compress' ? (d.outputs[0] ? nameOf(d.outputs[0].to) : undefined) : undefined;
    if (made) job.label = made;
    // Extract here made one new folder: name it (`to pack`), not the folder beside the archive
    const only = d.outputs.length === 1 ? d.outputs[0] : undefined;
    if (
      job.mode === 'extract' &&
      options.newFolder &&
      only &&
      (only as ArchiveOutput).created === true
    ) {
      const name = nameOf(only.to);
      if (name) job.label = `to ${name}`;
    }
    if (error === null) setTimeout(() => this.dismiss(d.jobId), DISMISS_MS);
    // ⛔ A failed copy or move keeps its row until its ×: Retry failed and End task live there
    // (plan 21 B.4). A failed extract offers neither — nothing re-sends an archive's entries — so
    // it goes after an error notice's time; it used to sit on screen for 5+ minutes (Windows,
    // 2026-10-21, "locked.7z needs a password").
    else if (job.mode === 'extract') setTimeout(() => this.dismiss(d.jobId), TIMEOUT_MS.error);
    // ⛔ an undo that moved back less than it had moved used to look done: say what stayed
    if (options.purpose === 'undo' && (error !== null || d.cancelled)) {
      const count = sent === undefined ? '' : ` ${d.outputs.length} of ${sent} moved back.`;
      notices.push({
        kind: 'warning',
        title: 'Undo Move did not finish',
        message: `${d.cancelled ? 'Cancelled.' : `${error}.`}${count} The rest is still where it was moved to.`,
      });
    }
    // ⛔ G.2: a Replace where the bin would not take the old file overwrote it for good — say
    // so, since the Undo cannot bring it back (the dialog said so too, when it could tell)
    const lost = d.outputs.filter((o) => o.replaced === 'lost').length;
    if (lost > 0) notices.push({ kind: 'warning', ...replaceLostNotice(lost) });
    // a cancel partway through a folder: what landed of it is the job's too, and undoable
    const partial = isTransferMode(job.mode) && d.partial?.created.length ? d.partial : null;
    // refused before it began, or nothing at all arrived: nothing to undo, refresh or select
    if (d.outputs.length === 0 && !partial && (error !== null || d.cancelled)) {
      options.settled?.();
      return;
    }

    // a cut whose items did not all move is still on the clipboard: they are still there
    if (options.fromCut && error === null && !d.cancelled) clipboard.clear();
    // only what landed is undone; a job that went on past failures, or was cancelled partway,
    // still landed the rest and must be undoable (a cancel used to leave it with no undo, and
    // a cancel inside a folder still left that folder's part with none)
    if (d.outputs.length > 0 || partial) {
      // the job's own hook runs even unrecorded: a Redo uses it to learn what landed this time
      const entry = options.undo
        ? options.undo(d.outputs, partial)
        : isTransferMode(job.mode)
          ? this.#undoEntry(job.mode, job.destination, d.outputs, job.redoAs, partial)
          : null;
      if (entry && options.record !== false) undo.push(entry);
    }
    options.settled?.();
    await tabs.active.reload();
    const landed = d.outputs
      .map((o) => o.to)
      .filter((t) => sameFolder(parentOf(t), tabs.active.path));
    if (landed.length > 0) {
      selection.clear();
      selection.selectAll(landed);
    }
  }

  /**
   * Undo of a copy: the copies go to the Recycle Bin; where the backend says there is none
   * (network drive, USB, WSL, bin turned off) ask, then delete for good. A "no" throws
   * `UndoDeclined`, so the copies stay and the undo entry is not kept.
   */
  async #removeCopies(tos: string[]) {
    if (tos.length === 0) return;
    let refused: NoRecycleBin | null;
    try {
      return await fs.trashEntries(tos);
    } catch (e) {
      // duck-typed: a test may mock `$lib/api/fs` without the class
      refused = noRecycleBin(e);
      if (!refused) throw e;
    }
    const what = tos.length === 1 ? 'the copy' : `the ${tos.length} copies`;
    const ok = await confirm.ask({
      title: 'Delete Copies',
      message: noBinQuestion(
        { place: refused.place || 'This place', reason: refused.reason },
        what,
      ),
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) throw new UndoDeclined('Undo cancelled — the copies were not deleted');
    await fs.deleteEntries(tos);
  }

  /**
   * Before an undo removes what a cancelled job made of an item: ask. A folder it created may
   * hold files the person put there after the cancel, and nothing here can tell them from the
   * job's own, so they are never removed without a yes. A "no" throws `UndoDeclined`: nothing
   * is removed or moved, and the entry is not kept.
   */
  async #confirmPartial(mode: TransferMode, partial: PartialOutput) {
    const n = partial.created.length;
    const what = n === 1 ? `"${nameOf(partial.created[0])}"` : `${n} items`;
    const ok = await confirm.ask({
      title: `Undo ${MODE_LABEL[mode]}`,
      message: `The cancelled ${mode} made ${what} in "${nameOf(parentOf(partial.created[0]) ?? '')}". Undo removes ${n === 1 ? 'it' : 'them'}, with anything put inside since. Remove?`,
      okLabel: 'Remove',
      danger: true,
    });
    if (!ok) throw new UndoDeclined('Undo cancelled — nothing was removed');
  }

  /**
   * Undo moves back with Skip (never onto something new at the origin), and a move back that
   * falls short says so (`purpose: 'undo'`). Redo re-runs with `redoAs`: never `replace` unless
   * the person chose Replace (see `StartOptions.redoAs`).
   *
   * `partial` is the item a cancel stopped inside: only what the job created of it is removed
   * (to the Recycle Bin, asked first where there is none). For a copy that is the half copy;
   * for a move too, since a cancelled move deletes nothing of that item's source — removing
   * the copies is what moves it back. It goes first, after a question (`#confirmPartial`), so a
   * "no" there changes nothing at all.
   * Redo sends the whole item again.
   *
   * ⛔ What an Undo removes is what the LAST run landed, not the first: the stack reuses this
   * entry, so a Redo hands back its own outputs and partial. A move cancelled inside `tree`,
   * undone, then redone to the end, used to keep the first run's half copy as `partial`, and
   * the next Undo binned (or, with no bin, deleted) `D:\dest\tree` — by then the ONLY copy.
   *
   * ⛔ A Redo returns when its job STARTS, so an Undo pressed while it runs saw empty outputs, did
   * nothing, counted as done, and the files then landed with a "Redo Move" offered. Undo waits
   * for the redo job's `done` (`running`) and then removes what that run landed.
   */
  #undoEntry(
    mode: TransferMode,
    destination: string,
    landed: TransferOutput[],
    redoAs: Resolution,
    stoppedIn: PartialOutput | null = null,
  ) {
    let outputs = landed;
    let partial = stoppedIn;
    let running: Promise<void> | null = null;
    // what a Redo sends: every item of the first run, whatever a later run landed
    const froms = partial
      ? [...outputs.map((o) => o.from), partial.from]
      : outputs.map((o) => o.from);
    const items = froms.length === 1 ? `"${nameOf(froms[0])}"` : `${froms.length} items`;
    return {
      label: MODE_LABEL[mode],
      what: `${mode} of ${items} to "${nameOf(destination)}"`,
      folder: destination,
      undo: async () => {
        await running;
        // a file that replaced an older one, whose old file is in the bin (G.2): the undo
        // brings the old one back too
        const binned = outputs
          .filter((o) => o.replaced === 'binned')
          .map((o) => ({ path: o.to, binnedAt: o.binnedAt ?? 0, binnedId: o.binnedId }));
        const tos = outputs.filter((o) => o.replaced !== 'binned').map((o) => o.to);
        // the bin must be readable BEFORE anything moves, or a Move undo would strand the old file
        if (binned.length > 0) await binReadable();
        if (partial) await this.#confirmPartial(mode, partial);
        if (mode === 'copy') {
          await this.#removeCopies([...tos, ...(partial?.created ?? [])]);
          // the copy to the bin and the old file back in its place, in one call: which bin
          // item is the old file is decided before the copy joins it there
          if (binned.length > 0) await undoReplace(binned, true);
          return;
        }
        if (partial) await this.#removeCopies(partial.created);
        const back: Promise<void>[] = [];
        for (const [origin, { paths, names }] of groupByOrigin(outputs)) {
          // a name only where one differs: an ordinary move back is sent exactly as before
          const renamed = names.some((n, i) => n !== nameOf(paths[i]));
          let settled!: () => void;
          back.push(new Promise<void>((r) => (settled = r)));
          try {
            await this.start(paths, origin, 'move', 'skip', {
              record: false,
              sent: paths.length,
              purpose: 'undo',
              settled,
              ...(renamed ? { names } : {}),
            });
          } catch (e) {
            settled();
            throw e;
          }
        }
        if (binned.length === 0) return;
        // the old files come back once the moved files have left their place; one that did
        // not move back is named by the restore ("Something new is already there")
        await Promise.all(back);
        await undoReplace(binned, false);
        await tabs.active.reload();
      },
      redo: async () => {
        // nothing is known to have landed until the redo says so: one that lands nothing (refused,
        // cancelled at once) never calls the hook, and must leave nothing for an Undo to remove
        outputs = [];
        partial = null;
        let settled!: () => void;
        running = new Promise<void>((r) => (settled = r));
        try {
          await this.start(froms, destination, mode, redoAs, {
            record: false,
            sent: froms.length,
            purpose: 'redo',
            redoAs,
            undo: (o, p) => {
              outputs = o;
              partial = p;
              return null;
            },
            settled,
          });
        } catch (e) {
          settled(); // no job, no `done`: an Undo must not wait for one
          throw e;
        }
      },
    };
  }
}

export const transfers = new TransfersState();

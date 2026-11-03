// Folder sizes for the Size column (plan 21 A). A listing does not carry them (a recursive walk
// per folder would hold every folder up), so the column asks for them lazily, as the Dimensions
// column does: a cell or a sort that wants a folder's size queues it, one background job sizes
// the batch on a few Rust threads, and the reactive map redraws the cell and re-sorts. Only
// folders of the folder on screen are counted, only on the drive kinds the setting allows, and
// leaving the folder cancels its jobs. Keyed by path + mtime, so re-opening a folder is instant
// and a folder whose mtime moved is counted again.
import { SvelteMap } from 'svelte/reactivity';
import { logError } from '$lib/api/log';
import {
  cancelFolderTotals,
  folderDriveKind,
  onFolderSize,
  startFolderSizes,
} from '$lib/api/props';
import type { FolderSizesChoice } from '$lib/state/settings.svelte';
import type { FileEntry } from '$lib/types/fs';
import type { DriveKind, FolderSizeEvent } from '$lib/types/props';
import { fmtSize } from '$lib/utils/format';
import { parentOf, samePath } from '$lib/utils/path';

/** Whether the setting counts folders on this kind of drive. "Local drives" (the default)
 *  leaves network shares, USB sticks and WSL blank: a walk there is slow or wakes a disk. */
export const countsOn = (choice: FolderSizesChoice, kind: DriveKind): boolean =>
  choice === 'everywhere' || (choice === 'local' && kind === 'local');

export interface KnownSize {
  bytes: number;
  /** the walk stopped at its cap: `bytes` is a floor, shown as "≥ 12.3 GB" */
  capped: boolean;
}

/** A size; `'counting'` while its walk runs; `null` when it is not counted (a file, the
 *  setting is off for this drive, a row of another folder such as a search hit). */
export type FolderSizeAnswer = KnownSize | 'counting' | null;

/** Past this many remembered sizes the cache starts over, so a long session stays small. */
const CACHE_LIMIT = 20_000;

const keyOf = (e: FileEntry): string => `${e.path}|${e.modifiedMs ?? ''}`;

class FolderSizesState {
  /** The folder on screen, and the kind of drive it is on once Rust has said. */
  #folder = $state<string | null>(null);
  #kind = $state<DriveKind | null>(null);
  /** The setting, handed in by the list (`hooks/use-file-list`): this module is imported by
   *  `data/file-columns`, which `state/settings` imports, so it cannot import settings back. */
  #choice = $state<FolderSizesChoice>('local');
  #on = $derived(this.#kind !== null && countsOn(this.#choice, this.#kind));
  #known = new SvelteMap<string, KnownSize>();
  /** path → cache key, queued or in flight. Plain, not state: written from inside a render or
   *  a sort, where writing state is not allowed. */
  #wanted = new Map<string, string>();
  /** Queued and not yet sent. */
  #queued: string[] = [];
  #scheduled = false;
  /** Jobs running for the folder on screen; cancelled when it changes. */
  #jobs = new Set<number>();
  /** Bumped on every folder change, so a job id that comes back late is cancelled too. */
  #generation = 0;
  #listening: Promise<unknown> | null = null;

  /** The folder now on screen (`null`: none, or not a folder) and the setting. A folder change
   *  cancels the old one's jobs, as does turning the setting off; the drive kind is asked once
   *  per folder, so the rows paint before any walk starts. */
  show(folder: string | null, choice: FolderSizesChoice = this.#choice) {
    this.#choice = choice;
    if (choice === 'off') this.#stop();
    if (folder === this.#folder) return;
    this.#stop();
    this.#folder = folder;
    this.#kind = null;
    if (folder === null) return;
    folderDriveKind(folder)
      .then((kind) => {
        if (this.#folder === folder) this.#kind = kind;
      })
      .catch((err) => logError('folder drive kind', err));
  }

  /** `e`'s counted size, `'counting'`, or `null`. Asks for it the first time. */
  of(e: FileEntry): FolderSizeAnswer {
    if (!e.isDir || e.isLink || !this.#on) return null;
    const key = keyOf(e);
    const known = this.#known.get(key);
    if (known) return known;
    if (this.#wanted.get(e.path) === key) return 'counting';
    const folder = this.#folder;
    const parent = parentOf(e.path);
    if (folder === null || parent === null || !samePath(parent, folder)) return null;
    this.#wanted.set(e.path, key);
    this.#queued.push(e.path);
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => void this.#flush());
    }
    return 'counting';
  }

  async #flush() {
    this.#scheduled = false;
    const paths = this.#queued;
    this.#queued = [];
    if (paths.length === 0) return;
    const generation = this.#generation;
    try {
      // listening first, so the first size cannot arrive before anyone hears it
      this.#listening ??= onFolderSize((s) => this.#take(s));
      await this.#listening;
      const job = await startFolderSizes(paths);
      if (generation === this.#generation) this.#jobs.add(job);
      else void cancelFolderTotals(job).catch((err) => logError('cancel folder sizes', err));
    } catch (err) {
      logError('folder sizes', err);
      for (const p of paths) this.#wanted.delete(p);
    }
  }

  /** A size from any job, this window's or another's: the path and its key decide. */
  #take(s: FolderSizeEvent) {
    const key = this.#wanted.get(s.path);
    if (key === undefined) return;
    this.#wanted.delete(s.path);
    if (this.#known.size >= CACHE_LIMIT) this.#known.clear();
    this.#known.set(key, { bytes: s.bytes, capped: s.capped });
  }

  #stop() {
    this.#generation++;
    for (const job of this.#jobs) {
      void cancelFolderTotals(job).catch((err) => logError('cancel folder sizes', err));
    }
    this.#jobs.clear();
    this.#wanted.clear();
    this.#queued = [];
  }

  /** Test seam: forget everything. */
  reset() {
    this.#stop();
    this.#folder = null;
    this.#kind = null;
    this.#choice = 'local';
    this.#known.clear();
    this.#scheduled = false;
    this.#listening = null;
  }
}

export const folderSizes = new FolderSizesState();

/** The Size column's text for a folder: `12.3 GB`, `≥ 12.3 GB` when capped, `…` while
 *  counting, blank when not counted. */
export const folderSizeText = (e: FileEntry): string => {
  const s = folderSizes.of(e);
  if (s === null) return '';
  if (s === 'counting') return '…';
  return s.capped ? `≥ ${fmtSize(s.bytes)}` : fmtSize(s.bytes);
};

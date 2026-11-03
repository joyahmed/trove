// What the Details pane shows for the current selection: one item's properties (with a
// running contents count for a folder), the totals of several, or the current folder itself
// when nothing is selected — Explorer's rule. The pane's hook calls `sync()` from an effect
// over the selection and the tab, and `attach()` while it is mounted.
import {
  cancelFolderTotals,
  fileProps,
  onFolderTotals,
  setFileAttributes,
  startFolderTotals,
} from '$lib/api/props';
import { listing } from '$lib/state/listing.svelte';
import { selection } from '$lib/state/selection.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { FileEntry } from '$lib/types/fs';
import type { FolderTotals, Props } from '$lib/types/props';
import { isArchivePath } from '$lib/utils/archive-location';

/**
 * A row inside an archive (`archive + "\0" + inner`) has no file on disk to ask Rust about:
 * `fileProps` on it failed with the OS's "unexpected NUL byte", which the pane showed. Its
 * properties are what the listing already read from the archive; read-only, no attributes.
 */
export const archiveRowProps = (e: FileEntry): Props => ({
  path: e.path,
  name: e.name,
  isDir: e.isDir,
  typeName: e.typeName,
  size: e.isDir ? 0 : e.size,
  sizeOnDisk: 0,
  createdMs: e.createdMs,
  modifiedMs: e.modifiedMs,
  accessedMs: null,
  readOnly: true,
  hidden: false,
  system: false,
  archive: false,
});

export type DetailsTarget = 'none' | 'one' | 'many';

export interface Totals {
  files: number;
  folders: number;
  bytes: number;
  sizeOnDisk: number;
  /** folders not walked, so not in `bytes` (FolderTotals.notCounted) */
  notCounted: number;
  /** false while a folder count is still running */
  done: boolean;
}

/** Above this many selected folders the pane shows a count only, not their contents. */
const MAX_COUNTED_FOLDERS = 20;

class DetailsState {
  target = $state<DetailsTarget>('none');
  /** the one selected item, or the current folder when nothing is selected */
  props = $state<Props | null>(null);
  /** the shell icon key of the shown item (from the listing), for the header */
  entry = $state<FileEntry | null>(null);
  totals = $state<Totals | null>(null);
  count = $state(0);
  loading = $state(false);
  writing = $state(false);
  error = $state<string | null>(null);
  /** the shown item is inside an archive: read-only, so the pane offers no attribute boxes */
  inArchive = $state(false);

  /** running folder-count jobs → the totals they add into */
  #jobs = $state<Record<number, true>>({});
  /**
   * Batches that arrived before `startFolderTotals` returned their job id. A small folder is
   * counted before the invoke resolves, so its only batch — `done` — used to land while the job
   * was still unknown, was dropped, and the pane said "0 files, 0 folders…" for ever (Mac, on a
   * Mac, reproduced on Windows, 2026-10-06). Kept here and replayed once the id is registered.
   */
  #early = new Map<number, FolderTotals[]>();
  #generation = 0;
  /** what the selection itself adds before any folder is walked: its files, sizes and folders */
  #base: Omit<Totals, 'done'> = { files: 0, folders: 0, bytes: 0, sizeOnDisk: 0, notCounted: 0 };
  /** each running job's latest batch (a batch is that folder's running total) */
  #latest: Record<number, FolderTotals> = {};

  attach() {
    const unlisten = onFolderTotals((t) => this.applyTotals(t));
    return () => void unlisten.then((f) => f());
  }

  /** A totals batch for one of our jobs; batches for a cancelled job are ignored. */
  applyTotals(t: FolderTotals) {
    if (!this.#jobs[t.jobId]) {
      // not registered YET (or cancelled): keep it a moment; #count replays or #cancelJobs drops
      const kept = this.#early.get(t.jobId) ?? [];
      if (this.#early.size < 64) this.#early.set(t.jobId, [...kept, t]);
      return;
    }
    if (!this.totals) return;
    // a job's batches are running totals (each replaces the one before), so keep the latest per
    // job and show the selection's own files and folders (#base) plus every job's latest
    this.#latest[t.jobId] = t;
    const sum = { ...this.#base };
    for (const j of Object.values(this.#latest)) {
      sum.files += j.files;
      sum.folders += j.folders;
      sum.bytes += j.bytes;
      sum.sizeOnDisk += j.sizeOnDisk;
      sum.notCounted += j.notCounted;
    }
    this.totals = { ...sum, done: this.totals.done };
    if (t.done) {
      delete this.#jobs[t.jobId];
      if (Object.keys(this.#jobs).length === 0) this.totals.done = true;
    }
  }

  /** Re-derive the pane from the selection and the active tab. */
  async sync() {
    const gen = ++this.#generation;
    this.#cancelJobs();
    this.#base = { files: 0, folders: 0, bytes: 0, sizeOnDisk: 0, notCounted: 0 };
    this.error = null;
    this.inArchive = false;
    const selected = listing.rows.filter((e) => selection.has(e.path));
    this.count = selected.length;

    if (selected.length > 1) {
      this.target = 'many';
      this.props = null;
      this.entry = null;
      this.#sumSelection(selected);
      return;
    }

    const path = selected[0]?.path ?? tabs.active.path;
    this.target = selected.length === 1 ? 'one' : 'none';
    this.entry = selected[0] ?? null;
    if (!path) {
      this.props = null;
      this.totals = null;
      return;
    }
    if (selected[0] && isArchivePath(path)) {
      this.inArchive = true;
      this.props = archiveRowProps(selected[0]);
      this.totals = null;
      this.loading = false;
      return;
    }
    this.loading = true;
    try {
      const props = await fileProps(path);
      if (gen !== this.#generation) return;
      this.props = props;
      this.totals = null;
      if (props.isDir) await this.#count([path], gen);
    } catch (e) {
      if (gen !== this.#generation) return;
      this.props = null;
      this.error = String(e);
    } finally {
      if (gen === this.#generation) this.loading = false;
    }
  }

  /** A multi-selection: files add their sizes at once; folders are counted in the background. */
  #sumSelection(selected: FileEntry[]) {
    const files = selected.filter((e) => !e.isDir);
    const archived = selected.filter((e) => e.isDir && isArchivePath(e.path)).length;
    // a folder inside an archive has nothing on disk to walk
    const folders = selected.filter((e) => e.isDir && !isArchivePath(e.path));
    this.totals = {
      files: files.length,
      folders: folders.length + archived,
      bytes: files.reduce((n, e) => n + e.size, 0),
      sizeOnDisk: 0,
      notCounted: 0,
      done: folders.length === 0,
    };
    const own = this.totals;
    this.#base = {
      files: own.files,
      folders: own.folders,
      bytes: own.bytes,
      sizeOnDisk: own.sizeOnDisk,
      notCounted: own.notCounted,
    };
    if (folders.length > 0 && folders.length <= MAX_COUNTED_FOLDERS) {
      void this.#count(
        folders.map((e) => e.path),
        this.#generation,
      );
    } else if (folders.length > MAX_COUNTED_FOLDERS) {
      this.totals.done = true;
    }
  }

  async #count(paths: string[], gen: number) {
    this.totals ??= {
      files: 0,
      folders: 0,
      bytes: 0,
      sizeOnDisk: 0,
      notCounted: 0,
      done: false,
    };
    this.totals.done = false;
    for (const path of paths) {
      try {
        const id = await startFolderTotals(path);
        if (gen !== this.#generation) {
          void cancelFolderTotals(id);
          return;
        }
        this.#jobs[id] = true;
        const early = this.#early.get(id) ?? [];
        this.#early.delete(id);
        for (const t of early) this.applyTotals(t);
      } catch (e) {
        this.error = String(e);
      }
    }
  }

  #cancelJobs() {
    for (const id of Object.keys(this.#jobs)) void cancelFolderTotals(Number(id));
    this.#jobs = {};
    this.#latest = {};
    this.#early.clear();
  }

  /** Write one attribute bit back, then re-read; a hidden change re-lists the folder. */
  async #setBit(bits: { readOnly?: boolean; hidden?: boolean }) {
    const path = this.props?.path;
    if (!path || this.writing || this.inArchive) return;
    this.writing = true;
    try {
      await setFileAttributes(path, bits);
      this.props = await fileProps(path);
      if (bits.hidden !== undefined) await tabs.active.reload();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.writing = false;
    }
  }

  setReadOnly = (v: boolean) => this.#setBit({ readOnly: v });
  setHidden = (v: boolean) => this.#setBit({ hidden: v });

  /** Drop everything (the pane closed). */
  reset() {
    this.#generation++;
    this.#cancelJobs();
    this.props = null;
    this.entry = null;
    this.totals = null;
    this.target = 'none';
    this.count = 0;
    this.loading = false;
    this.error = null;
    this.inArchive = false;
  }
}

export const details = new DetailsState();

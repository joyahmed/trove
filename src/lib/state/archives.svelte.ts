// Compress and extract (plan 16): Rust runs each as a job on the same events as a copy, and
// `transfers.adopt` lists it on the same progress panel — the row, Cancel, the early `done`,
// the refresh and the selection of what landed are all the transfer ones. What is archive-only
// lives here: the conflict check before an extract, and the undo of each job.
//
// Undo puts only what a job CREATED in the bin: an extract that replaced a file the person had
// leaves it alone (plan 16, taste Q5: no undo of a Replace); where there is no bin it asks first.
import * as fs from '$lib/api/fs';
import { archiveConflicts, startCompress, startExtract, startExtractHere } from '$lib/api/archive';
import { fileCategoryOf } from '$lib/data/file-categories';
import { confirm } from '$lib/state/confirm.svelte';
import { transfers, type StartOptions } from '$lib/state/transfers.svelte';
import { UndoDeclined, type UndoEntry } from '$lib/state/undo.svelte';
import type { ArchiveFormat, ArchiveOutput } from '$lib/types/archive';
import type { Resolution, TransferOutput } from '$lib/types/transfer';
import { noBinQuestion, noRecycleBin } from '$lib/utils/no-bin';
import { parentOf } from '$lib/utils/path';
import { readsRar } from '$lib/utils/platform';

/** The paths a job made itself — never one it replaced. */
const createdOf = (outputs: TransferOutput[]) =>
  outputs.filter((o) => (o as ArchiveOutput).created === true).map((o) => o.to);

const nameOf = (path: string) => path.split(/[\\/]/).at(-1) || path;

/** What Rust will call the archive (core/archive/zip_fmt.rs `compress`): the one item's stem,
 * else `Archive`. Only the running row shows it; the done row shows the name Rust chose. */
const archiveName = (paths: string[], format: ArchiveFormat) => {
  const only = paths.length === 1 ? nameOf(paths[0]) : '';
  const stem = only.replace(/(?<=.)\.[^.]*$/, '');
  return `${stem || 'Archive'}.${format}`;
};

/** The last extension of every name this build can extract (plan 16: Phase 1 `zip`; Phase 2 the
 * tar family — `x.tar.gz` ends in `gz`, and a bare `notes.txt.gz` extracts to one file too; Phase 3 `7z`). */
const EXTRACTABLE: readonly string[] = [
  'zip',
  '7z',
  'tar',
  'gz',
  'tgz',
  'xz',
  'txz',
  'zst',
  'tzst',
];

/** An archive per `fileCategoryOf` whose kind this build can open — what "Extract here" needs.
 * RAR (Phase 5) only in a build with the `rar` cargo feature (`readsRar`). */
export const canExtract = (name: string) => {
  if (fileCategoryOf(name) !== 'archive') return false;
  const ext = name.toLowerCase().split('.').at(-1) ?? '';
  return EXTRACTABLE.includes(ext) || (ext === 'rar' && readsRar());
};

/** A rerun for Redo: the start call with a hook that learns what this run landed. */
type Rerun = (landed: StartOptions['undo']) => Promise<unknown>;

class ArchivesState {
  /** Compress `paths` into one archive beside them (Phase 1: `zip`). Resolves to the job id. */
  compress = (
    paths: string[],
    format: ArchiveFormat = 'zip',
    options: StartOptions = {},
  ): Promise<number> =>
    transfers.adopt(
      startCompress(paths, format),
      'compress',
      parentOf(paths[0]) ?? '',
      'keep-both',
      {
        label: archiveName(paths, format),
        undo: (outputs) =>
          this.#entry(
            'Compress',
            outputs,
            (landed) => this.compress(paths, format, { record: false, undo: landed }),
            'the ZIP file',
          ),
        ...options,
      },
    );

  /** "Extract here": a new folder beside the archive, always (`photos`, then `photos (2)`). */
  extractHere = (archive: string, options: StartOptions = {}): Promise<number> =>
    transfers.adopt(startExtractHere(archive), 'extract', parentOf(archive) ?? '', 'keep-both', {
      newFolder: true,
      archive,
      undo: (outputs) =>
        this.#entry('Extract', outputs, (landed) =>
          this.extractHere(archive, { record: false, undo: landed }),
        ),
      ...options,
    });

  /**
   * Extract `archive` (or only `entries`) into `destination`. With no `resolution`, asks Rust
   * what already exists there first: a conflict raises the Replace / Skip / Keep both question
   * (`transfers.pending`, whose answer comes back here) and starts nothing; otherwise it starts
   * at once with `skip`. Resolves to the job id, or null while the question waits.
   */
  extractTo = async (
    archive: string,
    destination: string,
    entries: string[] | null = null,
    resolution?: Resolution,
  ): Promise<number | null> => {
    if (resolution !== undefined) return this.#extract(archive, destination, entries, resolution);
    const conflicts = await archiveConflicts(archive, destination, entries);
    if (conflicts.length > 0) {
      transfers.pending = {
        sources: [archive],
        destination,
        // the dialog reads only `conflicts`; `extract` routes the answer back to `extractTo`
        mode: 'copy',
        conflicts,
        fromCut: false,
        extract: { archive, entries },
      };
      return null;
    }
    // nothing was asked: a Redo must not Skip (or Replace) what has that name by then
    return this.#extract(archive, destination, entries, 'skip', 'keep-both');
  };

  #extract(
    archive: string,
    destination: string,
    entries: string[] | null,
    resolution: Resolution,
    redoAs: Resolution = resolution,
    options: StartOptions = {},
  ): Promise<number> {
    return transfers.adopt(
      startExtract(archive, destination, entries, resolution),
      'extract',
      destination,
      resolution,
      {
        redoAs,
        archive,
        undo: (outputs) =>
          this.#entry('Extract', outputs, (landed) =>
            this.#extract(archive, destination, entries, redoAs, redoAs, {
              record: false,
              undo: landed,
            }),
          ),
        ...options,
      },
    );
  }

  /**
   * The undo entry of a job that landed `outputs`: Undo removes what it created; Redo runs it
   * again and from then on removes what THAT run created (a Keep-both name can differ). None
   * when the job created nothing (a Replace only), since there is nothing to take back.
   */
  #entry(label: string, outputs: TransferOutput[], rerun: Rerun, what?: string): UndoEntry | null {
    let made = createdOf(outputs);
    if (made.length === 0) return null;
    return {
      label,
      at: Date.now(),
      toRecord: () => ({ kind: 'copy', created: [...made] }),
      undo: () => this.#removeMade(made, what),
      redo: async () => {
        await rerun((landed) => {
          made = createdOf(landed);
          return null;
        });
      },
    };
  }

  /** To the bin; where there is none, ask, then delete for good. A "no" is `UndoDeclined`. */
  async #removeMade(paths: string[], called?: string) {
    let refused: fs.NoRecycleBin | null;
    try {
      return await fs.trashEntries(paths);
    } catch (e) {
      refused = noRecycleBin(e);
      if (!refused) throw e;
    }
    const what =
      called && paths.length === 1
        ? called
        : paths.length === 1
          ? `"${nameOf(paths[0])}"`
          : `these ${paths.length} items`;
    const ok = await confirm.ask({
      title: paths.length === 1 ? 'Delete Item' : 'Delete Items',
      message: noBinQuestion(refused, what),
      okLabel: 'Delete',
      danger: true,
    });
    const was = paths.length === 1 ? 'was' : 'were';
    if (!ok) throw new UndoDeclined(`Undo cancelled — ${what} ${was} not deleted`);
    await fs.deleteEntries(paths);
  }
}

export const archives = new ArchivesState();

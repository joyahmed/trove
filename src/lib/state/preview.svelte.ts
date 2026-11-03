// What the preview pane shows: the one selected row (null for none or several), its kind, and
// for a text file the head fetched from Rust. `sync` is driven by the pane's hook whenever the
// selection or the rows change; a fetch that finishes after the selection moved on is dropped.
//
// A row inside an archive (`archive + "\0" + inner`) has no file on disk: handed to a real-path
// command it failed with the OS's "unexpected NUL byte", and that text was the preview. Such a
// row is first extracted to the same read-only temp copy Open uses (`startOpenInner`), and the
// pane previews that copy; a file too big to extract just for a look gets a sentence instead.
import { startOpenInner } from '$lib/api/archive';
import { logError } from '$lib/api/log';
import { readTextHead } from '$lib/api/preview';
import { previewKindOf } from '$lib/data/preview-kinds';
import type { FileEntry } from '$lib/types/fs';
import type { PreviewKind, TextHead } from '$lib/types/preview';
import { splitArchivePath } from '$lib/utils/archive-location';

/** Above this a file inside an archive is not extracted just to preview it (Open still works). */
export const ARCHIVE_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;

export const ARCHIVE_TOO_BIG =
  'This file is too large to preview from inside the archive. Open it to see it.';
export const ARCHIVE_PREVIEW_FAILED =
  "Couldn't preview this file from inside the archive. Open it to see it.";

/** One file in the same state: same path, size and modified time (a fresh listing makes new
 * row objects, so identity would refetch on every folder change). */
const sameFile = (a: FileEntry | null, b: FileEntry | null): boolean =>
  a?.path === b?.path && a?.size === b?.size && a?.modifiedMs === b?.modifiedMs;

class PreviewState {
  entry = $state.raw<FileEntry | null>(null);
  count = $state(0);
  text = $state.raw<TextHead | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  /** The real file the preview reads: the row's path, or the temp copy of an archive row
   * ('' while that copy is being made, or when there is none). */
  source = $state('');
  /** A sentence shown in place of the preview (a file inside an archive that is not shown). */
  notice = $state<string | null>(null);

  kind = $derived<PreviewKind>(this.entry ? previewKindOf(this.entry) : 'none');

  /** Point the pane at what is selected: `rows` filtered by `selected`. */
  sync(rows: FileEntry[], selected: ReadonlySet<string>) {
    this.count = selected.size;
    const entry = selected.size === 1 ? (rows.find((r) => selected.has(r.path)) ?? null) : null;
    // Same path AND same size and mtime: nothing to do. ⛔ Keyed on the path alone, a file whose
    // content changed under it (a Replace, its Undo) kept the old text in the pane (G.2, Ubuntu).
    if (sameFile(entry, this.entry)) return;
    this.entry = entry;
    this.text = null;
    this.error = null;
    this.notice = null;
    this.source = '';
    this.loading = false;
    if (!entry) return;
    const kind = previewKindOf(entry);
    const inside = splitArchivePath(entry.path);
    if (inside) {
      if (kind === 'none') return; // the icon, as for any file with no preview
      if (entry.size > ARCHIVE_PREVIEW_MAX_BYTES) {
        this.notice = ARCHIVE_TOO_BIG;
        return;
      }
      void this.#fromArchive(entry.path, inside.archive, inside.inner, kind);
      return;
    }
    this.source = entry.path;
    if (kind === 'text') void this.#fetchText(entry.path, entry.path);
  }

  /** Extract the row to its temp copy, then preview that. Raw failures go to the log only. */
  async #fromArchive(row: string, archive: string, inner: string, kind: PreviewKind) {
    this.loading = true;
    let copy: string;
    try {
      copy = await startOpenInner(archive, inner);
    } catch (e) {
      logError('preview.fromArchive', e);
      if (this.entry?.path !== row) return;
      this.notice = ARCHIVE_PREVIEW_FAILED;
      this.loading = false;
      return;
    }
    if (this.entry?.path !== row) return; // the selection moved on
    this.source = copy;
    if (kind === 'text') return this.#fetchText(row, copy);
    this.loading = false;
  }

  /** `row`: the selected row's path (what "still selected" compares); `file`: what is read. */
  async #fetchText(row: string, file: string) {
    this.loading = true;
    try {
      const head = await readTextHead(file);
      if (this.entry?.path !== row) return; // the selection moved on
      this.text = head;
    } catch (e) {
      if (this.entry?.path === row) this.error = String(e);
    } finally {
      if (this.entry?.path === row) this.loading = false;
    }
  }
}

export const preview = new PreviewState();

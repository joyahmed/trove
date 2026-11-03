// Image width x height for the Dimensions column. A listing does not carry them (reading a header
// per file would slow every folder), so the column asks for them lazily: a cell or a sort that
// wants a size and has none queues the file, one batched Rust call answers, and the reactive map
// redraws the cell. Keyed by path + mtime + size so an edited image is read again.
import { SvelteMap } from 'svelte/reactivity';
import { imageDimensions } from '$lib/api/image-dims';
import { logError } from '$lib/api/log';
import type { FileEntry } from '$lib/types/fs';

/** What the Rust header reader understands: `core/image_dims.rs`. Keep the two lists the same. */
export const DIMENSION_EXTS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
  'avif',
];

const BATCH = 256;

const keyOf = (e: FileEntry): string => `${e.path}|${e.modifiedMs ?? ''}|${e.size}`;

export const hasDimensions = (e: FileEntry): boolean =>
  !e.isDir && e.ext !== null && DIMENSION_EXTS.includes(e.ext);

class DimensionsState {
  /** `[w, h]`, or `null` once a read found nothing. A missing key means "not asked yet". */
  #known = new SvelteMap<string, [number, number] | null>();
  /** Queued or in flight, so a redraw does not ask twice. Plain, not state: it is written from
   *  inside a render or a sort, where writing state is not allowed. */
  #wanted = new Map<string, string>();
  #scheduled = false;

  /** The size of `e`, or `null` when it has none (yet). Asks for it the first time. */
  of(e: FileEntry): [number, number] | null {
    if (!hasDimensions(e)) return null;
    const key = keyOf(e);
    if (this.#known.has(key)) return this.#known.get(key) ?? null;
    if (!this.#wanted.has(key)) {
      this.#wanted.set(key, e.path);
      if (!this.#scheduled) {
        this.#scheduled = true;
        queueMicrotask(() => void this.#flush());
      }
    }
    return null;
  }

  async #flush() {
    this.#scheduled = false;
    const batch = [...this.#wanted].slice(0, BATCH);
    if (batch.length === 0) return;
    let answers: ([number, number] | null)[] = [];
    try {
      answers = await imageDimensions(batch.map(([, path]) => path));
    } catch (err) {
      logError('image dimensions', err);
    }
    batch.forEach(([key], i) => {
      this.#wanted.delete(key);
      this.#known.set(key, answers[i] ?? null);
    });
    if (this.#wanted.size > 0) void this.#flush();
  }

  /** Test seam: forget everything. */
  reset() {
    this.#known.clear();
    this.#wanted.clear();
    this.#scheduled = false;
  }
}

export const dimensions = new DimensionsState();

/** `1920 × 1080`, blank when unknown. */
export const dimensionsText = (e: FileEntry): string => {
  const d = dimensions.of(e);
  return d ? `${d[0]} × ${d[1]}` : '';
};

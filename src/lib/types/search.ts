// Mirrors src-tauri/src/core/search.rs (serde camelCase). Change both or neither.
import type { FileEntry } from '$lib/types/fs';

export type SearchKind = 'any' | 'file' | 'folder';

export interface SearchQuery {
  /** case-insensitive substring of the name; '' matches everything */
  text: string;
  /** lower-cased extension without the dot, or null for any */
  ext: string | null;
  kind: SearchKind;
  /** Unix ms; only entries modified at or after it */
  modifiedAfterMs: number | null;
  minBytes: number | null;
  maxBytes: number | null;
}

/** One `search:results` event: a batch of hits, then a final one with `done`. */
export interface SearchBatch {
  searchId: number;
  entries: FileEntry[];
  done: boolean;
  cancelled: boolean;
  error: string | null;
  /** entries visited so far, for the "Searching…" line */
  scanned: number;
  /** Mac: the unopened guarded folders the search left out; filled on the `done` batch only */
  skippedGuarded?: string[];
}

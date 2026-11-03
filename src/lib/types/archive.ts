// Mirrors src-tauri/src/core/archive/mod.rs (`ArchiveFormat`) and core/archive/job.rs
// (`ArchiveOutput`). Change both or neither.
import type { TransferOutput } from '$lib/types/transfer';

/** What `start_compress` can be asked to make. Phase 1 (plan 16) makes `zip` only. */
export type ArchiveFormat = 'zip' | '7z' | 'tar.gz' | 'tar.xz' | 'tar.zst';

/** An archive job's kind, beside a transfer's `copy` / `move` on the progress panel. */
export type ArchiveMode = 'compress' | 'extract';

/**
 * One thing an archive job made or replaced: a `TransferOutput` plus `created`. `from` is the
 * archive (extract) or the first source (compress).
 */
export interface ArchiveOutput extends TransferOutput {
  /** true: the job made it, so Undo may put it in the bin. false: it replaced a file the
   * person had, and Undo leaves it alone (plan 16, taste Q5: no undo of a Replace). */
  created: boolean;
}

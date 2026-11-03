// The only place the archive commands appear. Mirrors src-tauri/src/commands/archive.rs. The
// jobs report over the same `transfer:progress` / `transfer:done` events as a copy (see
// `$lib/api/transfer`), so there are no archive events.
import { invoke } from '@tauri-apps/api/core';
import type { ArchiveFormat } from '$lib/types/archive';
import type { DirListing } from '$lib/types/fs';
import type { Resolution } from '$lib/types/transfer';

/** Top-level names of the archive (or of `entries` in it) already in `destination`. */
export const archiveConflicts = (
  archive: string,
  destination: string,
  entries: string[] | null = null,
) => invoke<string[]>('archive_conflicts', { archive, destination, entries });

/** Extract `archive` (or only `entries`) into `destination`; resolves to the job id. */
export const startExtract = (
  archive: string,
  destination: string,
  entries: string[] | null,
  resolution: Resolution,
) => invoke<number>('start_extract', { archive, destination, entries, resolution });

/** "Extract here": into a new folder beside the archive (`photos`, then `photos (2)`). */
export const startExtractHere = (archive: string) =>
  invoke<number>('start_extract_here', { archive });

/** Compress `sources` into one archive beside them; resolves to the job id. */
export const startCompress = (sources: string[], format: ArchiveFormat) =>
  invoke<number>('start_compress', { sources, format });

/** One folder level inside an archive (`inner` `''` = its top). Each row's `path` is
 * `archive + "\0" + inner`: no real path, so no real-path command can act on it. */
export const readArchiveDir = (archive: string, inner: string) =>
  invoke<DirListing>('read_archive_dir', { archive, inner });

/** Open a file inside an archive: Rust extracts it to a read-only temp copy (a second open
 * reuses it) and resolves to that copy's path, for `openPath`. */
export const startOpenInner = (archive: string, inner: string) =>
  invoke<string>('start_open_inner', { archive, inner });

// Mirrors src-tauri/src/core/transfer.rs (serde camelCase). Change both or neither.

export type TransferMode = 'copy' | 'move';

/** What to do with a target that already exists. */
export type Resolution = 'replace' | 'skip' | 'keep-both';

/**
 * What a Replace did with the file it wrote over (plan 15 G.2): `binned` — it went to the
 * Recycle Bin / Trash first, and Undo brings it back; `lost` — the place has no bin, so it was
 * overwritten for good.
 */
export type Replaced = 'binned' | 'lost';

export interface TransferOutput {
  from: string;
  /** where it landed (a keep-both rename differs from the planned name) */
  to: string;
  /** a file that landed by Replace over an older file at `to` only */
  replaced?: Replaced;
  /** when the old file went to the bin (unix seconds); `undo_replace`'s fallback */
  binnedAt?: number;
  /** the bin item the old file became, when the bin could tell; `undo_replace` restores it */
  binnedId?: string;
}

/** `transfer:progress`, at most every 100 ms per job. */
export interface TransferProgress {
  jobId: number;
  bytesDone: number;
  bytesTotal: number;
  /** the file being copied right now */
  current: string;
}

/**
 * What a failure is, which decides what Retry failed does with it:
 * - `file`: a file or link that did not arrive; sent again with the job's own answer;
 * - `folder`: a folder that did not arrive whole; merged into its copy (`replace`);
 * - `new-folder`: a folder whose copy took a new name; sent again with the job's own answer,
 *   so it never merges into the folder the person chose to keep;
 * - `not-removed`: a move's item that arrived, but whose original could not be deleted;
 *   Retry only deletes the original (`removeMovedOriginals`), it copies nothing.
 */
export type FailureKind = 'file' | 'folder' | 'new-folder' | 'not-removed';

/** One file or folder a job could not carry; the job went on past it. */
export interface TransferFailure {
  path: string;
  /** the folder it was on its way to — for an item deep in a tree, that tree's copy */
  destination: string;
  /** the OS's reason, verbatim */
  error: string;
  kind: FailureKind;
  /** `not-removed` only: the full path its copy landed at (a Keep-both copy has another name) */
  copy?: string;
}

/**
 * The top-level item a cancel stopped partway, and exactly what the job had created for it:
 * the topmost new entries (a new folder stands for everything in it), never anything that was
 * there before. A move cancelled partway has deleted none of that item's source.
 */
export interface PartialOutput {
  from: string;
  to: string;
  created: string[];
}

/** `transfer:done`, exactly once per job. */
export interface TransferDone {
  jobId: number;
  outputs: TransferOutput[];
  /** everything that did not arrive, in the order met; empty on a clean finish */
  failed: TransferFailure[];
  /** a refusal before the job began, or a summary: "2 of 30 items could not be copied" */
  error: string | null;
  cancelled: boolean;
  /** a cancel only: the item it stopped in the middle of, with what had landed of it */
  partial?: PartialOutput;
}

/** What the OS clipboard holds as files (CF_HDROP), with Explorer's cut flag. */
export interface ClipboardPaths {
  paths: string[];
  cut: boolean;
}

/** What a drop target did with an OLE drag from us (mirrors core/drag_out.rs). */
export interface DragOutcome {
  effect: 'none' | 'copy' | 'move';
}

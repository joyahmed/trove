// The only place the transfer commands and the `transfer:*` events appear. Mirrors
// src-tauri/src/commands/transfer.rs and the event names in lib.rs.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  DragOutcome,
  Resolution,
  TransferDone,
  TransferFailure,
  TransferMode,
  TransferProgress,
} from '$lib/types/transfer';
import type { FolderSpace } from '$lib/types/shell';

/** Destination paths that already exist for these sources. */
export const transferConflicts = (sources: string[], destination: string) =>
  invoke<string[]>('transfer_conflicts', { sources, destination });

/**
 * Starts the job and returns its id; progress and completion arrive as events. `names`, when
 * given, is the name each source lands under (one per source) — the undo of a Keep-both move.
 */
export const startTransfer = (
  sources: string[],
  destination: string,
  mode: TransferMode,
  resolution: Resolution,
  names?: string[],
) =>
  invoke<number>('start_transfer', {
    sources,
    destination,
    mode,
    resolution,
    names: names ?? null,
  });

/**
 * Delete the originals of a move that arrived but could not be deleted (`not-removed`
 * failures); one whose copy is gone from its destination is kept. Resolves to the ones still
 * there, each with its new reason.
 */
export const removeMovedOriginals = (failed: TransferFailure[]) =>
  invoke<TransferFailure[]>('remove_moved_originals', { failed });

/**
 * After Retry of a move: remove the source folders it emptied, deepest first, each only if it
 * is empty (a folder with anything in it stays). Resolves to how many went.
 */
export const removeEmptiedFolders = (dirs: string[]) =>
  invoke<number>('remove_emptied_folders', { dirs });

export const cancelTransfer = (jobId: number) => invoke<void>('cancel_transfer', { jobId });

/**
 * The place (`N:`, `WSL`, a share) where a Replace of these conflicts would overwrite the old
 * files for good, because it has no Recycle Bin; null when the old files can go to the bin.
 */
export const replaceNoBin = (conflicts: string[]) =>
  invoke<string | null>('replace_no_bin', { conflicts });

/**
 * Undo of a Copy that replaced files: each path's copy goes to the bin and the old file it
 * replaced comes back from it (src-tauri `undo_replace`).
 */
export const undoReplace = (
  files: { path: string; binnedAt: number; binnedId?: string }[],
  binCopies: boolean,
) => invoke<void>('undo_replace', { files, binCopies });

/** Refuses when the bin cannot be read, so an undo that needs it can stop before it moves anything. */
export const binReadable = () => invoke<void>('bin_readable');

/** Put Recycle Bin items back where they were, by their original paths. */
export const restoreFromTrash = (paths: string[]) => invoke<void>('restore_from_trash', { paths });

export const onTransferProgress = (cb: (p: TransferProgress) => void) =>
  listen<TransferProgress>('transfer:progress', (e) => cb(e.payload));

export const onTransferDone = (cb: (d: TransferDone) => void) =>
  listen<TransferDone>('transfer:done', (e) => cb(e.payload));

/**
 * Hand the dragged paths to the OS as a native drag (OLE `CF_HDROP` on Windows, an AppKit
 * session on a Mac, a GTK `text/uri-list` drag on Linux); resolves when the person drops or
 * cancels, with what the target did. The pointer button must still be down when called.
 */
export const dragOut = (paths: string[], allowMove: boolean) =>
  invoke<DragOutcome>('drag_out', { paths, allowMove });

/**
 * The copy and move keys held right now, read from the OS, for a drop from another app: its
 * payload carries no modifiers and the window has no focus to see key events while the drag
 * is over it. `ctrl` is the copy key (Option on a Mac); all false where the OS cannot say.
 */
export const dropModifiers = () => invoke<{ ctrl: boolean; shift: boolean }>('drop_modifiers');

/**
 * A drop of `sources` into `target` stays on one volume, so a move is a rename: decided from
 * the device the OS reports, not the drive list (src-tauri `core/volume.rs`). False when
 * anything cannot be read — the drop then copies.
 */
export const sameVolume = (sources: string[], target: string) =>
  invoke<boolean>('same_volume', { sources, target });

/**
 * The OS's answer for the folder itself (src-tauri `core/volume.rs`), not the drive list, which
 * leaves a Mac disk image out. null when it cannot be read, and always on Windows.
 */
export const folderSpace = (path: string) => invoke<FolderSpace | null>('folder_space', { path });

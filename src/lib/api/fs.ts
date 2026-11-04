// The only place `invoke` appears for the fs domain. Mirrors src-tauri/src/commands/fs.rs.
import { invoke } from '@tauri-apps/api/core';
import type { DirListing, SyncStatus } from '$lib/types/fs';

export const readDir = (path: string) => invoke<DirListing>('read_dir', { path });
/**
 * The palette preview's item count, or null when the folder may not be read without asking: a
 * Mac privacy-guarded folder not opened in Trove yet, a network share (no prompt, no listing).
 */
export const paletteFolderCount = (path: string) =>
  invoke<number | null>('palette_folder_count', { path });
/**
 * Mac: the privacy-guarded folders (Desktop, Documents, Downloads…) not opened in Trove yet,
 * which searches leave out. Empty off a Mac.
 */
export const unopenedGuardedFolders = () => invoke<string[]>('unopened_guarded_folders');
/**
 * "Not searched … — Allow": read each folder once so macOS asks for it now, and remember the ones
 * it let Trove into. Resolves to the folders now opened (a refused one is left out).
 */
export const allowGuardedFolders = (paths: string[]) =>
  invoke<string[]>('allow_guarded_folders', { paths });
/** what a typed path is — the address bar opens a file rather than failing to list it */
export const pathKind = (path: string) => invoke<'file' | 'dir' | 'missing'>('path_kind', { path });
/** Show the OS credential box for the share holding `path` and connect (plan 05 5.3d). `code`
 * is the OS error the listing failed with: 5 (access denied) or 1326 (logon failure). */
export const netSignIn = (path: string, code: number) =>
  invoke<'connected' | 'cancelled'>('net_sign_in', { path, code });
/** `Z:\` for every drive letter mapped to a network share (empty off Windows) */
export const mappedDrives = () => invoke<string[]>('mapped_drives');
/** OneDrive's "Always keep on this device" (`keep`) or "Free up space" for each path (plan 05 5.4) */
export const setCloudPin = (paths: string[], keep: boolean) =>
  invoke<void>('set_cloud_pin', { paths, keep });
/** the sync state of the cloud folder `path` is in (OneDrive's sidebar glyph); null outside one */
export const cloudSyncStatus = (path: string) =>
  invoke<SyncStatus | null>('cloud_sync_status', { path });
export const openPath = (path: string) => invoke<void>('open_path', { path });
/** Open a URL in the OS default browser. ⛔ Not `openPath` — that one stats its argument. */
export const openUrl = (url: string) => invoke<void>('open_url', { url });
export const renameEntry = (path: string, newName: string) =>
  invoke<string>('rename_entry', { path, newName });
export const createFolder = (dir: string) => invoke<string>('create_folder', { dir });
/** an empty `<baseName>.<ext>` with Explorer's numbering; `ext` has no dot */
export const createFile = (dir: string, baseName: string, ext: string) =>
  invoke<string>('create_file', { dir, baseName, ext });
/**
 * The Recycle Bin refused because `place` has none (a network share, a mapped drive, WSL, a USB
 * stick): NOTHING was deleted. Only the backend can tell (core/ops.rs `trash`), so callers ask
 * this error, never the path. `String(e)` is the backend's sentence, like every other failure.
 */
/** `denied`: macOS refused Trove the Trash (Finder's Apple Events denied, and the file manager's
 * move failed too — core/trash_mac.rs). Items of the batch not in `paths` already went to it. */
export type NoBinReason = 'noBin' | 'off' | 'tooBig' | 'denied';
/** What Rust rejects `trash_entries` with when there is no bin (`TrashError::NoBin`); any other
 * failure is a plain string. `trashEntries` below reads it defensively. The IPC contract test
 * (`ipc-contract.test.ts`) pins this shape to the Rust one. */
export interface NoBinRefusal {
  noBin: string;
  reason: NoBinReason;
  paths: string[];
  message: string;
}
const reasons: readonly string[] = ['noBin', 'off', 'tooBig', 'denied'];

export class NoRecycleBin extends Error {
  constructor(
    /** `WSL`, a drive (`N:`) or a share (`\\server\share`) */
    readonly place: string,
    message: string,
    /** the place has no bin, its bin is turned off, or the batch is bigger than the bin */
    readonly reason: NoBinReason = 'noBin',
    /** every path of the batch that cannot go to a bin; empty = the whole batch */
    readonly paths: string[] = [],
  ) {
    super(message);
    this.name = 'NoRecycleBin';
  }
  override toString() {
    return this.message;
  }
}

/** To the Recycle Bin, all or nothing. Rejects with `NoRecycleBin` where there is no bin. */
export const trashEntries = async (paths: string[]) => {
  try {
    await invoke<void>('trash_entries', { paths });
  } catch (e) {
    const refused = e as {
      noBin?: unknown;
      message?: unknown;
      reason?: unknown;
      paths?: unknown;
    } | null;
    if (typeof refused === 'object' && refused !== null && typeof refused.noBin === 'string') {
      const reason = reasons.includes(String(refused.reason))
        ? (refused.reason as NoBinReason)
        : 'noBin';
      const paths = Array.isArray(refused.paths) ? refused.paths.map(String) : [];
      throw new NoRecycleBin(refused.noBin, String(refused.message ?? ''), reason, paths);
    }
    throw e;
  }
};
/** gone for good — no Recycle Bin; stops at the first failure and names it */
export const deleteEntries = (paths: string[]) => invoke<void>('delete_entries', { paths });
/** Compress to ZIP file; resolves to the archive's path. */
export const compressEntries = (paths: string[]) => invoke<string>('compress_entries', { paths });

/** One operation "Retry as administrator" runs again elevated (`core/elevate.rs` `ElevatedOp`). */
export type ElevatedOp =
  | { kind: 'rename'; path: string; newName: string }
  | { kind: 'createFolder'; dir: string }
  | { kind: 'delete'; paths: string[] };

/** Runs `op` in a copy of Trove started through UAC that does only that and exits (plan 05 5.6).
 * Answers the new path (rename, new folder) or '' (delete). */
export const retryElevated = (op: ElevatedOp) => invoke<string>('retry_elevated', { op });

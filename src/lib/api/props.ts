// The only place the props commands and the `props:totals` / `props:folder-size` events
// appear. Mirrors src-tauri/src/commands/props.rs.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DriveKind, FolderSizeEvent, FolderTotals, Props } from '$lib/types/props';

export const fileProps = (path: string) => invoke<Props>('file_props', { path });

/** Only the given bits change; an omitted one is left alone. */
export const setFileAttributes = (path: string, bits: { readOnly?: boolean; hidden?: boolean }) =>
  invoke<void>('set_file_attributes', { path, ...bits });

/** Starts counting a folder's contents on a thread and returns the job id. */
export const startFolderTotals = (path: string) => invoke<number>('start_folder_totals', { path });

export const cancelFolderTotals = (jobId: number) =>
  invoke<void>('cancel_folder_totals', { jobId });

export const onFolderTotals = (cb: (t: FolderTotals) => void) =>
  listen<FolderTotals>('props:totals', (e) => cb(e.payload));

/** Which kind of drive a folder is on; the Size column's setting decides whether it is counted. */
export const folderDriveKind = (path: string) => invoke<DriveKind>('folder_drive_kind', { path });

/** Starts sizing these folders in the background and returns the job id; stop it with
 *  `cancelFolderTotals`. Each size arrives as a `props:folder-size` event. */
export const startFolderSizes = (paths: string[]) =>
  invoke<number>('start_folder_sizes', { paths });

export const onFolderSize = (cb: (s: FolderSizeEvent) => void) =>
  listen<FolderSizeEvent>('props:folder-size', (e) => cb(e.payload));

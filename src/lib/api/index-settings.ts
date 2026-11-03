// The only place the index-settings commands appear. Mirrors
// src-tauri/src/commands/index_settings.rs.
import { invoke } from '@tauri-apps/api/core';

export interface IndexDrive {
  /** `D:\` */
  root: string;
}

/** The fixed local drives the index can walk. */
export const indexDrives = () => invoke<IndexDrive[]>('index_drives');

/** Bytes the saved index takes on disk. */
export const indexDiskSize = () => invoke<number>('index_disk_size');

/** Delete the saved index files; returns the bytes freed. */
export const indexForget = () => invoke<number>('index_forget');

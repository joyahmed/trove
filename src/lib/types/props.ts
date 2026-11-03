// Mirrors src-tauri/src/core/props.rs (serde camelCase). Change both or neither.

/** One item's properties, as the Details pane shows them. */
export interface Props {
  path: string;
  name: string;
  isDir: boolean;
  /** Explorer's Type text; "File folder" for a directory */
  typeName: string;
  /** bytes; 0 for a directory */
  size: number;
  /** `GetCompressedFileSizeW`; 0 for a directory */
  sizeOnDisk: number;
  createdMs: number | null;
  modifiedMs: number | null;
  accessedMs: number | null;
  readOnly: boolean;
  hidden: boolean;
  system: boolean;
  archive: boolean;
}

/** `props:totals` — a folder's running contents count, at most every 250 ms, then `done`. */
export interface FolderTotals {
  jobId: number;
  files: number;
  folders: number;
  bytes: number;
  sizeOnDisk: number;
  /** folders counted as one item but not walked (a Mac media library, ~/Library): their
   *  bytes are not in `bytes` */
  notCounted: number;
  done: boolean;
}

/** Where a folder lives, for the Size column's setting (`core/folder_sizes.rs` `DriveKind`). */
export type DriveKind = 'local' | 'network' | 'removable' | 'wsl';

/** `props:folder-size` — one folder of a `start_folder_sizes` job, once its walk is done. */
export interface FolderSizeEvent {
  jobId: number;
  path: string;
  bytes: number;
  /** the walk stopped at its cap (1,000,000 entries or 10 s): `bytes` is a floor */
  capped: boolean;
}

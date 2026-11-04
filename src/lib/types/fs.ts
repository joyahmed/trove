// Mirrors src-tauri/src/core/fs.rs (serde camelCase). Change both or neither.

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** bytes; 0 for directories */
  size: number;
  /** Unix ms, null when the OS has none */
  modifiedMs: number | null;
  /** Unix ms, null when the filesystem has none — Explorer's "Date created" */
  createdMs: number | null;
  /** lower-cased extension without the dot, files only */
  ext: string | null;
  isHidden: boolean;
  /**
   * Which icon the shell gives this entry, decided in Rust: `folder` for a plain folder,
   * `ext/<ext>` for the association's icon, `file/<path>` for what carries its own (exe, lnk,
   * ico, url, scr, cur, and a folder with a desktop.ini). Render `<FolderIcon>` only for
   * `folder`; every `file/` key is an `<img>`, folder or not.
   */
  iconKey: string;
  /** Explorer's Type column text from the shell: "Text Document", "File folder", … */
  typeName: string;
  /** a junction, a symlink (listed as what it points at) or a macOS alias: draws the link
   * arrow. Rust sends it only when true. */
  isLink?: boolean;
  /** where a OneDrive (Cloud Files) file's bytes are; absent for a file no provider marked.
   * `core/fs.rs` `CloudState`. */
  cloudState?: CloudState;
}

/** `online`: only a placeholder is here. `pinned`: always kept on this device. `local`: here,
 * and "Free up space" may turn it back into a placeholder. */
export type CloudState = 'online' | 'pinned' | 'local';

/** A sync root's state as its provider reports it, `core/sync_root.rs` `SyncStatus`. */
export type SyncStatus = 'up-to-date' | 'syncing' | 'offline' | 'error';

export interface DirListing {
  path: string;
  entries: FileEntry[];
}

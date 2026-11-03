// Mirrors src-tauri/src/core/shell.rs (serde camelCase). Change both or neither.

export type KnownFolderKey =
  'desktop' | 'downloads' | 'documents' | 'pictures' | 'music' | 'videos';

export interface KnownFolder {
  key: KnownFolderKey;
  label: string;
  path: string;
}

export interface DriveInfo {
  /** `C:\` on Windows; `/` or `/Volumes/<name>` on macOS; `/`, `/media/…` or `/mnt/<name>` on Linux */
  path: string;
  label: string;
  /** null when the OS would not say: unknown is not zero */
  totalBytes: number | null;
  freeBytes: number | null;
  /**
   * A network share (SMB, AFP, NFS, WebDAV, sshfs ...). Its sizes are always null, and nothing
   * walks it on its own - a search from This PC or the palette's every-drive pass leaves it out.
   * Touching one is what makes macOS ask "Trove would like to access files on a network volume"
   * (`core/mounts.rs`). Missing or false on Windows.
   */
  network?: boolean;
}

/** The room left on the volume that really holds a folder, and where that volume is mounted
 * (`folder_space`, src-tauri `core/volume.rs`). Mirrors `FolderSpace` there. */
export interface FolderSpace {
  freeBytes: number;
  mountRoot: string;
}

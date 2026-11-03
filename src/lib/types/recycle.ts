// Mirrors src-tauri/src/core/recycle.rs (serde camelCase). Change both or neither.

export interface RecycleItem {
  /** the trash crate's item id (on macOS the item's path in ~/.Trash) — the handle for purge */
  id: string;
  name: string;
  /** the folder the item was deleted from; null where the OS does not record it (the macOS
   *  Trash) — then Restore and "Open original location" are not offered */
  originalParent: string | null;
  /** Unix ms: when it was deleted; on macOS when it was last modified (the Trash keeps no
   *  deletion date) */
  deletedMs: number;
  /** always false from the trash crate (it does not say) and the view guesses from the name;
   *  the macOS Trash fills it in */
  isDir: boolean;
  /** bytes, where known (files in the macOS Trash); null otherwise */
  size: number | null;
}

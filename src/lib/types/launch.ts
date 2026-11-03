// Mirrors src-tauri/src/core/launch.rs (serde camelCase). Change both or neither.

export interface Launch {
  /** folder to show, or a `::{CLSID}` shell folder the frontend maps to a place; for /select, the item's parent */
  path: string | null;
  /** item to highlight inside `path` */
  select: string | null;
  /** `--hidden`: started in the tray by the "start with Windows" entry */
  hidden: boolean;
}

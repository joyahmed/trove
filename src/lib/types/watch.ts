// Mirrors src-tauri/src/core/watch.rs (serde camelCase). Change both or neither.

export interface FsChanged {
  /** the watched folder, exactly as it was passed to `watch_path` */
  path: string;
  /** `changed`: something inside it moved; `gone`: the folder itself was moved or deleted */
  kind: 'changed' | 'gone';
}

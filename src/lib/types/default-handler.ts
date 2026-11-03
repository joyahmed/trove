// Mirrors src-tauri/src/core/default_handler.rs (serde camelCase). Change both or neither.

/** What the HKCU registry says right now about who handles folder opens. */
export type HandlerStatus =
  | { kind: 'not-applied' }
  | { kind: 'applied' }
  | { kind: 'partially-applied'; applied: string[] }
  | { kind: 'applied-to-other'; exe: string };

export interface HandlerInfo {
  /** this process's exe, the path the registry keys would point at */
  exePath: string;
  /** false under `target\`, Temp or Downloads — a path that will not stay put */
  stable: boolean;
}

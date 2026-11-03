// Mirrors src-tauri/src/core/pty.rs (serde camelCase). Change both or neither.

export interface PtyExit {
  sessionId: number;
  /** the shell's exit code; null when the OS did not report one */
  code: number | null;
}

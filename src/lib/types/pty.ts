// Mirrors src-tauri/src/core/pty.rs (serde camelCase). Change both or neither.

export interface PtyExit {
  sessionId: number;
  /** the shell's exit code; null when the OS did not report one */
  code: number | null;
}

/** The shell reported a new folder (OSC 7 / OSC 9;9) that exists: `pty:cwd`. */
export interface PtyCwd {
  sessionId: number;
  /** in the listing's own form: `/home/x`, `C:\x`, `\\wsl.localhost\Ubuntu\x` (PtyCwd, commands/pty.rs) */
  path: string;
}

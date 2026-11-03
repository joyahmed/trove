// The only place `invoke` appears for the start-time line (plan 21 gap 6). Mirrors
// src-tauri/src/commands/startup_timing.rs.
import { invoke } from '@tauri-apps/api/core';

/** The first view is on screen: Rust logs `starting → painted` in ms, once per process. */
export const startupPainted = (what: string, rows: number) =>
  invoke<void>('startup_painted', { what, rows });

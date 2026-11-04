// The open windows and their folder tabs, for "Restore tabs" (plan 15 G.45). Mirrors
// src-tauri/src/commands/session.rs; the rules (who is kept, who is forgotten) live in Rust.
import { invoke } from '@tauri-apps/api/core';

/** One window as the last run left it: its folder tabs and which one was active. */
export interface SavedWindow {
  label: string;
  tabs: string[];
  active: number;
  /** Where the window was (Rust keeps it for the restore; the tabs list ignores it). Absent
   * for a window saved before bounds were kept. */
  bounds?: { x: number; y: number; w: number; h: number; maximized: boolean };
}

export interface SavedSession {
  windows: SavedWindow[];
}

/** This window's folder tabs now. Rust takes the label from the caller, never from here. */
export const saveWindowTabs = (tabs: string[], active: number) =>
  invoke<void>('save_window_tabs', { tabs, active });

/**
 * What was open when the last run ended, `main`'s window first; `null` when the last run left
 * no session (a first run, an older build) or it was already handed out this run.
 */
export const takeLastSession = () => invoke<SavedSession | null>('take_last_session');

/**
 * `main`'s hidden start: keep these windows (tabs, active tab) in the session until it opens
 * them on its first show; `[]` releases them. Ignored from any other window.
 */
export const holdWindows = (windows: { tabs: string[]; active: number }[]) =>
  invoke<void>('hold_windows', { windows });

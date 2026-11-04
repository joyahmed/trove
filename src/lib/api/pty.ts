// The only place the pty commands, the output `Channel` and the "pty:exit" / "pty:cwd" events
// appear.
// Mirrors src-tauri/src/commands/pty.rs.
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PtyCwd, PtyExit } from '$lib/types/pty';

/**
 * Spawn a shell at `path` ('' = the user profile); output chunks arrive on `onOutput`.
 * `plain`: Trove's own `/bin/sh` in the home folder, no rc file, prompt `PLAIN_PROMPT`
 * (the Ubuntu uninstall types into nothing else). Refused on Windows.
 */
export const ptySpawn = (
  path: string,
  cols: number,
  rows: number,
  onOutput: (chunk: string) => void,
  plain = false,
) => {
  const channel = new Channel<string>();
  channel.onmessage = onOutput;
  return invoke<number>('pty_spawn', { path, cols, rows, onOutput: channel, plain });
};

/** The prompt of a `plain` shell; mirrors `PLAIN_PROMPT` in src-tauri/src/core/pty.rs. */
export const PLAIN_PROMPT = 'trove-uninstall$ ';

export const ptyWrite = (sessionId: number, data: string) =>
  invoke<void>('pty_write', { sessionId, data });

export const ptyResize = (sessionId: number, cols: number, rows: number) =>
  invoke<void>('pty_resize', { sessionId, cols, rows });

export const ptyKill = (sessionId: number) => invoke<void>('pty_kill', { sessionId });

/**
 * What `pty_follow` did: typed the `cd`; `busy` — a program runs in the shell, so nothing was
 * typed (it would have been that program's input); `otherShell` — a folder this shell cannot
 * reach (a WSL folder in PowerShell, another distro).
 */
export type Followed = 'typed' | 'busy' | 'otherShell';

/** `cd` the shell to `path` when it is the right kind of shell and sits at its prompt. */
export const ptyFollow = (sessionId: number, path: string) =>
  invoke<Followed>('pty_follow', { sessionId, path });

/** The shell of a session ended. Returns the unlisten fn. */
export const onPtyExit = (cb: (e: PtyExit) => void) =>
  listen<PtyExit>('pty:exit', (e) => cb(e.payload));

/**
 * The shell of a session reported a new folder that exists (OSC 7 / OSC 9;9, parsed in
 * src-tauri/src/core/pty_cwd.rs). Returns the unlisten fn.
 */
export const onPtyCwd = (cb: (e: PtyCwd) => void) =>
  listen<PtyCwd>('pty:cwd', (e) => cb(e.payload));

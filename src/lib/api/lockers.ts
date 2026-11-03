// The only place `invoke` appears for who holds a file open (plan 21B). Mirrors
// src-tauri/src/commands/lockers.rs.
import { invoke } from '@tauri-apps/api/core';

/** One program that holds a file open. */
export interface Locker {
  pid: number;
  /** "Microsoft Word", else the exe's file name */
  app: string;
  /** `WINWORD.EXE`; empty when Windows would not say */
  exe: string;
  /** false: Windows needs it, or it is Trove — no End task, "close it yourself" instead */
  canEnd: boolean;
  /** why there is no End task; null exactly when `canEnd` */
  noEnd: NoEnd | null;
}

/** Why a program gets no End task: Trove (this window or another), the terminal pane's shell,
 * a program Windows needs, or one in another Windows session. */
export type NoEnd = 'trove' | 'terminal' | 'windows' | 'otherSession';

/** A path and who holds it; Rust leaves out a path nobody holds. */
export interface LockedPath {
  path: string;
  lockers: Locker[];
}

/** `stillRunning`: asked politely and still there after the wait — Force end is next. */
export type Ended = 'ended' | 'stillRunning';

/** Who holds each of `paths`, when `error` is "in use" (os error 32 / 33). Empty otherwise and
 * on every OS but Windows; never rejects on the Rust side. */
export const whoIsLocking = (paths: string[], error: string) =>
  invoke<LockedPath[]>('who_is_locking', { paths, error });

/** Close the program `pid` that holds `path`; `force` kills it. Ask the person first. */
export const endLockingApp = (path: string, pid: number, force: boolean) =>
  invoke<Ended>('end_locking_app', { path, pid, force });

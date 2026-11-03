// The only place `@tauri-apps/plugin-log` appears. Mirrors src-tauri/src/core/logging.rs.
//
// Trove used to say nothing at runtime: zero `console.*` in this tree, and 12 `catch {}`
// blocks that bound no error at all. A failure reached the person as a toast that faded, or
// as nothing. See docs/plans/07-the-log-and-four-bugs.md § A.3.
//
// ⚠️ Every function here is **fire-and-forget and never throws**. Logging sits inside catch
// blocks, so a logger that can fail would replace the error being reported with its own — and
// under vitest (`environment: 'node'`) there is no Tauri bridge at all, so the invoke rejects
// on every call. Swallowing here is correct; swallowing at the call site was the bug.
import { attachConsole, debug, error, info, warn } from '@tauri-apps/plugin-log';

/** Never let a logging failure escape into the code being logged. */
const safe = (p: () => Promise<unknown>) => {
  try {
    void p().catch(() => {});
  } catch {
    // no bridge (tests, a dead webview) — nothing to do and nothing to report
  }
};

/**
 * An error that was going to be swallowed. `where` is the call site, so the log line says
 * which silence this was: `logError('places.reload', e)`.
 *
 * ⚠️ Deliberately not a toast. The silent catches are silent *on purpose* — a failed
 * `releasePointerCapture` is not an incident — and turning them into user-facing errors trades
 * silence for noise, which is how a log gets switched off. They gain a line here, nothing more.
 */
export const logError = (where: string, e: unknown) => safe(() => error(`${where}: ${fmt(e)}`));

export const logWarn = (where: string, e: unknown) => safe(() => warn(`${where}: ${fmt(e)}`));

/** A thing that happened and is worth having in the file. No paths — see A.4. */
export const logInfo = (message: string) => safe(() => info(message));

/** ⛔ Paths go here and nowhere else: `debug` is not recorded by a release build (A.4). */
export const logDebug = (message: string) => safe(() => debug(message));

/** `Error` keeps its stack; a Tauri command's rejection is already a plain string. */
const fmt = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/**
 * Send the webview's own `console.*` into the same file as the Rust side. A log split across
 * two places is a large part of why the IPC boundary stayed invisible: an error thrown in the
 * frontend and an error returned by a command were never readable next to each other.
 */
export const attachLogConsole = () => safe(attachConsole);

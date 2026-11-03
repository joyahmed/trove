// Who is locking this file (plan 21 phase 21B). A delete, move or rename that failed because a
// program has the file open names that program — "Microsoft Word has report.docx open" — and
// offers Retry and End task. Rust decides what counts as "in use" and who holds it (Windows'
// Restart Manager); elsewhere it finds nobody and the plain error stays as it was.
//
// ⛔ End task loses unsaved work. It always asks first (Enter = Cancel), asks the program to
// close politely, and only offers Force end — a second question — if it is still running.
// Trove itself (any Trove window), its terminal pane's shell, Explorer, services, critical
// programs and programs in another Windows session get no End task at all: Rust marks them
// `canEnd: false` with the reason (`noEnd`) and refuses them again if asked anyway.
import { endLockingApp, whoIsLocking, type LockedPath, type Locker } from '$lib/api/lockers';
import { logError } from '$lib/api/log';
import { confirm } from '$lib/state/confirm.svelte';
import { notices } from '$lib/state/notices.svelte';

/** What a program Windows needs says instead of an End task button. */
export const WINDOWS_NEEDS = 'Windows needs this program; close it yourself.';
/** Trove (this window or another) holds it: there is nobody else to name. */
export const TROVE_ITSELF = 'Trove itself has this file open';
/** The terminal pane's shell, or a program started in it, holds it. */
export const TERMINAL_HAS_IT = "Trove's terminal has this file open — close it there";
/** It runs for another person signed in, or in Windows' own session. */
export const OTHER_SESSION = 'It runs in another Windows session; Trove cannot end it.';

const nameOf = (path: string) => path.split(/[\\/]/).at(-1) || path;

/** "Microsoft Word has report.docx open"; "Microsoft Word and Excel have …"; three or more
 * name the first two and count the rest. */
export const lockedMessage = (path: string, lockers: Locker[]) => {
  const apps = lockers.map((l) => l.app).filter((a, i, all) => all.indexOf(a) === i);
  const who =
    apps.length <= 2 ? apps.join(' and ') : `${apps[0]}, ${apps[1]} and ${apps.length - 2} more`;
  return `${who} ${apps.length === 1 ? 'has' : 'have'} ${nameOf(path)} open`;
};

/** The first program End task may close, or null (only programs Windows needs hold it). */
export const endable = (lockers: Locker[]) => lockers.find((l) => l.canEnd) ?? null;

/** Why `locker` gets no End task, in the words the person sees. */
export const whyNoEnd = (locker: Locker) => {
  if (locker.noEnd === 'trove') return TROVE_ITSELF;
  if (locker.noEnd === 'terminal') return TERMINAL_HAS_IT;
  return `${locker.app}: ${locker.noEnd === 'otherSession' ? OTHER_SESSION : WINDOWS_NEEDS}`;
};

/**
 * What a held file's notice or progress row says: who holds it ("Microsoft Word has
 * report.docx open"), then `more`, then — when none of them may be ended — why not. Trove's
 * own window or terminal says only that.
 */
export const heldMessage = (path: string, lockers: Locker[], more = '') => {
  const message = `${lockedMessage(path, lockers)}${more}`;
  if (endable(lockers)) return message;
  const why = lockers[0]?.noEnd;
  if (why === 'trove') return `${TROVE_ITSELF}${more}`;
  if (why === 'terminal') return `${TERMINAL_HAS_IT}${more}`;
  return `${message}. ${why === 'otherSession' ? OTHER_SESSION : WINDOWS_NEEDS}`;
};

/**
 * What a batch delete's error names besides the held files: `ops::delete_permanently` says
 * "N items could not be deleted — <path>: <why>; <path>: <why>", and the notice that names
 * the program must not drop the rest. "" for a one-item error or when only held files failed.
 */
export const otherFailures = (error: unknown, found: LockedPath[]) => {
  const m = /(\d+) items could not be deleted — (.*)$/s.exec(String(error));
  if (!m) return '';
  const n = Number(m[1]) - found.length;
  if (n <= 0) return '';
  const items = m[2]
    .split('; ')
    .filter((item) => !found.some((f) => item.startsWith(`${f.path}: `)));
  const listed = items.length === n ? ` — ${items.join('; ')}` : '';
  return ` + ${n} other ${n === 1 ? 'item' : 'items'} could not be deleted${listed}`;
};

/** Who holds `paths`, if `error` says "in use". Never throws: a failed lookup is "nobody". */
export const findLocked = async (paths: string[], error: unknown): Promise<LockedPath[]> => {
  try {
    return (await whoIsLocking(paths, String(error))) ?? [];
  } catch (e) {
    logError('lockers', e);
    return [];
  }
};

/**
 * End task for the program `locker` that holds `path`, then `retry` once. Asks first; closes
 * politely; asks again before Force end. true: the program is gone and `retry` ran.
 */
export const endTask = async (path: string, locker: Locker, retry: () => unknown) => {
  if (!locker.canEnd) {
    notices.push({ kind: 'warning', message: whyNoEnd(locker) });
    return false;
  }
  const ok = await confirm.ask({
    title: 'End task',
    message: `End ${locker.app}? Unsaved work in it will be lost.`,
    okLabel: 'End task',
    danger: true,
    cancelDefault: true,
  });
  if (!ok) return false;
  try {
    if ((await endLockingApp(path, locker.pid, false)) === 'stillRunning') {
      const force = await confirm.ask({
        title: 'Force end',
        message: `${locker.app} did not close. It may be asking you to save — check it first. Force end it? Unsaved work will be lost.`,
        okLabel: 'Force end',
        danger: true,
        cancelDefault: true,
      });
      if (!force) return false;
      await endLockingApp(path, locker.pid, true);
    }
  } catch (e) {
    logError('lockers', e);
    notices.push({ kind: 'error', message: String(e) });
    return false;
  }
  await retry();
  return true;
};

/**
 * A failed delete / rename: if a program holds one of `paths`, raise the notice that names it,
 * with Retry and End task (or why not, and Retry alone), plus what else the error said could
 * not be deleted (`otherFailures`). false: nobody holds them — the caller shows its plain
 * error as before.
 */
export const notifyLocked = async (paths: string[], error: unknown, retry: () => unknown) => {
  const found = await findLocked(paths, error);
  const first = found[0];
  if (!first) return false;
  const target = endable(first.lockers);
  const more = found.length > 1 ? ` (and ${found.length - 1} more in use)` : '';
  notices.push({
    kind: 'error',
    message: `${heldMessage(first.path, first.lockers, more)}${otherFailures(error, found)}`,
    action: { label: 'Retry', run: retry },
    second: target
      ? { label: 'End task', run: () => endTask(first.path, target, retry) }
      : undefined,
  });
  return true;
};

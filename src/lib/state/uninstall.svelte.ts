// Uninstall from the Applications place (plan 18, Phases 2-4). Trove asks first, then hands the job
// to the OS's own way (Windows: the app's own uninstaller; Mac: the bundle goes to the Trash) and
// re-lists to say what happened. A Mac app is never deleted for good, not even as a fallback.
//
// ⛔ Rules: the confirm comes first, every time, and names the registry ROW (name, version,
// publisher), not the tile — if the join picked the wrong program, the person sees it before
// anything runs; it also shows the program that will run. Rust gets the id plus what the
// confirm showed (name, version, program) and refuses if the entry changed meanwhile. "was uninstalled" only once the row left the list.
// One uninstall at a time. After an uninstaller that handed off and exited early, the list is
// re-read on window focus (and F5) for up to 10 minutes.
// Ubuntu (plan 18, Phase 4): GNOME Software opens on the app, or — without it — the removal line
// is typed (no newline) into a FRESH plain shell (`/bin/sh`, no rc file, Trove's own prompt) and
// only after that exact prompt showed; Enter is the person's. ⛔ Never written into a live session
// or the person's own shell (vim, tmux, a Y/n prompt would take the letters as commands): copied.
import { clipboardWriteText } from '$lib/api/clipboard';
import { PLAIN_PROMPT } from '$lib/api/pty';
import { logError } from '$lib/api/log';
import { openAppsSettings, uninstallApp, uninstallList } from '$lib/api/uninstall';
import { applications } from '$lib/state/applications.svelte';
import { confirm } from '$lib/state/confirm.svelte';
import { notices } from '$lib/state/notices.svelte';
import type { AppEntry } from '$lib/types/palette';
import type { Uninstallable } from '$lib/types/uninstall';
import { onLinux, onMac, onWindows, uninstallVerb } from '$lib/utils/platform';
import {
  BUSY_TEXT,
  confirmText,
  copiedNotice,
  goneLaterNotice,
  outcomeNotice,
  reasonText,
} from '$lib/utils/uninstall-text';

/** How long after an uninstall Trove keeps re-checking on focus. */
export const WATCH_MS = 10 * 60 * 1000;
/** How long a fresh shell may take to print its prompt before Trove copies instead of typing. */
export const PROMPT_MS = 5000;

/**
 * Which uninstall this host has: Windows runs the app's uninstaller, Mac moves it to the Trash,
 * Ubuntu opens GNOME Software or types the removal line.
 */
export type UninstallOs = 'windows' | 'mac' | 'linux' | 'other';
const hostOs = (): UninstallOs =>
  onWindows() ? 'windows' : onMac() ? 'mac' : onLinux() ? 'linux' : 'other';

// ⛔ Loaded on use, not imported: terminal → tabs → tab → this file would be a cycle.
type Terminal = (typeof import('$lib/state/terminal.svelte'))['terminal'];
const loadTerminal = async (): Promise<Terminal> =>
  (await import('$lib/state/terminal.svelte')).terminal;

/** A shell is running (or starting) in the pane: never write into it. */
const terminalLive = (terminal: Terminal) => terminal.open || terminal.sessionId !== null;

const norm = (p: string) => p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/**
 * The registry row a Start-menu tile belongs to (plan 18, 2.1): the tile's exe under the row's
 * folder — the longest folder wins, a tie is no match — else the one row whose name equals the
 * tile's (case-insensitive; two or more is no match). `null` = no uninstaller found.
 */
export const matchRow = (app: AppEntry, rows: readonly Uninstallable[]): Uninstallable | null => {
  const target = norm(app.target || app.path);
  if (target) {
    let best: Uninstallable[] = [];
    let bestLen = -1;
    for (const r of rows) {
      const folder = norm(r.folder);
      if (!folder || !target.startsWith(`${folder}\\`)) continue;
      if (folder.length > bestLen) {
        best = [r];
        bestLen = folder.length;
      } else if (folder.length === bestLen) best.push(r);
    }
    if (best.length === 1) return best[0];
    if (best.length > 1) return null;
  }
  const name = app.name.trim().toLowerCase();
  const byName = rows.filter((r) => r.name.trim().toLowerCase() === name);
  return byName.length === 1 ? byName[0] : null;
};

/** A Store (packaged) app: started by id only, nothing on disk Trove can see. */
export const isStoreApp = (app: AppEntry) => !app.lnkPath && !app.target && app.aumid !== '';

/** What the menu item does for one tile. */
export type UninstallCheck =
  { kind: 'row'; row: Uninstallable } | { kind: 'settings' } | { kind: 'refused'; reason: string };

export const checkApp = (
  app: AppEntry,
  rows: readonly Uninstallable[],
  os: UninstallOs,
): UninstallCheck => {
  if (os === 'other') return { kind: 'refused', reason: reasonText('notYet') };
  if (os === 'mac') {
    // the bundle path itself, exactly: no name guess, no folder prefix
    const row = rows.find((r) => r.folder !== '' && r.folder === app.path);
    if (!row) return { kind: 'refused', reason: reasonText('noMatch') };
    return row.removable === 'yes'
      ? { kind: 'row', row }
      : { kind: 'refused', reason: reasonText(row.removable) };
  }
  if (os === 'linux') {
    // one row per `.desktop` file: the exact path, nothing fuzzy
    const row = app.path ? rows.find((r) => r.path === app.path) : undefined;
    if (!row) return { kind: 'refused', reason: reasonText('noMatch', true) };
    return row.removable === 'yes'
      ? { kind: 'row', row }
      : { kind: 'refused', reason: reasonText(row.removable, true) };
  }
  const row = matchRow(app, rows);
  if (row) {
    return row.removable === 'yes'
      ? { kind: 'row', row }
      : { kind: 'refused', reason: reasonText(row.removable) };
  }
  // decision 2026-10-07 (plan 18 Q3): a Store app opens Settings → Installed apps
  if (isStoreApp(app)) return { kind: 'settings' };
  return { kind: 'refused', reason: reasonText('noMatch') };
};

class UninstallState {
  rows = $state.raw<Uninstallable[]>([]);
  loaded = $state(false);
  /** an uninstaller Trove started has not ended yet */
  running = $state(false);
  /** the row whose uninstaller ended while it was still listed, and until when to look again */
  #watch: { row: Uninstallable; until: number } | null = null;
  /** the host, read live from the injected platform; tests may pin it (`null` = read live) */
  host: UninstallOs | null = null;
  get os(): UninstallOs {
    return this.host ?? hostOs();
  }

  load() {
    return this.loaded ? Promise.resolve() : this.reload();
  }

  async reload() {
    try {
      this.rows = await uninstallList();
      this.loaded = true;
    } catch (e) {
      logError('uninstall.reload', e);
      return;
    }
    const w = this.#watch;
    if (!w) return;
    if (!this.rows.some((r) => r.id === w.row.id)) {
      this.#stopWatching();
      notices.push(goneLaterNotice(w.row));
      void applications.reload();
    } else if (Date.now() > w.until) this.#stopWatching();
  }

  check(app: AppEntry): UninstallCheck {
    return checkApp(app, this.rows, this.os);
  }

  /** The menu item's state: greyed with a reason, or live. */
  menuState(app: AppEntry): { enabled: boolean; reason: string } {
    const c = this.check(app);
    return c.kind === 'refused'
      ? { enabled: false, reason: c.reason }
      : { enabled: true, reason: '' };
  }

  /** Right-click → Uninstall. Confirm first; only a yes sends the row as the confirm showed it. */
  async ask(app: AppEntry) {
    const c = this.check(app);
    if (c.kind === 'refused') return;
    if (c.kind === 'settings') {
      try {
        await openAppsSettings();
      } catch (e) {
        logError('uninstall.settings', e);
        notices.push({ kind: 'error', message: `Couldn’t open Installed apps: ${String(e)}` });
      }
      return;
    }
    if (this.running) {
      notices.push({ kind: 'warning', message: BUSY_TEXT });
      return;
    }
    const row = c.row;
    const linux = this.os === 'linux';
    const terminal = linux ? await loadTerminal() : null;
    const ok = await confirm.ask({
      ...confirmText(row, linux, terminal !== null && terminalLive(terminal)),
      okLabel: uninstallVerb(),
      danger: true,
    });
    if (!ok) return;
    this.running = true;
    try {
      // Rust re-resolves the id and refuses a changed row; for a typed row it starts nothing
      const outcome = await uninstallApp(row);
      if (outcome === 'typedInTerminal') await this.#type(row, terminal ?? (await loadTerminal()));
      else notices.push(outcomeNotice(row, outcome));
      // noTrash: nothing moved, so there is nothing to wait for
      if (outcome !== 'gone' && outcome !== 'noTrash') this.#watchFor(row);
    } catch (e) {
      logError('uninstall.app', e);
      notices.push({ kind: 'error', message: String(e) });
    } finally {
      this.running = false;
    }
    await Promise.all([this.reload(), applications.reload()]);
  }

  /**
   * Type the confirmed line into a fresh PLAIN shell, with NO newline. Only when no session is
   * live: ask for a plain shell, open the pane (its mount spawns it), wait for `PLAIN_PROMPT`,
   * then write. Otherwise — a live session, no prompt, or the shell that came up is not the plain
   * one — copy it instead.
   */
  async #type(row: Uninstallable, terminal: Terminal) {
    if (!terminalLive(terminal)) {
      terminal.requestPlain();
      const prompt = terminal.waitFor(PLAIN_PROMPT, PROMPT_MS);
      terminal.open = true;
      const got = await prompt;
      // the first chunk can arrive before the spawn call returns the session id
      for (let i = 0; got && i < 20 && terminal.sessionId === null; i++)
        await new Promise((r) => setTimeout(r, 50));
      // ⛔ no await from here to write: keystrokes typed after the prompt appears must not land
      // first. The id poll above only runs when the spawn call has not returned yet (terminal
      // state has no input lock, and none is built for this).
      if (got && terminal.plain && terminal.sessionId !== null && !terminal.exited) {
        terminal.write(row.program);
        notices.push(outcomeNotice(row, 'typedInTerminal'));
        return;
      }
      // no spawn took the request: the person's next Ctrl+` must get their own shell back
      terminal.requestPlain(false);
    }
    let copied = true;
    try {
      await clipboardWriteText(row.program);
    } catch (e) {
      logError('uninstall.copy', e);
      copied = false;
    }
    notices.push(copiedNotice(row, copied));
  }

  /** The window came back to the front: the uninstaller may have finished meanwhile. */
  onFocus = () => {
    if (!this.#watch) return;
    if (Date.now() > this.#watch.until) this.#stopWatching();
    else void this.reload();
  };

  #watchFor(row: Uninstallable) {
    this.#watch = { row, until: Date.now() + WATCH_MS };
    if (typeof window !== 'undefined') window.addEventListener('focus', this.onFocus);
  }

  #stopWatching() {
    this.#watch = null;
    if (typeof window !== 'undefined') window.removeEventListener('focus', this.onFocus);
  }

  get watching() {
    return this.#watch?.row.id ?? null;
  }
}

export const uninstall = new UninstallState();

// The Applications list re-read itself (a new app in ~/Applications, F5): read the rows again too,
// or the new tile has no row and its "Move to Trash" greys as "Not found in Applications".
applications.onRefresh = () => {
  if (uninstall.loaded) void uninstall.reload();
};

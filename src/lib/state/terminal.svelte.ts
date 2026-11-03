// The bottom terminal pane: open or not, its one PTY session, and the bytes flowing between the
// shell and the terminal component. The component mounts lazily, so output that arrives before
// it is ready is buffered and flushed when the sink is set. Height and "follow the folder" are
// settings; the session is per window and survives switching tabs — closing the pane kills it.
import { onPtyExit, ptyFollow, ptyKill, ptyResize, ptySpawn, ptyWrite } from '$lib/api/pty';
import { settings } from '$lib/state/settings.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { PtyExit } from '$lib/types/pty';
import { logError } from '$lib/api/log';

type Sink = (chunk: string) => void;

/**
 * How long the shell's output must stay quiet before a `cd` refused as busy is asked again. A
 * program ending prints (at least the prompt), so quiet output after output is the cue.
 */
export const FOLLOW_QUIET_MS = 400;

class TerminalState {
  open = $state(false);
  sessionId = $state<number | null>(null);
  /** the folder the session was spawned at ('' = the user profile) */
  path = $state('');
  exited = $state(false);
  exitCode = $state<number | null>(null);
  error = $state<string | null>(null);
  pendingOutput = $state<string[]>([]);
  /**
   * The live session is a `plain` shell (Trove's `/bin/sh`, no rc, known prompt) — set only once
   * its id is assigned, cleared by any other spawn and by kill. It never follows navigation.
   */
  plain = $state(false);

  #sink: Sink | null = null;
  #cols = 80;
  #rows = 24;
  /** the NEXT spawn is plain (`requestPlain`); read and cleared by that spawn */
  #plainNext = false;
  /** each gets every chunk the shell prints (`waitFor`) */
  #listeners: Array<(chunk: string) => void> = [];
  /** the folder a busy shell was not moved to yet; the newest navigation wins */
  #queuedFollow: string | null = null;
  #followTimer: ReturnType<typeof setTimeout> | null = null;
  /** bumped per follow sent: only the newest one's answer may move `path` or fill the queue */
  #followSeq = 0;

  /**
   * Which spawn owns the pane. Spawns overlap in ordinary use — Restart hit twice, Restart while
   * the emulator's first `onReady` is still spawning, closing the pane mid-spawn — and `kill`
   * cannot kill a `sessionId` that an awaited `ptySpawn` has not assigned yet, so without this the
   * losing session's PTY survives with nothing holding its id: a live shell, for the rest of the
   * app's life, still streaming into the pane (the backend keeps it in its map and offers no
   * kill-by-anything-else). So a superseded spawn does not merely decline to write the id — it
   * kills the PTY it just opened, and its output never reaches the sink.
   */
  #generation = 0;

  get height() {
    return settings.terminalHeight;
  }
  set height(px: number) {
    settings.setTerminalHeight(px);
  }
  get follow() {
    return settings.terminalFollow;
  }
  set follow(v: boolean) {
    settings.terminalFollow = v;
  }

  toggle() {
    if (this.open) this.close();
    else this.open = true;
  }

  /** Where the terminal component writes; null while it is not mounted. */
  setSink(sink: Sink | null) {
    this.#sink = sink;
    if (sink && this.pendingOutput.length) {
      for (const chunk of this.pendingOutput) sink(chunk);
      this.pendingOutput = [];
    }
  }

  #output = (chunk: string) => {
    for (const l of [...this.#listeners]) l(chunk);
    if (this.#queuedFollow !== null) this.#retryFollowWhenQuiet();
    if (this.#sink) this.#sink(chunk);
    else this.pendingOutput.push(chunk);
  };

  /**
   * Resolves `true` once the shell's output since this call contains `text` (chunks joined, so a
   * prompt split across two chunks still counts), `false` if it did not within `ms`. Ask BEFORE
   * opening the pane, or the text may be missed.
   */
  waitFor(text: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let seen = '';
      const finish = (got: boolean) => {
        clearTimeout(timer);
        this.#listeners = this.#listeners.filter((l) => l !== listen);
        resolve(got);
      };
      const listen = (chunk: string) => {
        seen += chunk;
        if (seen.includes(text)) finish(true);
      };
      const timer = setTimeout(() => finish(false), ms);
      this.#listeners.push(listen);
    });
  }

  /** The next spawn opens a plain shell (the uninstall flow's), not the user's own; `false` withdraws it. */
  requestPlain(on = true) {
    this.#plainNext = on;
  }

  /** Start a shell at the active folder (the user profile on a place), ending any previous one. */
  async spawn(cols = this.#cols, rows = this.#rows) {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    const plain = this.#plainNext;
    this.#plainNext = false;
    this.plain = false;
    const previous = this.sessionId;
    this.sessionId = null;
    this.#dropQueuedFollow();
    this.#cols = cols;
    this.#rows = rows;
    this.exited = false;
    this.exitCode = null;
    this.error = null;
    this.path = tabs.active.path;
    await this.#kill(previous);
    // a newer spawn, or a close, took the pane while the old shell was being killed
    if (!current()) return;
    try {
      const id = await ptySpawn(
        this.path,
        cols,
        rows,
        (chunk) => {
          if (current()) this.#output(chunk);
        },
        plain,
      );
      if (current()) {
        this.sessionId = id;
        this.plain = plain;
      } else await this.#kill(id);
    } catch (e) {
      if (current()) this.error = String(e);
    }
  }

  write(data: string) {
    if (this.sessionId !== null && !this.exited) void ptyWrite(this.sessionId, data);
  }

  resize(cols: number, rows: number) {
    this.#cols = cols;
    this.#rows = rows;
    if (this.sessionId !== null && !this.exited) void ptyResize(this.sessionId, cols, rows);
  }

  /** End the session; a spawn still in flight is superseded and kills its own PTY. */
  async kill() {
    ++this.#generation;
    this.#dropQueuedFollow();
    const id = this.sessionId;
    this.sessionId = null;
    this.plain = false;
    await this.#kill(id);
  }

  async #kill(id: number | null) {
    if (id === null) return;
    try {
      await ptyKill(id);
    } catch (e) {
      logError('terminal.ptyKill', e);
      // already gone
    }
  }

  /**
   * The active tab moved: `cd` the shell along when the pane follows the folder. A shell
   * running a program gets nothing typed (the `cd` would be that program's input); the folder
   * is queued and asked again once the output goes quiet (`FOLLOW_QUIET_MS`).
   */
  onNavigated(path: string) {
    this.#dropQueuedFollow();
    // a plain shell holds a typed uninstall line: a `cd` after it would run with it on Enter
    if (this.plain) return;
    if (!this.open || !this.follow || this.sessionId === null || this.exited || !path) return;
    const id = this.sessionId;
    const seq = ++this.#followSeq;
    void ptyFollow(id, path).then(
      (did) => {
        if (id !== this.sessionId || seq !== this.#followSeq) return;
        if (did === 'typed') this.path = path;
        else if (did === 'busy') this.#queuedFollow = path;
      },
      (e) => logError('terminal.ptyFollow', e),
    );
  }

  #retryFollowWhenQuiet() {
    if (this.#followTimer !== null) clearTimeout(this.#followTimer);
    this.#followTimer = setTimeout(() => {
      this.#followTimer = null;
      const path = this.#queuedFollow;
      if (path !== null) this.onNavigated(path);
    }, FOLLOW_QUIET_MS);
  }

  #dropQueuedFollow() {
    this.#queuedFollow = null;
    if (this.#followTimer !== null) clearTimeout(this.#followTimer);
    this.#followTimer = null;
  }

  applyExit(e: PtyExit) {
    if (e.sessionId !== this.sessionId) return;
    this.exited = true;
    this.exitCode = e.code;
  }

  /** Subscribe to the shell's exit; returns the detach fn. */
  attach() {
    const unlisten = onPtyExit((e) => this.applyExit(e));
    return () => void unlisten.then((f) => f());
  }

  /** Closing the pane ends the shell (the plancheck's rule); reopening spawns a fresh one. */
  close() {
    this.open = false;
    this.pendingOutput = [];
    this.#sink = null;
    void this.kill();
  }
}

export const terminal = new TerminalState();

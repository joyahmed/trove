import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Followed } from '$lib/api/pty';

type Output = (chunk: string) => void;

const pty = vi.hoisted(() => ({
  ptySpawn: vi.fn<
    (
      path: string,
      cols: number,
      rows: number,
      onOutput: (chunk: string) => void,
      plain?: boolean,
    ) => Promise<number>
  >(async () => 7),
  ptyWrite: vi.fn(async () => {}),
  ptyResize: vi.fn(async () => {}),
  ptyKill: vi.fn<(sessionId: number) => Promise<void>>(async () => {}),
  ptyFollow: vi.fn<(id: number, path: string) => Promise<Followed>>(async () => 'typed'),
  onPtyExit: vi.fn(async () => () => {}),
}));
vi.mock('$lib/api/pty', () => pty);
vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => null),
  writeSettings: vi.fn(async () => {}),
}));
vi.mock('$lib/api/fs', () => ({ readDir: vi.fn() }));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
}));

import { FOLLOW_QUIET_MS, terminal } from './terminal.svelte';
import { tabs } from './tabs.svelte';
import { pathLocation } from '$lib/utils/location';

describe('terminal pane state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminal.close();
    tabs.active.location = pathLocation('C:\\work');
  });

  it('toggle opens and close kills the session', async () => {
    terminal.toggle();
    expect(terminal.open).toBe(true);
    await terminal.spawn(100, 30);
    expect(terminal.sessionId).toBe(7);
    terminal.close();
    expect(terminal.open).toBe(false);
    await vi.waitFor(() => expect(pty.ptyKill).toHaveBeenCalledWith(7));
  });

  it('spawns at the active folder with the given size', async () => {
    terminal.toggle();
    await terminal.spawn(120, 40);
    expect(pty.ptySpawn).toHaveBeenCalledWith('C:\\work', 120, 40, expect.any(Function), false);
    expect(terminal.path).toBe('C:\\work');
    expect(terminal.exited).toBe(false);
  });

  it('buffers output until a sink is set, then flushes in order', async () => {
    terminal.toggle();
    await terminal.spawn();
    const output: Output = pty.ptySpawn.mock.calls[0][3];
    output('a');
    output('b');
    expect(terminal.pendingOutput).toEqual(['a', 'b']);
    const seen: string[] = [];
    terminal.setSink((c) => seen.push(c));
    expect(seen).toEqual(['a', 'b']);
    expect(terminal.pendingOutput).toEqual([]);
    output('c');
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('write and resize go to the session, not after it exited', async () => {
    terminal.toggle();
    await terminal.spawn();
    terminal.write('ls\r');
    terminal.resize(90, 20);
    expect(pty.ptyWrite).toHaveBeenCalledWith(7, 'ls\r');
    expect(pty.ptyResize).toHaveBeenCalledWith(7, 90, 20);
    terminal.applyExit({ sessionId: 7, code: 0 });
    expect(terminal.exited).toBe(true);
    expect(terminal.exitCode).toBe(0);
    terminal.write('x');
    expect(pty.ptyWrite).toHaveBeenCalledTimes(1);
  });

  it('ignores an exit for another session', async () => {
    terminal.toggle();
    await terminal.spawn();
    terminal.applyExit({ sessionId: 99, code: 1 });
    expect(terminal.exited).toBe(false);
  });

  it('follows the folder only when open, following and alive', async () => {
    terminal.onNavigated('C:\\elsewhere');
    expect(pty.ptyFollow).not.toHaveBeenCalled();
    terminal.toggle();
    await terminal.spawn();
    terminal.follow = false;
    terminal.onNavigated('C:\\elsewhere');
    expect(pty.ptyFollow).not.toHaveBeenCalled();
    terminal.follow = true;
    terminal.onNavigated('C:\\elsewhere');
    expect(pty.ptyFollow).toHaveBeenCalledWith(7, 'C:\\elsewhere');
    await vi.waitFor(() => expect(terminal.path).toBe('C:\\elsewhere'));
    terminal.onNavigated('');
    expect(pty.ptyFollow).toHaveBeenCalledTimes(1);
  });

  it('a busy shell gets no cd; it is retried once the output goes quiet', async () => {
    vi.useFakeTimers();
    try {
      terminal.toggle();
      await terminal.spawn();
      const output = pty.ptySpawn.mock.calls[0][3];
      pty.ptyFollow.mockResolvedValueOnce('busy');
      terminal.onNavigated('C:\\a');
      await vi.advanceTimersByTimeAsync(FOLLOW_QUIET_MS * 3);
      expect(terminal.path).not.toBe('C:\\a');
      // no output, no retry: nothing says the program ended
      expect(pty.ptyFollow).toHaveBeenCalledTimes(1);
      // still busy at the next navigation: the newer folder replaces the queued one
      pty.ptyFollow.mockResolvedValueOnce('busy');
      terminal.onNavigated('C:\\b');
      await vi.advanceTimersByTimeAsync(0);
      // the program ends and the prompt comes back; more output keeps the retry waiting
      output('done\r\n');
      await vi.advanceTimersByTimeAsync(FOLLOW_QUIET_MS / 2);
      output('PS C:\\> ');
      await vi.advanceTimersByTimeAsync(FOLLOW_QUIET_MS / 2);
      expect(pty.ptyFollow).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(FOLLOW_QUIET_MS);
      expect(pty.ptyFollow).toHaveBeenCalledTimes(3);
      expect(pty.ptyFollow).toHaveBeenLastCalledWith(7, 'C:\\b');
      expect(terminal.path).toBe('C:\\b');
      // typed: nothing is queued any more
      output('more');
      await vi.advanceTimersByTimeAsync(FOLLOW_QUIET_MS * 2);
      expect(pty.ptyFollow).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('only the newest follow decides: an older busy answer queues nothing', async () => {
    terminal.toggle();
    await terminal.spawn();
    let answerA: (f: Followed) => void = () => {};
    pty.ptyFollow.mockImplementationOnce(() => new Promise((r) => (answerA = r)));
    terminal.onNavigated('C:\\a');
    terminal.onNavigated('C:\\b');
    answerA('busy');
    await vi.waitFor(() => expect(terminal.path).toBe('C:\\b'));
    const output = pty.ptySpawn.mock.calls[0][3];
    output('x');
    await new Promise((r) => setTimeout(r, FOLLOW_QUIET_MS * 2));
    expect(pty.ptyFollow).toHaveBeenCalledTimes(2);
  });

  it('closing the pane drops a queued cd', async () => {
    vi.useFakeTimers();
    try {
      terminal.toggle();
      await terminal.spawn();
      const output = pty.ptySpawn.mock.calls[0][3];
      pty.ptyFollow.mockResolvedValueOnce('busy');
      terminal.onNavigated('C:\\a');
      await vi.advanceTimersByTimeAsync(0);
      terminal.close();
      output('late');
      await vi.advanceTimersByTimeAsync(FOLLOW_QUIET_MS * 2);
      expect(pty.ptyFollow).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second spawn kills the first session', async () => {
    terminal.toggle();
    await terminal.spawn();
    await terminal.spawn();
    expect(pty.ptyKill).toHaveBeenCalledWith(7);
    expect(pty.ptySpawn).toHaveBeenCalledTimes(2);
  });

  /** Two spawns in flight at once, the first resolving last: no shell may be left running. */
  it('overlapping spawns orphan no PTY, and the loser stops writing', async () => {
    const resolve: ((id: number) => void)[] = [];
    const pending = () => new Promise<number>((r) => resolve.push(r));
    pty.ptySpawn.mockImplementationOnce(pending).mockImplementationOnce(pending);
    terminal.toggle();

    // Restart, then Restart again before the first shell has reported its id
    const first = terminal.spawn();
    await vi.waitFor(() => expect(pty.ptySpawn).toHaveBeenCalledTimes(1));
    const second = terminal.spawn();
    await vi.waitFor(() => expect(pty.ptySpawn).toHaveBeenCalledTimes(2));

    const seen: string[] = [];
    terminal.setSink((c) => seen.push(c));
    resolve[1](12); // the second shell comes up first…
    resolve[0](11); // …and the first, slow one lands after it
    await Promise.all([first, second]);

    const orphanOutput: Output = pty.ptySpawn.mock.calls[0][3];
    const mineOutput: Output = pty.ptySpawn.mock.calls[1][3];
    orphanOutput('orphan');
    mineOutput('mine');
    const survivor = terminal.sessionId;
    terminal.close();

    // the leak: the pane is gone, so every session it ever opened must have been killed
    await vi.waitFor(() => {
      const killed = pty.ptyKill.mock.calls.map(([id]) => id);
      expect([11, 12].filter((id) => !killed.includes(id))).toEqual([]);
    });
    // the pane kept the session that won, and heard nothing from the one it killed
    expect(survivor).toBe(12);
    expect(seen).toEqual(['mine']);
  });

  it('closing the pane while the shell is starting kills it', async () => {
    let resolve: (id: number) => void = () => {};
    pty.ptySpawn.mockImplementationOnce(() => new Promise<number>((r) => (resolve = r)));
    terminal.toggle();
    const spawning = terminal.spawn();
    await vi.waitFor(() => expect(pty.ptySpawn).toHaveBeenCalledTimes(1));
    terminal.close();
    resolve(21);
    await spawning;
    await vi.waitFor(() => expect(pty.ptyKill).toHaveBeenCalledWith(21));
    expect(terminal.sessionId).toBeNull();
  });

  it('a requested plain shell is used by the next spawn only, and never follows', async () => {
    terminal.requestPlain();
    terminal.toggle();
    await terminal.spawn();
    expect(pty.ptySpawn.mock.calls[0][4]).toBe(true);
    expect(terminal.plain).toBe(true);
    terminal.onNavigated('C:\\elsewhere');
    expect(pty.ptyFollow).not.toHaveBeenCalled();
    // Restart: the person's own shell again
    await terminal.spawn();
    expect(pty.ptySpawn.mock.calls[1][4]).toBe(false);
    expect(terminal.plain).toBe(false);
  });

  it('a withdrawn plain request spawns the normal shell', async () => {
    terminal.requestPlain();
    terminal.requestPlain(false);
    terminal.toggle();
    await terminal.spawn();
    expect(pty.ptySpawn.mock.calls[0][4]).toBe(false);
    expect(terminal.plain).toBe(false);
  });

  it('waitFor sees text split across chunks, and times out without it', async () => {
    terminal.toggle();
    await terminal.spawn();
    const output: Output = pty.ptySpawn.mock.calls[0][3];
    const seen = terminal.waitFor('trove-uninstall$ ', 1000);
    output('trove-unin');
    output('stall$ ');
    expect(await seen).toBe(true);
    const never = terminal.waitFor('trove-uninstall$ ', 20);
    output('hijacked> ');
    expect(await never).toBe(false);
  });
});

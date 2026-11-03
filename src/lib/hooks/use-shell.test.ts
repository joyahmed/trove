import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeSettings } from '$lib/api/settings';
import { settings } from '$lib/state/settings.svelte';
import { readFileSync } from 'node:fs';
import { shortcutFor } from '$lib/data/shortcuts';
import { comingFrom } from '$lib/state/coming-from.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { invoke } from '@tauri-apps/api/core';
import { CLOSE_FLUSH_LIMIT_MS, attachCloseFlush, reveal } from './use-shell.svelte';

/**
 * A close destroys the webview, and the settings save is debounced by 400 ms — so a change made
 * in the last moment before a close was lost outright. What is tested here is the close→flush
 * wiring the shell registers: the write has to FINISH, and then the window has to actually GO.
 *
 * ⛔ Both halves are asserted because only the first half was, last time. `c014476` shipped with
 * the write proven and the close unproven, and the window could not be closed at all. So the
 * harness below is Rust plus Tauri's JS wrapper plus this app's ACL, not a stub: `destroy` is
 * DENIED (`core:window:allow-destroy` is in neither the `core:window` default set nor
 * `capabilities/default.json`), and a JS listener makes Rust prevent the close
 * (`manager/window.rs:170`). A fix that leans on either leaves the window standing here.
 */
const io = vi.hoisted(() => {
  const state = {
    /** what happened, in order */
    log: [] as string[],
    listeners: new Map<number, (e: { preventDefault: () => void }) => void | Promise<void>>(),
    nextId: 1,
    /** `hide` is what `lib.rs`'s arm does when the app is resident */
    residency: 'close' as 'close' | 'hide',
    destroyed: false,

    reset() {
      state.log.length = 0;
      state.listeners.clear();
      state.nextId = 1;
      state.residency = 'close';
      state.destroyed = false;
    },

    async requestClose() {
      if (state.listeners.size === 0) {
        if (state.residency === 'hide') state.log.push('rust:hide');
        else {
          state.destroyed = true;
          state.log.push('rust:destroyed');
        }
        return;
      }
      for (const handler of [...state.listeners.values()]) {
        let prevented = false;
        await handler({ preventDefault: () => (prevented = true) });
        if (!prevented) {
          // the ACL denial, unhandled inside Tauri's listener exactly as in production
          state.log.push('destroy:denied');
        }
      }
    },
  };
  return state;
});

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'main',
    isVisible: vi.fn(async () => true),
    destroy: vi.fn(async () => {
      io.log.push('destroy:denied');
      throw new Error('window.destroy not allowed. Permissions: window:allow-destroy');
    }),
    close: vi.fn(async () => {
      io.log.push('close');
      await io.requestClose();
    }),
    onCloseRequested: vi.fn(
      async (h: (e: { preventDefault: () => void }) => void | Promise<void>) => {
        const id = io.nextId++;
        io.listeners.set(id, h);
        return async () => void io.listeners.delete(id);
      },
    ),
  }),
}));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}), setZoom: vi.fn() }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
// ⚠️ The write is deliberately a TIMER, not an already-resolved promise: a write that settles in
// a microtask lands before an awaited close even when the handler drops its promise, so a
// zero-cost mock would pass against the bug. The real thing is an `invoke` round trip.
vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => null),
  writeSettings: vi.fn(async () => {
    io.log.push('write:start');
    await new Promise((r) => setTimeout(r, 5));
    io.log.push('write:done');
  }),
  mergeSettings: vi.fn(async () => {}),
  emitSettingsChanged: vi.fn(async () => {}),
  onSettingsChanged: vi.fn(() => Promise.resolve(() => {})),
}));

const written = vi.mocked(writeSettings);

describe('the shell flushes settings when the window is asked to close', () => {
  beforeEach(async () => {
    io.reset();
    written.mockClear();
    await settings.load();
    await settings.flush(); // start each test with nothing pending from the last one
    io.reset();
    written.mockClear();
  });

  it('writes a change still inside the debounce, and the window then actually closes', async () => {
    await attachCloseFlush();

    // the save effect's move: a field changes, the write is scheduled and NOT yet made
    settings.showHidden = true;
    settings.scheduleSave(settings.snapshot());
    expect(written).not.toHaveBeenCalled();

    await io.requestClose();

    expect(written).toHaveBeenCalledTimes(1);
    expect(written.mock.calls[0]?.[0]).toMatchObject({ showHidden: true });
    // ⭐ both halves: the round trip completed while the webview was alive, AND the window went
    expect(io.log).toEqual(['write:start', 'write:done', 'close', 'rust:destroyed']);
    expect(io.destroyed).toBe(true);
  });

  it('closes with nothing pending — the flush is called unconditionally', async () => {
    await attachCloseFlush();
    await io.requestClose();
    expect(written).not.toHaveBeenCalled();
    expect(io.log).toEqual(['close', 'rust:destroyed']);
  });

  // Losing one settings write is bad; a window that cannot be closed is worse.
  it('still closes when the write fails', async () => {
    written.mockRejectedValueOnce(new Error('disk full'));
    await attachCloseFlush();
    settings.sidebarWidth = 300;
    settings.scheduleSave(settings.snapshot());

    await io.requestClose();

    expect(written).toHaveBeenCalledTimes(1);
    expect(io.destroyed).toBe(true);
  });

  // Every window closes through this now, a second one included: a write that never answers
  // must not leave the window standing.
  it('still closes when the write never answers', async () => {
    vi.useFakeTimers();
    let answer = () => {};
    try {
      written.mockImplementationOnce(() => new Promise<void>((resolve) => (answer = resolve)));
      await attachCloseFlush();
      settings.showHidden = !settings.showHidden;
      settings.scheduleSave(settings.snapshot());

      const closing = io.requestClose();
      await vi.advanceTimersByTimeAsync(CLOSE_FLUSH_LIMIT_MS);
      await closing;

      expect(io.destroyed).toBe(true);
    } finally {
      answer(); // the writes are chained: release it, or every later flush waits behind it
      vi.useRealTimers();
    }
  });

  // Never: it is denied by the ACL, and reaching for it is what left the window standing.
  it('never asks the window to destroy itself', async () => {
    await attachCloseFlush();
    settings.showHidden = true;
    settings.scheduleSave(settings.snapshot());
    await io.requestClose();
    expect(io.log).not.toContain('destroy:denied');
  });

  // Resident (`keepRunning`): Rust prevents the close and hides the window instead, so the write
  // still happens and the window must survive. It stays detached afterwards on purpose — a
  // listener re-attached while a close is in flight is what made the window unclosable, and a
  // hidden window keeps its debounce timer, so later resident writes land without this hook.
  it('writes and leaves the window alive when Rust hides it instead', async () => {
    io.residency = 'hide';
    await attachCloseFlush();
    settings.showHidden = true;
    settings.scheduleSave(settings.snapshot());

    await io.requestClose();

    expect(written).toHaveBeenCalledTimes(1);
    expect(io.log).toEqual(['write:start', 'write:done', 'close', 'rust:hide']);
    expect(io.destroyed).toBe(false);
    expect(io.listeners.size).toBe(0);
  });
});

// The app's own sapphire accent lives in `app.css`; the shell sets `--color-accent` inline only for
// "Match system", and takes it off again otherwise.
// ⚠️ A source check, not a mount: there is no DOM environment in this repo's vitest setup (node),
// so `document.documentElement.style` cannot be observed. It catches the rule being lost.
describe('the shell sets --color-accent only for Match system', () => {
  const code = readFileSync(new URL('./use-shell.svelte.ts', import.meta.url), 'utf8').replace(
    /\/\/.*$/gm,
    '',
  );

  it('sets the accent and its text colour behind accentSource and onWindows', () => {
    expect(code).toMatch(/accentSource === 'system' && onWindows\(\)/);
    expect(code).toMatch(/setProperty\(\s*'--color-accent',\s*theme\.accent/);
    expect(code).toMatch(/setProperty\(\s*'--color-accent-text',\s*textOnAccent/);
  });

  it('removes both again otherwise, so app.css sapphire applies', () => {
    expect(code).toMatch(/removeProperty\(\s*'--color-accent'/);
    expect(code).toMatch(/removeProperty\(\s*'--color-accent-text'/);
  });

  it('sets --color-accent nowhere else', () => {
    expect(code.match(/setProperty\(\s*['"]--color-accent['"]/g)).toHaveLength(1);
  });
});

// The shell's `onkeydown` is `shortcutFor(e, document.activeElement)` then `hit.run()`. Run here
// the same two calls with the real table, the real Settings state and the real tab's `back`
// (spied, not replaced), so the only thing faked is the focus. Host is a PC (no injected platform).
describe('flipping Coming from changes what Ctrl+[ does', () => {
  const ctrlBracket = { key: '[', ctrlKey: true, altKey: false, shiftKey: false };
  const press = () => void shortcutFor(ctrlBracket, null)?.run();

  it('goes Back under Mac style and does nothing under Windows style, with no restart', () => {
    const back = vi.spyOn(tabs.active, 'back').mockImplementation(() => {});
    comingFrom.choice = 'windows';
    press();
    expect(back).not.toHaveBeenCalled();
    comingFrom.choice = 'mac';
    press();
    expect(back).toHaveBeenCalledTimes(1);
    comingFrom.choice = 'windows';
    press();
    expect(back).toHaveBeenCalledTimes(1);
    comingFrom.choice = 'native';
    back.mockRestore();
  });
});

// A restored maximize waits for the window to show. The reveal shows it through Rust, which
// maximizes right after the show: a `--hidden` start has no backstop, and if this show brought
// no focus the window used to maximize later, on the user's first click.
describe('the reveal', () => {
  const launch = { path: null, select: null, hidden: false };

  beforeEach(() => vi.mocked(invoke).mockClear());

  it('shows the window through the Rust command that also lands the maximize', () => {
    reveal(launch);
    expect(invoke).toHaveBeenCalledWith('show_window');
  });

  it('shows a `--hidden` start too when the app is not resident', () => {
    settings.keepRunning = false;
    settings.defaultHandler.applied = false;
    reveal({ ...launch, hidden: true });
    expect(invoke).toHaveBeenCalledWith('show_window');
  });

  it('leaves a `--hidden` start in the tray when the app is resident', () => {
    settings.keepRunning = true;
    try {
      reveal({ ...launch, hidden: true });
      expect(invoke).not.toHaveBeenCalledWith('show_window');
    } finally {
      settings.keepRunning = false;
    }
  });
});

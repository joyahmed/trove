import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one wrapper in this module with behaviour of its own, and the one that made the app
 * unclosable on 2026-09-26 (`c014476`, reverted by `f3cd087`).
 *
 * ⭐ WHY THIS HARNESS IS A FAKE RUST AND NOT A FAKE FUNCTION. `c014476` passed 11 assertions
 * and shipped a window that could not be closed, because every one of those assertions stopped
 * at "did the handler ask nicely". What decides the real outcome is three things the handler
 * does not own: `manager/window.rs:170` prevents the close whenever a JS listener EXISTS,
 * `@tauri-apps/api/window.js:1632-1641` then calls `destroy()` unless the handler prevented,
 * and `plugin:window|destroy` is DENIED by this app's ACL (`core:window:allow-destroy` is in
 * neither the `core:window` default set nor `capabilities/default.json`). So all three are
 * modelled below, `destroy` fails the way the ACL fails it, and the assertions are on whether
 * the window ENDED UP destroyed — not on which methods were called.
 */
const rt = vi.hoisted(() => {
  const state = {
    /** what happened, in order — the ordering is most of the assertion */
    log: [] as string[],
    /** live JS listeners on `tauri://close-requested`, as Rust's manager counts them */
    listeners: new Map<number, (e: { preventDefault: () => void }) => void | Promise<void>>(),
    nextId: 1,
    /** what `lib.rs`'s own `CloseRequested` arm does: `hide` when resident, else let it close */
    residency: 'close' as 'close' | 'hide',
    destroyed: false,
    visible: true,

    reset() {
      state.log.length = 0;
      state.listeners.clear();
      state.nextId = 1;
      state.residency = 'close';
      state.destroyed = false;
      state.visible = true;
    },

    /**
     * ⛔ The ACL denial, exactly as production hits it: `plugin:window|destroy` rejects, the
     * rejection dies unhandled inside Tauri's own async listener, and the window stays. A fix
     * that leans on `destroy()` therefore leaves `destroyed === false` here — which is what an
     * unclosable window looks like from the test's side.
     */
    async destroyDenied() {
      state.log.push('destroy:denied');
      throw new Error(
        'window.destroy not allowed. Permissions associated with this command: window:allow-destroy',
      );
    },

    /** A close request arriving at Rust — from WM_CLOSE, Alt+F4, or our own `close()`. */
    async requestClose() {
      // manager/window.rs:170 — a JS listener means Rust prevents and the webview decides
      if (state.listeners.size === 0) {
        if (state.residency === 'hide') {
          state.visible = false;
          state.log.push('rust:hide');
        } else {
          state.destroyed = true;
          state.log.push('rust:destroyed');
        }
        return;
      }
      for (const handler of [...state.listeners.values()]) {
        // @tauri-apps/api/window.js:1632-1641
        let prevented = false;
        await handler({ preventDefault: () => (prevented = true) });
        if (!prevented) await state.destroyDenied().catch(() => {});
      }
    },
  };
  return state;
});

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'main',
    isVisible: vi.fn(async () => rt.visible),
    destroy: vi.fn(async () => rt.destroyDenied()),
    close: vi.fn(async () => {
      // the listener count at this instant is what Rust will read: 0 is the whole fix
      rt.log.push(`close(listeners=${rt.listeners.size})`);
      await rt.requestClose();
    }),
    onCloseRequested: vi.fn(
      async (h: (e: { preventDefault: () => void }) => void | Promise<void>) => {
        const id = rt.nextId++;
        rt.listeners.set(id, h);
        rt.log.push('listen');
        return async () => {
          rt.listeners.delete(id);
          rt.log.push('unlisten');
        };
      },
    ),
  }),
}));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => 'main-2') }));

import { onCloseRequested } from './window';

describe('onCloseRequested', () => {
  beforeEach(() => rt.reset());

  it('registers with the window and resolves to an unlisten function', async () => {
    const unlisten = await onCloseRequested(() => {});
    expect(rt.listeners.size).toBe(1);
    expect(typeof unlisten).toBe('function');
  });

  // The point of the hook: Tauri awaits the handler, so an `invoke` round trip still lands.
  it('awaits an async callback before anything closes', async () => {
    await onCloseRequested(async () => {
      await new Promise((r) => setTimeout(r, 5));
      rt.log.push('cb:done');
    });
    rt.log.length = 0;
    await rt.requestClose();
    expect(rt.log[0]).toBe('cb:done');
  });

  /**
   * ⭐ THE ASSERTION THAT WAS MISSING. `c014476` proved the write happened and stopped there;
   * the window it left behind could not be closed by WM_CLOSE, by the caption button, or at
   * all. This asserts the OUTCOME — the window is gone — and the order that gets it there.
   */
  it('actually closes the window: flush, detach, then hand the close back to Rust', async () => {
    await onCloseRequested(() => void rt.log.push('cb'));
    rt.log.length = 0;

    await rt.requestClose();

    expect(rt.destroyed).toBe(true);
    // detached BEFORE the re-close, or Rust's manager prevents it a second time and we hang
    expect(rt.log).toEqual(['cb', 'unlisten', 'close(listeners=0)', 'rust:destroyed']);
  });

  /**
   * The bug itself. Tauri's wrapper destroys unless the handler prevented, and this app is not
   * allowed to destroy — so the handler must ALWAYS prevent and close another way.
   */
  it('never reaches the destroy() this app has no permission for', async () => {
    await onCloseRequested(() => {});
    await rt.requestClose();
    expect(rt.log).not.toContain('destroy:denied');
    expect(rt.destroyed).toBe(true);
  });

  it('closes when the callback rejects', async () => {
    await onCloseRequested(() => Promise.reject(new Error('disk full')));
    await rt.requestClose();
    expect(rt.destroyed).toBe(true);
  });

  it('closes when the callback throws', async () => {
    await onCloseRequested(() => {
      throw new Error('boom');
    });
    await rt.requestClose();
    expect(rt.destroyed).toBe(true);
  });

  /**
   * ⭐ THE RACE THE ONE-SHOT DESIGN EXISTS FOR. `tauri-runtime-wry-2.11.x/src/lib.rs:2270` shows
   * `close()` only SENDING `WindowMessage::Close` and returning, so Rust reads `has_js_listener`
   * after the JS promise has already resolved. Any listener attached in that gap — a re-arm,
   * most obviously — makes the manager prevent the close we just asked for, and the window is
   * unclosable again. So: zero listeners from the detach onwards, for good.
   */
  it('leaves no listener attached from the detach onwards, so no close can be prevented', async () => {
    await onCloseRequested(() => {});
    rt.log.length = 0; // past the one registration this hook ever makes
    await rt.requestClose();

    expect(rt.log).toContain('close(listeners=0)');
    expect(rt.listeners.size).toBe(0);
    expect(rt.log.filter((l) => l === 'listen')).toHaveLength(0); // never re-armed
  });

  /**
   * Residency (`keepRunning`): with no JS listener in the way, `lib.rs`'s arm prevents the close
   * and hides the window. The frontend must not destroy what Rust just kept. It does not re-arm
   * either — later resident closes are native, and the `SAVE_DELAY_MS` timer that survives a
   * hide is what writes them (`settings.flush()`: "Residency masks it").
   */
  it('leaves a resident window alive, and stays detached afterwards', async () => {
    rt.residency = 'hide';
    let flushes = 0;
    await onCloseRequested(() => void flushes++);

    await rt.requestClose();
    expect(rt.destroyed).toBe(false);
    expect(rt.visible).toBe(false);
    expect(flushes).toBe(1);
    expect(rt.listeners.size).toBe(0);

    // back from the tray, closed again: native, and still nothing can prevent it
    rt.visible = true;
    rt.residency = 'close';
    await rt.requestClose();
    expect(flushes).toBe(1);
    expect(rt.destroyed).toBe(true);
  });

  it('unlistening detaches for good: no callback, and a fully native close', async () => {
    let flushes = 0;
    const unlisten = await onCloseRequested(() => void flushes++);
    await unlisten();
    expect(rt.listeners.size).toBe(0);

    await rt.requestClose();
    expect(flushes).toBe(0);
    expect(rt.destroyed).toBe(true);
  });

  // The shell's effect teardown runs it after the handler has already detached; a second detach
  // must not throw out of the teardown.
  it('unlistening after a close is harmless', async () => {
    const unlisten = await onCloseRequested(() => {});
    await rt.requestClose();
    await expect(Promise.resolve(unlisten())).resolves.toBeUndefined();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⛔ The one thing in this module with behaviour rather than a one-line `invoke`, and the one
 * that decides whether a failed open is SEEN. Everything else here is a wrapper a test can only
 * restate; this one has a branch, and the branch is the failure nobody would otherwise notice.
 *
 * The fake is the two realms, not two functions: the palette window can only `emit`, the
 * explorer window is the only place a toast exists, and `hide_palette` must happen either way
 * or the palette sits on top of the toast it just raised.
 */
const rt = vi.hoisted(() => {
  const state = {
    log: [] as string[],
    emitted: [] as { event: string; payload: unknown }[],
    /** how `open_url` behaves on this fake machine — `Err` when no `https` association exists */
    openFails: null as string | null,
    reset() {
      state.log.length = 0;
      state.emitted.length = 0;
      state.openFails = null;
    },
  };
  return state;
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    rt.log.push(cmd);
    if (cmd === 'open_url' && rt.openFails) throw new Error(rt.openFails);
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async (event: string, payload: unknown) => {
    rt.log.push(`emit:${event}`);
    rt.emitted.push({ event, payload });
  }),
  listen: vi.fn(async () => () => {}),
}));

import { openUrlFromPalette } from './palette';

describe('openUrlFromPalette', () => {
  beforeEach(() => rt.reset());

  it('opens the URL and then hides — act-then-hide, nothing else disturbed', async () => {
    await openUrlFromPalette('https://example.com');
    expect(rt.log).toEqual(['open_url', 'hide_palette']);
    expect(rt.emitted).toEqual([]);
  });

  it('does not drag the explorer forward on the success path', async () => {
    await openUrlFromPalette('https://example.com');
    expect(rt.log).not.toContain('show_main');
  });

  /**
   * ⭐ THE ASSERTION THIS FILE EXISTS FOR. With no default browser association the invoke
   * rejects; swallowing it means Enter does nothing, forever, with no message anywhere.
   */
  it('surfaces a failed open instead of swallowing it', async () => {
    rt.openFails = 'No application is associated with https';
    await openUrlFromPalette('https://example.com');

    expect(rt.emitted).toHaveLength(1);
    expect(rt.emitted[0].event).toBe('spotlight:open-failed');
    expect(String((rt.emitted[0].payload as { message: string }).message)).toContain(
      'No application is associated with https',
    );
  });

  // A toast behind a hidden or tray-resident explorer is a toast nobody sees.
  it('brings the explorer up before raising the toast, and hides the palette last', async () => {
    rt.openFails = 'boom';
    await openUrlFromPalette('https://example.com');
    expect(rt.log).toEqual(['open_url', 'show_main', 'emit:spotlight:open-failed', 'hide_palette']);
  });

  it('never leaves the palette on screen when the open failed', async () => {
    rt.openFails = 'boom';
    await openUrlFromPalette('https://example.com');
    expect(rt.log).toContain('hide_palette');
  });

  it('does not reject at its own caller — the failure is reported, not rethrown', async () => {
    rt.openFails = 'boom';
    await expect(openUrlFromPalette('https://example.com')).resolves.toBeUndefined();
  });
});

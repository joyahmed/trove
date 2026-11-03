import { describe, expect, it, vi } from 'vitest';

const notify = vi.fn();
vi.mock('$lib/api/palette', () => ({
  registerHotkey: vi.fn(() => Promise.reject('Alt+Space could not be registered')),
  onHotkeyFailed: vi.fn(),
  onSpotlightAction: vi.fn(),
  onSpotlightNavigate: vi.fn(),
  onSpotlightOpenFailed: vi.fn(),
  onSpotlightReveal: vi.fn(),
  onSpotlightSearch: vi.fn(),
}));
vi.mock('$lib/state/actions.svelte', () => ({ actions: { notify } }));
vi.mock('$lib/data/palette-action-runners', () => ({ paletteActionRunners: {} }));
vi.mock('$lib/state/search.svelte', () => ({ search: {} }));
vi.mock('$lib/state/selection.svelte', () => ({ selection: {} }));
vi.mock('$lib/state/tabs.svelte', () => ({ tabs: {} }));

describe('spotlight bridge', () => {
  it('a refused chord is not toasted from the rejected call (the event toasts it once)', async () => {
    const { spotlight } = await import('./spotlight-bridge.svelte');
    spotlight.register('alt+space');
    await new Promise((r) => setTimeout(r, 0));
    expect(spotlight.hotkeyError).toContain('could not be registered');
    expect(notify).not.toHaveBeenCalled();
  });

  // D.5.2: GNOME holds Alt+Space. The chord registers, so it must stay savable (`true`), and the
  // note must not be filed as an error whichever of the event and the reply arrives first.
  it('a chord GNOME also binds is a saved conflict note, not an error', async () => {
    const api = await import('$lib/api/palette');
    const { spotlight } = await import('./spotlight-bridge.svelte');
    const note = 'Alt+Space is also GNOME\'s "activate-window-menu" shortcut';
    spotlight.attach();
    const onFailed = vi.mocked(api.onHotkeyFailed).mock.calls.at(-1)![0];

    vi.mocked(api.registerHotkey).mockImplementationOnce(() => {
      onFailed(note); // the event lands before the reply
      return Promise.resolve(note);
    });
    await expect(spotlight.register('alt+space')).resolves.toBe(true);
    expect(spotlight.hotkeyConflict).toBe(note);
    expect(spotlight.hotkeyError).toBeNull();
    expect(notify).toHaveBeenCalledWith(note, 'warning');

    // The reply lands first, then the event: still not an error.
    vi.mocked(api.registerHotkey).mockImplementationOnce(() => Promise.resolve(note));
    await spotlight.register('alt+space');
    onFailed(note);
    expect(spotlight.hotkeyError).toBeNull();
    expect(spotlight.hotkeyConflict).toBe(note);

    // A free chord (or the GNOME key cleared) drops the note.
    vi.mocked(api.registerHotkey).mockImplementationOnce(() => Promise.resolve(null));
    await expect(spotlight.register('ctrl+shift+space')).resolves.toBe(true);
    expect(spotlight.hotkeyConflict).toBeNull();
  });
});

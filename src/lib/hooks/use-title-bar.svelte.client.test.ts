// The title bar hook on Svelte's client runtime: the maximize flag and its stale-read guard,
// the OS title following the tab, the caption buttons, double-click and the window menu.
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { w, tabsMock, menuMock } = vi.hoisted(() => ({
  w: {
    isMaximized: vi.fn<() => Promise<boolean>>(async () => false),
    onResized: vi.fn<(cb: () => unknown) => Promise<() => void>>(),
    setTitle: vi.fn<(t: string) => Promise<void>>(async () => {}),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  },
  tabsMock: { active: { location: { kind: 'path', path: '/home/alex/Downloads' } as unknown } },
  menuMock: { openAt: vi.fn() },
}));
vi.mock('$lib/api/window', () => w);
vi.mock('$lib/state/tabs.svelte', async () => {
  const state = $state({ active: tabsMock.active });
  tabsMock.active = state.active;
  return { tabs: state };
});
vi.mock('$lib/hooks/use-menu.svelte', () => ({ useMenu: () => menuMock }));
vi.mock('$lib/data/window-menu', () => ({
  windowMenuApi: { api: true },
  windowMenuFor: vi.fn((maximized: boolean) => [{ key: maximized ? 'restore' : 'maximize' }]),
}));

const { useTitleBar } = await import('./use-title-bar.svelte');
const { windowMenuFor, windowMenuApi } = await import('$lib/data/window-menu');
const { tabs } = await import('$lib/state/tabs.svelte');

let resized: () => unknown;
const unlisten = vi.fn();

const mount = async () => {
  let bar!: ReturnType<typeof useTitleBar>;
  const stop = $effect.root(() => {
    bar = useTitleBar();
  });
  flushSync();
  await vi.waitFor(() => expect(w.isMaximized).toHaveBeenCalled());
  await Promise.resolve();
  flushSync();
  return { bar, stop };
};

const drag = {
  tagName: 'DIV',
  getAttribute: (n: string) => (n === 'data-tauri-drag-region' ? 'deep' : null),
};
const button = { tagName: 'BUTTON', getAttribute: () => null };
const evt = (path: unknown[], extra = {}) =>
  ({
    composedPath: () => path,
    preventDefault: vi.fn(),
    clientX: 7,
    clientY: 9,
    ...extra,
  }) as unknown as MouseEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
  };

beforeEach(() => {
  vi.clearAllMocks();
  w.isMaximized.mockImplementation(async () => false);
  w.onResized.mockImplementation(async (cb) => {
    resized = cb;
    return unlisten;
  });
  (tabs as { active: { location: unknown } }).active.location = {
    kind: 'path',
    path: '/home/alex/Downloads',
  };
});
afterEach(() => vi.unstubAllGlobals());

const hostOs = (os: string) =>
  vi.stubGlobal('window', { __TROVE_PLATFORM__: { os, thisPcLabel: 'This PC' } });

describe('useTitleBar maximize state', () => {
  it('reads the window state on mount and shows Maximize when restored', async () => {
    const { bar, stop } = await mount();
    expect(bar.maximized).toBe(false);
    expect(bar.buttons.map((b) => b.key)).toEqual(['minimize', 'maximize', 'close']);
    expect(bar.buttons[1]).toMatchObject({ label: 'Maximize', glyph: 'maximize' });
    stop();
  });

  it('shows Restore on a maximized window and wires the buttons to the window', async () => {
    w.isMaximized.mockImplementation(async () => true);
    const { bar, stop } = await mount();
    expect(bar.maximized).toBe(true);
    expect(bar.buttons[1]).toMatchObject({ label: 'Restore', glyph: 'restore' });
    expect(bar.buttons[0].run).toBe(w.minimize);
    expect(bar.buttons[1].run).toBe(w.toggleMaximize);
    expect(bar.buttons[2]).toMatchObject({ label: 'Close', glyph: 'close', run: w.close });
    stop();
  });

  it('re-reads on every resize', async () => {
    const { bar, stop } = await mount();
    w.isMaximized.mockImplementation(async () => true);
    await resized();
    flushSync();
    expect(bar.maximized).toBe(true);
    stop();
  });

  it('keeps the newest answer when an older read lands last', async () => {
    const { bar, stop } = await mount();
    let slow!: (v: boolean) => void;
    w.isMaximized.mockImplementationOnce(() => new Promise<boolean>((r) => (slow = r)));
    const first = resized(); // slow read, started first
    w.isMaximized.mockImplementationOnce(async () => true);
    await resized(); // newer read answers true
    slow(false); // the stale one lands last
    await first;
    flushSync();
    expect(bar.maximized).toBe(true);
    stop();
  });

  it('stops listening on teardown', async () => {
    const { stop } = await mount();
    stop();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });
});

describe('useTitleBar OS title', () => {
  it('follows the active tab', async () => {
    const { stop } = await mount();
    expect(w.setTitle).toHaveBeenLastCalledWith('Downloads - Trove');
    (tabs as { active: { location: unknown } }).active.location = { kind: 'home' };
    flushSync();
    expect(w.setTitle).toHaveBeenLastCalledWith('Home - Trove');
    stop();
  });

  it('is just "Trove" when the tab has no label', async () => {
    (tabs as { active: { location: unknown } }).active.location = { kind: 'path', path: '' };
    const { stop } = await mount();
    expect(w.setTitle).toHaveBeenLastCalledWith('Trove');
    stop();
  });
});

describe('useTitleBar double-click', () => {
  // ⛔ 2026-10-23: Tauri's script toggled on the 2nd mousedown and this toggled again, so
  // restore by double-click failed 4 of 4
  it('on Windows, leaves a drag region to Tauri and zooms on a gap', async () => {
    hostOs('windows');
    const { bar, stop } = await mount();
    bar.ondblclick(evt([drag]));
    expect(w.toggleMaximize).not.toHaveBeenCalled();
    bar.ondblclick(evt([button]));
    expect(w.toggleMaximize).toHaveBeenCalledOnce();
    stop();
  });

  it('on a Mac, leaves a drag region to Tauri and zooms on a gap', async () => {
    hostOs('macos');
    const { bar, stop } = await mount();
    bar.ondblclick(evt([drag]));
    expect(w.toggleMaximize).not.toHaveBeenCalled();
    bar.ondblclick(evt([button]));
    expect(w.toggleMaximize).toHaveBeenCalledOnce();
    stop();
  });
});

describe('useTitleBar window menu', () => {
  it('opens at the pointer on a drag region and stops the native menu', async () => {
    const { bar, stop } = await mount();
    const e = evt([drag]);
    bar.oncontextmenu(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(menuMock.openAt).toHaveBeenCalledWith(7, 9);
    stop();
  });

  it('ignores a right-click that is not on a drag region (a tab has its own menu)', async () => {
    const { bar, stop } = await mount();
    const e = evt([button, drag]);
    bar.oncontextmenu(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(menuMock.openAt).not.toHaveBeenCalled();
    stop();
  });

  it('builds its items from the maximized state and the real window api', async () => {
    w.isMaximized.mockImplementation(async () => true);
    const { bar, stop } = await mount();
    expect(bar.items).toEqual([{ key: 'restore' }]);
    expect(windowMenuFor).toHaveBeenLastCalledWith(true, windowMenuApi);
    expect(bar.menu).toBe(menuMock);
    stop();
  });
});

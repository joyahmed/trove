import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import type { WindowMenuHandlers } from './window-menu';

vi.mock('$lib/api/window', () => ({
  arrangeWindows: vi.fn(async () => {}),
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  snapWindow: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));

const win = await import('$lib/api/window');
const { notices } = await import('$lib/state/notices.svelte');
const { ARRANGE_ROWS, arrangeWindows, windowMenuApi, windowMenuFor } =
  await import('./window-menu');

const OS = ['windows', 'mac', 'linux'] as const;

const handlers = (): WindowMenuHandlers => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  snap: vi.fn(),
  arrange: vi.fn(),
  close: vi.fn(),
});

const leaves = (items: MenuItem[]) =>
  items.filter((i): i is Extract<MenuItem, { kind: 'item' }> => i.kind === 'item');

describe('the window menu (plan 20.3.2)', () => {
  it('has the three arrange rows on every host and style', () => {
    for (const host of OS)
      for (const style of OS) {
        const keys = leaves(windowMenuFor(false, handlers(), style, host)).map((i) => i.key);
        expect(keys, `${host}/${style}`).toEqual(
          expect.arrayContaining(['cascade-windows', 'stack-windows', 'windows-side-by-side']),
        );
        expect(keys[0]).toBe('minimize');
        expect(keys.at(-1)).toBe('close');
      }
  });

  it('shows Snap left / right only where the keys are bound, with their hints', () => {
    for (const host of OS)
      for (const style of OS) {
        const rows = leaves(windowMenuFor(false, handlers(), style, host));
        const snaps = rows.filter((i) => i.key.startsWith('snap-'));
        if (host === 'mac' && style === 'windows')
          expect(snaps.map((i) => [i.key, i.shortcut])).toEqual([
            ['snap-left', '⌃⌥←'],
            ['snap-right', '⌃⌥→'],
          ]);
        else expect(snaps, `${host}/${style}`).toEqual([]);
      }
  });

  it('names Restore on a maximized window, Maximize otherwise', () => {
    const label = (max: boolean) =>
      leaves(windowMenuFor(max, handlers(), 'windows', 'windows')).find((i) => i.key === 'maximize')
        ?.label;
    expect(label(true)).toBe('Restore');
    expect(label(false)).toBe('Maximize');
  });

  it('every row calls its action', () => {
    const on = handlers();
    const rows = leaves(windowMenuFor(false, on, 'windows', 'mac'));
    const run = (key: string) => rows.find((i) => i.key === key)?.run();
    run('minimize');
    expect(on.minimize).toHaveBeenCalledOnce();
    run('maximize');
    expect(on.toggleMaximize).toHaveBeenCalledOnce();
    run('snap-left');
    run('snap-right');
    expect(vi.mocked(on.snap).mock.calls).toEqual([['left'], ['right']]);
    for (const row of ARRANGE_ROWS) run(row.key);
    expect(vi.mocked(on.arrange).mock.calls).toEqual([['cascade'], ['stacked'], ['side-by-side']]);
    run('close');
    expect(on.close).toHaveBeenCalledOnce();
  });
});

describe('windowMenuApi (plan 20.3.2)', () => {
  it('arranges through the window api', async () => {
    await windowMenuApi.arrange('stacked');
    expect(win.arrangeWindows).toHaveBeenCalledWith('stacked');
    await windowMenuApi.snap('left');
    expect(win.snapWindow).toHaveBeenCalledWith('left');
  });

  it('a failed arrange shows a notice', async () => {
    vi.mocked(win.arrangeWindows).mockRejectedValueOnce('only one window');
    const before = notices.list.length;
    await arrangeWindows('cascade');
    expect(notices.list.length).toBe(before + 1);
    expect(notices.list.at(-1)).toMatchObject({ kind: 'warning', message: 'only one window' });
  });
});

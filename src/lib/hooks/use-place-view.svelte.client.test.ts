// G.74: the Home / This PC tiles are one roving Tab stop, and the arrow keys move focus between
// them. No DOM here: the group and the tiles are stand-ins that answer the three calls the hook
// makes (querySelectorAll, getBoundingClientRect, focus).
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));

import { places } from '$lib/state/places.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { THIS_PC } from '$lib/utils/location';
import { TILE_ATTR, usePlaceView } from './use-place-view.svelte';

const drive = (path: string) => ({
  path,
  label: path,
  totalBytes: null,
  freeBytes: null,
  network: false,
});

/** A tile stand-in at `left`; all in one row, 264 wide. */
const tile = (key: string, left: number) => ({
  key,
  focus: vi.fn(),
  getAttribute: (name: string) => (name === TILE_ATTR ? key : null),
  getBoundingClientRect: () => ({ left, top: 0, width: 264, height: 64 }),
});

const keyOn = (
  group: { querySelectorAll: () => unknown[] },
  target: unknown,
  key: string,
  mods: Partial<KeyboardEvent> = {},
) => {
  const e = {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
    target,
    currentTarget: group,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  return e as unknown as KeyboardEvent & { defaultPrevented: boolean };
};

afterEach(() => {
  places.drives = [];
});

describe('usePlaceView tiles', () => {
  const setUp = () => {
    tabs.active.location = THIS_PC;
    places.drives = [drive('C:\\'), drive('D:\\'), drive('E:\\')] as typeof places.drives;
    let view!: ReturnType<typeof usePlaceView>;
    const stop = $effect.root(() => {
      view = usePlaceView();
    });
    flushSync();
    const tiles = [tile('C:\\', 0), tile('D:\\', 268), tile('E:\\', 536)];
    const group = { querySelectorAll: () => tiles };
    return { view, stop, tiles, group };
  };

  it('gives exactly one tile the Tab stop, the first until another is focused', () => {
    const { view, stop, tiles } = setUp();
    expect(['C:\\', 'D:\\', 'E:\\'].map(view.tabindexFor)).toEqual([0, -1, -1]);
    view.onfocusin({ target: tiles[2] } as unknown as FocusEvent);
    flushSync();
    expect(['C:\\', 'D:\\', 'E:\\'].map(view.tabindexFor)).toEqual([-1, -1, 0]);
    stop();
  });

  it('→ and End move focus to the next and the last tile, and claim the key', () => {
    const { view, stop, tiles, group } = setUp();
    const right = keyOn(group, tiles[0], 'ArrowRight');
    view.onkeydown(right);
    expect(tiles[1].focus).toHaveBeenCalledOnce();
    expect(right.defaultPrevented).toBe(true);
    view.onkeydown(keyOn(group, tiles[0], 'End'));
    expect(tiles[2].focus).toHaveBeenCalledOnce();
    stop();
  });

  it('leaves Alt+← (Back) and keys from outside a tile alone', () => {
    const { view, stop, tiles, group } = setUp();
    const back = keyOn(group, tiles[1], 'ArrowLeft', { altKey: true });
    view.onkeydown(back);
    expect(back.defaultPrevented).toBe(false);
    const stray = keyOn(group, {}, 'ArrowRight');
    view.onkeydown(stray);
    expect(stray.defaultPrevented).toBe(false);
    expect(tiles.some((t) => t.focus.mock.calls.length > 0)).toBe(false);
    stop();
  });
});

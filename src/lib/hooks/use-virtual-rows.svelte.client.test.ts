// useVirtualRows on Svelte's CLIENT runtime. TanStack's Virtualizer is swapped for a recorder, so
// these tests are about the hook's own wiring: how many chunks it asks for at a given size, which
// items each chunk carries, what it does when the view changes, and where scrollToItem sends it.
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '$lib/state/settings.svelte';
import { useVirtualRows } from './use-virtual-rows.svelte';

const fake = vi.hoisted(() => {
  type Opts = {
    count: number;
    horizontal: boolean;
    estimateSize: (i: number) => number;
    paddingStart: number;
    overscan: number;
    onChange: () => void;
  };
  const state = {
    last: null as Opts | null,
    visible: [] as { index: number; start: number }[],
    measure: vi.fn(),
    scrollToIndex: vi.fn(),
    didMount: vi.fn(),
    unmount: vi.fn(),
    totalSize: 0,
  };
  class Virtualizer {
    constructor(o: Opts) {
      state.last = o;
    }
    setOptions(o: Opts) {
      state.last = o;
    }
    measure = state.measure;
    scrollToIndex = state.scrollToIndex;
    _willUpdate() {}
    _didMount() {
      state.didMount();
      return state.unmount;
    }
    getVirtualItems() {
      return state.visible;
    }
    getTotalSize() {
      return state.totalSize;
    }
  }
  return { state, Virtualizer };
});

vi.mock('@tanstack/svelte-virtual', () => ({
  Virtualizer: fake.Virtualizer,
  elementScroll: vi.fn(),
  observeElementOffset: vi.fn(),
  observeElementRect: vi.fn(),
}));

let resize: (w: number, h: number) => void;
let observed: unknown;
const disconnect = vi.fn();

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: (e: { contentRect: { width: number; height: number } }[]) => void) {
        resize = (width, height) => cb([{ contentRect: { width, height } }]);
      }
      observe(el: unknown) {
        observed = el;
      }
      disconnect = disconnect;
    },
  );
  Object.assign(fake.state, { last: null, visible: [], totalSize: 0 });
  settings.view = 'details';
  settings.iconSize = 48;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const items = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);
const node = { addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;

const mount = (list: () => string[], options?: Parameters<typeof useVirtualRows<string>>[1]) => {
  let rows!: ReturnType<typeof useVirtualRows<string>>;
  const stop = $effect.root(() => {
    rows = useVirtualRows(list, options);
  });
  flushSync();
  return { rows, stop };
};

/** attach the scroll container and report its size, as the browser would */
const open = (rows: ReturnType<typeof useVirtualRows<string>>, w: number, h: number) => {
  rows.attach(node);
  flushSync();
  resize(w, h);
  flushSync();
};

describe('chunk count', () => {
  it('is one chunk per item in details', () => {
    const { rows, stop } = mount(() => items(10));
    expect(rows.perChunk).toBe(1);
    expect(fake.state.last?.count).toBe(10);
    stop();
  });

  it('packs tiles across the width in grid, rounding the last row up', () => {
    settings.view = 'grid'; // Medium: 120 + 4 wide
    const { rows, stop } = mount(() => items(25));
    open(rows, 1000, 600); // floor(1000 / 124) = 8 across
    expect(rows.perChunk).toBe(8);
    expect(fake.state.last?.count).toBe(4); // ceil(25 / 8)
    stop();
  });

  it('never packs fewer than one tile, even in a very narrow pane', () => {
    settings.view = 'grid';
    const { rows, stop } = mount(() => items(3));
    open(rows, 10, 600);
    expect(rows.perChunk).toBe(1);
    expect(fake.state.last?.count).toBe(3);
    stop();
  });

  it('is zero for an empty folder', () => {
    const { rows, stop } = mount(() => []);
    expect(fake.state.last?.count).toBe(0);
    expect(rows.chunks).toEqual([]);
    stop();
  });
});

describe('chunks handed to the markup', () => {
  it('cuts the items to each visible chunk, clipping the last one', () => {
    settings.view = 'grid';
    const list = items(10);
    const { rows, stop } = mount(() => list);
    open(rows, 372, 600); // 3 across
    fake.state.visible = [
      { index: 0, start: 8 },
      { index: 3, start: 520 },
    ];
    fake.state.last!.onChange();
    flushSync();
    expect(rows.chunks).toEqual([
      { index: 0, start: 8, first: 0, items: ['f0', 'f1', 'f2'], header: false },
      { index: 3, start: 520, first: 9, items: ['f9'], header: false },
    ]);
    stop();
  });

  it('reports the virtualizer total size, and the view padding as its start', () => {
    const { rows, stop } = mount(() => items(100));
    fake.state.totalSize = 2808;
    fake.state.last!.onChange();
    flushSync();
    expect(rows.totalSize).toBe(2808);
    expect(fake.state.last?.paddingStart).toBe(rows.layout.paddingStart);
    stop();
  });
});

describe('grouped lists', () => {
  const list = ['H1', 'a', 'b', 'c', 'H2', 'd'];
  const grouped = { grouped: () => true, isHeader: (s: string) => s.startsWith('H') };

  it('plans a chunk per heading and per row of items, and sizes each from the plan', () => {
    settings.view = 'grid';
    const { rows, stop } = mount(() => list, grouped);
    open(rows, 248, 600); // 2 across
    expect(rows.plan?.map((c) => [c.first, c.count, c.header])).toEqual([
      [0, 1, true],
      [1, 2, false],
      [3, 1, false],
      [4, 1, true],
      [5, 1, false],
    ]);
    expect(fake.state.last?.count).toBe(5);
    expect(fake.state.last?.estimateSize(0)).toBe(rows.layout.headerSize);
    expect(fake.state.last?.estimateSize(1)).toBe(rows.layout.chunkSize);
    stop();
  });

  it('carries the heading flag and item slice for each planned chunk', () => {
    settings.view = 'grid';
    const { rows, stop } = mount(() => list, grouped);
    open(rows, 248, 600);
    fake.state.visible = [
      { index: 0, start: 8 },
      { index: 1, start: 42 },
      { index: 99, start: 9999 }, // past the plan: dropped, not a crash
    ];
    fake.state.last!.onChange();
    flushSync();
    expect(rows.chunks.map((c) => [c.index, c.first, c.items, c.header])).toEqual([
      [0, 0, ['H1'], true],
      [1, 1, ['a', 'b'], false],
    ]);
    stop();
  });

  it('has no plan when grouping is off, or when there is no way to tell a heading', () => {
    const off = mount(() => list, { grouped: () => false, isHeader: () => true });
    expect(off.rows.plan).toBeNull();
    off.stop();
    const blind = mount(() => list, { grouped: () => true });
    expect(blind.rows.plan).toBeNull();
    blind.stop();
  });
});

describe('scrollToItem', () => {
  it('scrolls to the chunk holding the item, nearest edge', () => {
    settings.view = 'grid';
    const { rows, stop } = mount(() => items(30));
    open(rows, 372, 600); // 3 across
    rows.scrollToItem(7);
    expect(fake.state.scrollToIndex).toHaveBeenCalledWith(2, { align: 'auto' });
    rows.scrollToItem(0);
    expect(fake.state.scrollToIndex).toHaveBeenLastCalledWith(0, { align: 'auto' });
    stop();
  });

  it('scrolls to the item itself in details', () => {
    const { rows, stop } = mount(() => items(50));
    rows.scrollToItem(42);
    expect(fake.state.scrollToIndex).toHaveBeenCalledWith(42, { align: 'auto' });
    stop();
  });

  it('finds the chunk through the plan when grouped', () => {
    settings.view = 'grid';
    const list = ['H1', 'a', 'b', 'c', 'H2', 'd'];
    const { rows, stop } = mount(() => list, {
      grouped: () => true,
      isHeader: (s) => s.startsWith('H'),
    });
    open(rows, 248, 600); // 2 across
    rows.scrollToItem(3); // "c" is alone in chunk 2
    expect(fake.state.scrollToIndex).toHaveBeenCalledWith(2, { align: 'auto' });
    rows.scrollToItem(5); // "d" under the second heading
    expect(fake.state.scrollToIndex).toHaveBeenLastCalledWith(4, { align: 'auto' });
    stop();
  });

  it('does nothing for an item past the end of a grouped list', () => {
    settings.view = 'grid';
    const { rows, stop } = mount(() => ['H1', 'a'], {
      grouped: () => true,
      isHeader: (s) => s.startsWith('H'),
    });
    rows.scrollToItem(40);
    expect(fake.state.scrollToIndex).not.toHaveBeenCalled();
    stop();
  });
});

describe('layout switch', () => {
  it('drops the virtualizer size cache and re-reads the axis when the view changes', () => {
    const { rows, stop } = mount(() => items(50));
    expect(rows.layout.horizontal).toBe(false);
    fake.state.measure.mockClear();

    settings.view = 'list';
    flushSync();
    expect(rows.layout.horizontal).toBe(true);
    expect(fake.state.last?.horizontal).toBe(true);
    expect(fake.state.last?.estimateSize(0)).toBe(232);
    expect(fake.state.measure).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not re-measure when only the item count changes', () => {
    let list = $state(items(50));
    const { stop } = mount(() => list);
    fake.state.measure.mockClear();
    list = items(60);
    flushSync();
    expect(fake.state.last?.count).toBe(60);
    expect(fake.state.measure).not.toHaveBeenCalled();
    stop();
  });

  it('re-measures when the grouping plan changes', () => {
    settings.view = 'grid';
    let list = $state(['H1', 'a']);
    const { stop } = mount(() => list, { grouped: () => true, isHeader: (s) => s.startsWith('H') });
    fake.state.measure.mockClear();
    list = ['H1', 'a', 'H2', 'b'];
    flushSync();
    expect(fake.state.measure).toHaveBeenCalledTimes(1);
    stop();
  });

  it('counts items per chunk from the cross axis: height in the sideways List', () => {
    settings.view = 'list';
    const { rows, stop } = mount(() => items(100));
    open(rows, 900, 220); // 22 px items: 10 per column
    expect(rows.perChunk).toBe(10);
    expect(fake.state.last?.count).toBe(10);
    stop();
  });

  it('PageUp / PageDown step is one viewport of items, at least one chunk', () => {
    settings.view = 'grid';
    const { rows, stop } = mount(() => items(100));
    expect(rows.viewportItems).toBe(1); // not measured yet: one chunk
    open(rows, 372, 880); // 3 across, floor(880 / 132) = 6 rows
    expect(rows.viewportItems).toBe(18);
    stop();
  });
});

describe('mounting', () => {
  it('starts the virtualizer observers once there is a scroll container, and undoes them on teardown', () => {
    const { rows, stop } = mount(() => items(5));
    expect(fake.state.didMount).not.toHaveBeenCalled();
    rows.attach(node);
    flushSync();
    expect(fake.state.didMount).toHaveBeenCalledTimes(1);
    expect(observed).toEqual(node); // $state hands back a proxy of it
    expect(rows.element).toEqual(node);
    stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(fake.state.unmount).toHaveBeenCalledTimes(1);
  });

  it('forgets the container when the action is destroyed', () => {
    const { rows, stop } = mount(() => items(5));
    const action = rows.attach(node);
    flushSync();
    action.destroy();
    flushSync();
    expect(rows.element).toBeNull();
    expect(disconnect).toHaveBeenCalledTimes(1);
    stop();
  });
});

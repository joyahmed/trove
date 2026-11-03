// A.2.4: dragging a tab to a new place. The browser fires a `click` after the release, on the
// tab element the pointer was captured by; the strip is keyed by index, so that element now
// shows the tab that slid into the dragged tab's old place. That click must not activate it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabState } from '$lib/state/tab.svelte';

vi.mock('$lib/api/window', () => ({ close: vi.fn(), openWindow: vi.fn(async () => undefined) }));

const { useTabStrip } = await import('./use-tab-strip.svelte');
const { tabs } = await import('$lib/state/tabs.svelte');

/** The tab strip's box: y 0..32, so a release at y 10 is a reorder, not a detach. */
const strip = { getBoundingClientRect: () => ({ top: 0, bottom: 32 }) };
const tabEl = { setPointerCapture: vi.fn(), closest: () => strip };
/** the tab under the pointer, as `document.elementFromPoint` finds it */
let under = 0;

const ptr = (x: number, extra: Partial<PointerEvent> = {}) =>
  ({
    button: 0,
    clientX: x,
    clientY: 10,
    pointerId: 1,
    currentTarget: tabEl,
    ...extra,
  }) as unknown as PointerEvent;

let five: TabState[];

beforeEach(() => {
  vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 800 });
  vi.stubGlobal('document', {
    elementFromPoint: () => ({ closest: () => ({ dataset: { tab: String(under) } }) }),
  });
  tabs.list = [tabs.list[0]];
  tabs.activeIndex = 0;
  for (let i = 0; i < 4; i++) tabs.open('');
  five = [...tabs.list];
});
afterEach(() => vi.unstubAllGlobals());

/** What TabStrip.svelte runs: press on `from`, move past the threshold onto `to`, release, click. */
const drag = (from: number, to: number) => {
  const s = useTabStrip();
  s.onpointerdown(from, ptr(from * 100));
  under = to;
  s.onpointermove(from, ptr(from * 100 + 20));
  s.onpointermove(from, ptr(to * 100));
  s.onpointerup(ptr(to * 100));
  // the click lands on the element pressed, which still renders index `from`
  s.activate(from);
  return s;
};

describe('dragging a tab to reorder', () => {
  it('moves it and leaves the dragged tab active, not the one now at its old place', () => {
    tabs.activate(0);
    drag(2, 4);
    expect(tabs.list).toEqual([five[0], five[1], five[3], five[4], five[2]]);
    expect(tabs.active).toBe(five[2]);
  });

  it('dragging leftwards too', () => {
    tabs.activate(3);
    drag(4, 0);
    expect(tabs.list).toEqual([five[4], five[0], five[1], five[2], five[3]]);
    expect(tabs.active).toBe(five[4]);
  });

  it('a drag dropped back on its own place still activates the tab dragged', () => {
    tabs.activate(0);
    drag(3, 3);
    expect(tabs.list).toEqual(five);
    expect(tabs.active).toBe(five[3]);
  });

  it('a plain click after a drag still activates', () => {
    tabs.activate(1);
    const s = drag(1, 3);
    expect(tabs.active).toBe(five[1]);
    s.onpointerdown(0, ptr(0));
    s.onpointerup(ptr(0));
    s.activate(0);
    expect(tabs.active).toBe(five[0]);
  });

  it('a press and release without moving is a click: it activates the tab pressed', () => {
    tabs.activate(0);
    const s = useTabStrip();
    s.onpointerdown(3, ptr(300));
    s.onpointerup(ptr(300));
    s.activate(3);
    expect(tabs.active).toBe(five[3]);
  });

  /** the line the strip shows mid-drag: pressed on `from`, pointer over `to`, not yet released */
  const hover = (from: number, to: number) => {
    const s = useTabStrip();
    s.onpointerdown(from, ptr(from * 100));
    under = to;
    s.onpointermove(from, ptr(from * 100 + 20));
    s.onpointermove(from, ptr(to * 100));
    return s;
  };

  it('the drop line is on the far side of the target: after when dragging right', () => {
    const s = hover(2, 4);
    expect(s.slot).toBe(4);
    expect(s.slotSide).toBe('after');
  });

  it('the drop line is before the target when dragging left', () => {
    const s = hover(4, 0);
    expect(s.slot).toBe(0);
    expect(s.slotSide).toBe('before');
  });

  it('the tab lands on the side the line showed', () => {
    for (const [from, to] of [
      [2, 4],
      [4, 0],
      [0, 3],
      [3, 1],
    ]) {
      tabs.list = [...five];
      const s = hover(from, to);
      const target = five[to];
      const side = s.slotSide;
      s.onpointerup(ptr(to * 100));
      const at = tabs.list.indexOf(five[from]);
      const near = tabs.list.indexOf(target);
      expect(at - near).toBe(side === 'after' ? 1 : -1);
    }
  });
});

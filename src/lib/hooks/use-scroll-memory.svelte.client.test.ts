// @vitest-environment ./vitest.svelte-client-env.ts
// The Details column header follows the rows' horizontal scroll, also after the list is resized
// (the preview pane widened): the offset is clamped to the new max and pushed to the header.
import { flushSync, tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/state/tabs.svelte', () => ({
  tabs: {
    activeIndex: 0,
    list: [{ scrollRestore: 0, scrollOffset: 0 }],
    active: { scrollOffset: 0 },
  },
}));

const { scrollMemory } = await import('./use-scroll-memory.svelte');

let resize: () => void = () => {};
vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(cb: () => void) {
      resize = cb;
    }
    observe() {}
    disconnect() {}
  },
);

const mount = (scrollHeight = 300) => {
  const header = { scrollLeft: 0 };
  const el = {
    scrollTop: 0,
    scrollLeft: 0,
    scrollWidth: 1000,
    scrollHeight,
    clientHeight: 300,
    clientWidth: 400,
    firstElementChild: null,
    parentElement: { querySelector: () => header },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const stop = $effect.root(() => {
    scrollMemory(el as unknown as HTMLElement, undefined);
  });
  flushSync();
  return { el, header, stop };
};

describe('scroll memory, header follow', () => {
  it('clamps the rows to the new max and moves the header with them after a widen', () => {
    const { el, header, stop } = mount();
    el.scrollLeft = 500;
    header.scrollLeft = 500;
    el.scrollWidth = 700; // the pane widened: max is now 300
    resize();
    expect(el.scrollLeft).toBe(300);
    expect(header.scrollLeft).toBe(el.scrollLeft);
    stop();
  });

  it('keeps scrollLeft at 0 when the pane widens', () => {
    const { el, stop } = mount();
    el.scrollWidth = 1200;
    el.clientWidth = 600; // widened: max is now 600, the offset stays where it was
    resize();
    expect(el.scrollLeft).toBe(0);
    stop();
  });

  it('restores a vertical offset to scrollTop only, never into scrollLeft', async () => {
    const tab = { scrollRestore: 0, scrollOffset: 800 };
    const { tabs } = await import('$lib/state/tabs.svelte');
    (tabs as unknown as { list: unknown[] }).list = [tab];
    const { el, stop } = mount(2000);
    await tick();
    await Promise.resolve();
    expect(el.scrollTop).toBe(800);
    expect(el.scrollLeft).toBe(0);
    stop();
  });

  it('resets a sideways List offset and the header when the view switches to Details', async () => {
    const { tabs } = await import('$lib/state/tabs.svelte');
    const active = { scrollOffset: 600 };
    (tabs as unknown as { active: unknown }).active = active;
    const header = { scrollLeft: 600 };
    const el = {
      scrollTop: 0,
      scrollLeft: 600,
      scrollWidth: 1000,
      scrollHeight: 300,
      clientHeight: 300,
      clientWidth: 400,
      firstElementChild: null,
      parentElement: { querySelector: () => header },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    let action: { update?: (h: boolean) => void } | void;
    const stop = $effect.root(() => {
      action = scrollMemory(el as unknown as HTMLElement, true);
    });
    flushSync();
    action!.update!(false);
    await tick();
    await Promise.resolve();
    expect(el.scrollLeft).toBe(0);
    expect(header.scrollLeft).toBe(0);
    expect(active.scrollOffset).toBe(0);
    stop();
  });

  it('resets a vertical Details offset when the view switches to List', async () => {
    const { tabs } = await import('$lib/state/tabs.svelte');
    const active = { scrollOffset: 400 };
    (tabs as unknown as { active: unknown }).active = active;
    const header = { scrollLeft: 0 };
    const el = {
      scrollTop: 400,
      scrollLeft: 0,
      scrollWidth: 1000,
      scrollHeight: 2000,
      clientHeight: 300,
      clientWidth: 400,
      firstElementChild: null,
      parentElement: { querySelector: () => header },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    let action: { update?: (h: boolean) => void } | void;
    const stop = $effect.root(() => {
      action = scrollMemory(el as unknown as HTMLElement, false);
    });
    flushSync();
    action!.update!(true);
    await tick();
    await Promise.resolve();
    expect(el.scrollTop).toBe(0);
    expect(el.scrollLeft).toBe(0);
    expect(active.scrollOffset).toBe(0);
    stop();
  });

  it('puts the header at 0 when the rows no longer overflow', () => {
    const { el, header, stop } = mount();
    el.scrollLeft = 200;
    header.scrollLeft = 200;
    el.scrollWidth = 400;
    resize();
    expect(el.scrollLeft).toBe(0);
    expect(header.scrollLeft).toBe(0);
    stop();
  });
});

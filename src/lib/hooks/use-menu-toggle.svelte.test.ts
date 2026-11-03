// A button that opens a menu must be able to close it: the menu's outside-click close runs on
// pointerdown (document, capture), before the button's own click, so without a way to say "this
// one is mine" the click found the menu already closed and opened it again.
//
// No DOM here: the page is a document EventTarget and each click target a stub whose `closest`
// answers the selectors the menu asks.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { useMenu as UseMenu } from './use-menu.svelte';

const win = Object.assign(new EventTarget(), { innerWidth: 1200, innerHeight: 800 });
const doc = Object.assign(new EventTarget(), { activeElement: null, querySelector: () => null });

const panel = () =>
  ({
    setAttribute: () => {},
    style: {},
    dataset: { menuLevel: '0' },
    offsetHeight: 200,
    offsetWidth: 300,
    clientWidth: 300,
    focus: () => {},
    contains: () => false,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 300 }),
  }) as unknown as HTMLElement;

/** a click target: `closest` finds itself for any selector that names `attr` */
const target = (attr?: string) => ({
  closest: (sel: string) => (attr && sel.includes(attr) ? {} : null),
});

const pointerDownOn = (t: object) => {
  const e = new Event('pointerdown');
  Object.defineProperty(e, 'target', { value: t });
  doc.dispatchEvent(e);
};

let useMenu: typeof UseMenu;
beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  ({ useMenu } = await import('./use-menu.svelte'));
});
afterAll(() => vi.unstubAllGlobals());

const opened = () => {
  const menu = useMenu();
  menu.openAt(10, 10);
  const mounted = menu.popup(panel()) as { destroy: () => void };
  return { menu, mounted };
};

describe('a pointer press on the button that opened the menu', () => {
  it('leaves the menu open, so the button click can close it', () => {
    const { menu, mounted } = opened();
    pointerDownOn(target('data-menu-toggle'));
    expect(menu.open).toBe(true);
    mounted.destroy();
  });

  it('a press anywhere else still closes it', () => {
    const { menu, mounted } = opened();
    pointerDownOn(target());
    expect(menu.open).toBe(false);
    mounted.destroy();
  });
});

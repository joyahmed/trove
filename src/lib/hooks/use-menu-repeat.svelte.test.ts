// A held key that closes a menu must not reach what sits behind it.
//
// Seen on Linux and Mac: Esc on the file menu also cleared the selection. Traced in a real
// WebKitGTK window: the first Escape keydown closed the menu (and was stopped), the menu
// unmounted, and the auto-repeat keydowns of the same press (`repeat: true`, ~0.5 s into a hold)
// reached the list's Escape case (use-file-list.svelte.ts) and cleared the selection.
//
// No DOM here, so the page is modelled as the nodes a key passes in order — window, document,
// the list — each an EventTarget, honouring stopPropagation between nodes and
// stopImmediatePropagation within one, as a browser does.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useMenu as UseMenu } from './use-menu.svelte';

/**
 * Node's EventTarget ignores a boolean `capture` in removeEventListener (a browser does not),
 * so a listener removed with `true` would stay: normalise it to the options form.
 */
class FakeNode extends EventTarget {
  override addEventListener(
    t: string,
    f: EventListenerOrEventListenerObject | null,
    o?: boolean | AddEventListenerOptions,
  ) {
    super.addEventListener(t, f, typeof o === 'boolean' ? { capture: o } : o);
  }
  override removeEventListener(
    t: string,
    f: EventListenerOrEventListenerObject | null,
    o?: boolean | EventListenerOptions,
  ) {
    super.removeEventListener(t, f, typeof o === 'boolean' ? { capture: o } : o);
  }
}
const win = Object.assign(new FakeNode(), { innerWidth: 1200, innerHeight: 800 });
const doc = Object.assign(new FakeNode(), {
  activeElement: null,
  querySelector: () => null,
});
const listEl = new FakeNode();
const path = [win, doc, listEl];

/** Send a key down the path the way a browser does, stopping where a listener stopped it. */
const press = (type: 'keydown' | 'keyup', key: string, repeat = false) => {
  const e = Object.assign(new Event(type, { cancelable: true }), {
    key,
    repeat,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
  });
  for (const node of path) {
    node.dispatchEvent(e);
    if (e.cancelBubble) break;
  }
};

/** The parts of a panel element the `popup` action touches. */
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

let useMenu: typeof UseMenu;
const listSaw = vi.fn();

beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  ({ useMenu } = await import('./use-menu.svelte'));
  // the list's handler sits behind the menu, as Svelte's delegated onkeydown does
  listEl.addEventListener('keydown', (e) => listSaw((e as KeyboardEvent).key));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => listSaw.mockClear());

/** Open a menu and mount its panel; unmount it when it closes, as Svelte's `{#if}` does. */
const openMenu = () => {
  const menu = useMenu();
  menu.openAt(10, 10);
  const mounted = menu.popup(panel()) as { destroy: () => void };
  return {
    menu,
    /** what Svelte does after a key closed the menu: the panel's action is torn down */
    settle: () => {
      if (!menu.open) mounted.destroy();
    },
  };
};

describe('a key that closes a menu', () => {
  it('Esc closes the menu and the list never sees it', () => {
    const { menu, settle } = openMenu();
    press('keydown', 'Escape');
    settle();
    expect(menu.open).toBe(false);
    expect(listSaw).not.toHaveBeenCalled();
    press('keyup', 'Escape');
  });

  it('holding Esc: the auto-repeats after the menu closed do not reach the list', () => {
    const { menu, settle } = openMenu();
    press('keydown', 'Escape');
    settle();
    expect(menu.open).toBe(false);
    press('keydown', 'Escape', true);
    press('keydown', 'Escape', true);
    press('keyup', 'Escape');
    expect(listSaw).not.toHaveBeenCalled();
  });

  it('a new Esc press after the release reaches the list (clears the selection)', () => {
    const { settle } = openMenu();
    press('keydown', 'Escape');
    settle();
    press('keyup', 'Escape');
    press('keydown', 'Escape');
    expect(listSaw).toHaveBeenCalledExactlyOnceWith('Escape');
  });

  it('a new press goes through even when the release was missed (window lost focus)', () => {
    const { settle } = openMenu();
    press('keydown', 'Escape');
    settle();
    press('keydown', 'Escape'); // not a repeat: a fresh press
    expect(listSaw).toHaveBeenCalledExactlyOnceWith('Escape');
  });

  it('another key held after Esc is not swallowed', () => {
    const { settle } = openMenu();
    press('keydown', 'Escape');
    settle();
    press('keydown', 'ArrowDown', true);
    expect(listSaw).toHaveBeenCalledExactlyOnceWith('ArrowDown');
    press('keyup', 'Escape');
  });

  it('while the menu is open, no key reaches the list', () => {
    const { menu, settle } = openMenu();
    press('keydown', 'Delete');
    press('keydown', 'ArrowDown');
    expect(listSaw).not.toHaveBeenCalled();
    menu.close();
    settle();
  });
});

// A menu shows ONE highlight: the focused row. Menu.svelte lights rows on `:focus` only, so the
// pointer has to move focus to the row under it (`pointRow`), and the keys have to take the
// highlight away from anything the pointer lit — including a flyout's row, which stays lit
// while its flyout is open.
//
// Seen on Linux: rest the mouse on a row, press ↓, and two rows were lit — the hovered one
// (`:hover`) and the focused one. No DOM here, so the panel and its rows are a minimal fake that
// answers the few selectors the hook uses.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { useMenu as UseMenu } from './use-menu.svelte';

let active: FakeEl | null = null;
const setActive = (el: FakeEl) => (active = el);

/** Just enough of an element: attributes, a parent chain, focus, `disabled`, `tabIndex`. */
class FakeEl extends EventTarget {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  disabled = false;
  tabIndex = -1;
  style: Record<string, string> = {};
  offsetHeight = 200;
  offsetWidth = 300;
  clientWidth = 300;
  focusCalls = 0;
  constructor(attrs: Record<string, string> = {}) {
    super();
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  add(...kids: FakeEl[]) {
    for (const k of kids) {
      k.parent = this;
      this.children.push(k);
    }
    return this;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  get dataset() {
    const d: Record<string, string> = {};
    for (const [k, v] of this.attrs)
      if (k.startsWith('data-'))
        d[k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
    return d;
  }
  /** `[attr]` or `[attr="value"]`, chained: all the hook ever asks for */
  matches(sel: string) {
    return [...sel.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(
      ([, k, v]) => this.attrs.has(k) && (v === undefined || this.attrs.get(k) === v),
    );
  }
  closest(sel: string): FakeEl | null {
    return this.matches(sel) ? this : (this.parent?.closest(sel) ?? null);
  }
  querySelectorAll(sel: string): FakeEl[] {
    return this.children.flatMap((c) => [
      ...(c.matches(sel) ? [c] : []),
      ...c.querySelectorAll(sel),
    ]);
  }
  focus() {
    this.focusCalls++;
    setActive(this);
  }
  contains(n: FakeEl) {
    for (let m: FakeEl | null = n; m; m = m.parent) if (m === this) return true;
    return false;
  }
  getBoundingClientRect() {
    return { width: 300, left: 0, bottom: 0 };
  }
}

/**
 * Node's EventTarget ignores a boolean `capture` in removeEventListener (a browser does not), so
 * an unmounted menu's key listener would stay and stop every later key: normalise it.
 */
class FakeWindow extends EventTarget {
  innerWidth = 1200;
  innerHeight = 800;
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
const win = new FakeWindow();
// a getter, not a value: Object.assign would copy `activeElement` once, as null
const doc = Object.defineProperties(new EventTarget(), {
  activeElement: { get: () => active },
  querySelector: { value: () => null },
});

let useMenu: typeof UseMenu;
beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLElement', FakeEl);
  ({ useMenu } = await import('./use-menu.svelte'));
});
afterAll(() => vi.unstubAllGlobals());

let unmount = () => {};
afterEach(() => unmount());

/** A menu, open and mounted, with rows Open / Sort by (a flyout) / Paste (disabled) / Delete. */
const mount = () => {
  const row = (key: string, extra: Record<string, string> = {}) =>
    new FakeEl({ 'data-menu-row': key, ...extra });
  const open = row('open');
  const sort = row('sort', { 'data-menu-sub': '' });
  const paste = row('paste');
  paste.disabled = true;
  const del = row('delete');
  const panel = new FakeEl().add(open, sort, paste, del);
  const menu = useMenu();
  menu.openAt(10, 10);
  const mounted = menu.popup(panel as unknown as HTMLElement) as { destroy: () => void };
  /** after each test, close and unmount as Svelte's `{#if}` would: a mounted panel's key listener stays */
  unmount = () => {
    menu.close(false);
    mounted.destroy();
  };
  return { menu, panel, open, sort, paste, del };
};

/** the pointer moving on a row, as `onpointermove` hands it to the hook */
const pointAt = (menu: ReturnType<typeof useMenu>, row: FakeEl) =>
  menu.pointRow({ currentTarget: row } as unknown as PointerEvent);

const keyDown = (key: string) =>
  win.dispatchEvent(
    Object.assign(new Event('keydown', { cancelable: true }), {
      key,
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
    }),
  );

describe('one highlight in a menu', () => {
  it('the pointer on a row focuses it, so the lit row is the row under the mouse', () => {
    const { menu, panel, del } = mount();
    expect(active).toBe(panel); // opened by a click: the panel holds the keyboard, no row lit
    pointAt(menu, del);
    expect(active).toBe(del);
    expect(del.tabIndex).toBe(0);
  });

  it('moving on the row that already has focus does not focus it again', () => {
    const { menu, del } = mount();
    pointAt(menu, del);
    const calls = del.focusCalls;
    pointAt(menu, del);
    expect(del.focusCalls).toBe(calls);
  });

  it('the pointer on a disabled row leaves no row lit (focus parks on the panel)', () => {
    const { menu, panel, open, paste } = mount();
    pointAt(menu, open);
    expect(active).toBe(open);
    pointAt(menu, paste);
    expect(active).toBe(panel);
  });

  it('↓ after the pointer: the keys carry on from the pointed row', () => {
    const { menu, open, sort } = mount();
    pointAt(menu, open);
    keyDown('ArrowDown');
    expect(active).toBe(sort);
  });

  it('↓ closes a flyout the pointer opened, so its row does not stay lit beside the focused one', () => {
    const { menu, sort, del } = mount();
    pointAt(menu, sort);
    menu.openSub('sort', 0); // hovering a submenu row opens its flyout
    expect(menu.openPath).toEqual(['sort']);
    keyDown('ArrowDown'); // skips the disabled Paste
    expect(menu.openPath).toEqual([]);
    expect(active).toBe(del);
  });
});

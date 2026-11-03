import { afterEach, describe, expect, it, vi } from 'vitest';
import { enterTrap, leaveTrap, wrapTab, type TrapNode, type TrapRoot } from './focus-trap';
import { useFocusReturn } from '$lib/hooks/use-focus-return.svelte';

/** A fake document: one `activeElement`, moved by each fake element's `focus`. */
const makeRoot = () => {
  const root: TrapRoot & { querySelector: () => null } = {
    activeElement: null,
    body: { tag: 'body' },
    querySelector: () => null,
  };
  root.activeElement = root.body;
  return root;
};
type Root = ReturnType<typeof makeRoot>;

const el = (root: Root, name: string) => {
  const node = {
    name,
    focus: vi.fn(() => {
      root.activeElement = node;
    }),
    isConnected: true,
  };
  return node;
};

/** A dialog panel holding `buttons`, as `tabindex="-1"` + `use:dialog.trap` sees it. */
const panel = (root: Root, buttons: ReturnType<typeof el>[]) => {
  const node: TrapNode & { name: string } = {
    name: 'panel',
    focus: vi.fn(() => {
      root.activeElement = node;
    }),
    contains: (other) => other === node || buttons.includes(other as never),
    querySelectorAll: () => buttons,
  };
  return node;
};

const tab = (shiftKey = false) => {
  const e = {
    key: 'Tab',
    shiftKey,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
  };
  return e;
};

describe('a dialog takes the keyboard and keeps Tab inside', () => {
  it('opening moves focus from the list behind into the panel', () => {
    const root = makeRoot();
    const grid = el(root, 'grid');
    grid.focus();
    const p = panel(root, [el(root, 'Cancel'), el(root, 'Delete')]);
    enterTrap(p, root);
    expect(root.activeElement).toBe(p);
    leaveTrap(p);
  });

  it('something inside that already took focus keeps it', () => {
    const root = makeRoot();
    const field = el(root, 'field');
    const p = panel(root, [field]);
    field.focus();
    enterTrap(p, root);
    expect(root.activeElement).toBe(field);
    leaveTrap(p);
  });

  it('Tab from the panel reaches the first button; at the ends it wraps', () => {
    const root = makeRoot();
    const cancel = el(root, 'Cancel');
    const ok = el(root, 'Delete');
    const p = panel(root, [cancel, ok]);
    enterTrap(p, root);

    expect(wrapTab(tab(), p, root)).toBe(true);
    expect(root.activeElement).toBe(cancel);
    // the middle is the browser's own order: not prevented
    const mid = tab();
    expect(wrapTab(mid, p, root)).toBe(false);
    expect(mid.defaultPrevented).toBe(false);
    ok.focus();
    const end = tab();
    expect(wrapTab(end, p, root)).toBe(true);
    expect(end.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(cancel);
    expect(wrapTab(tab(true), p, root)).toBe(true);
    expect(root.activeElement).toBe(ok);
    leaveTrap(p);
  });

  it('focus dropped on <body> (a backdrop click) is pulled back in on Tab', () => {
    const root = makeRoot();
    const cancel = el(root, 'Cancel');
    const p = panel(root, [cancel]);
    enterTrap(p, root);
    root.activeElement = root.body;
    expect(wrapTab(tab(), p, root)).toBe(true);
    expect(root.activeElement).toBe(cancel);
    leaveTrap(p);
  });

  it('only the top dialog acts: Confirm over Custom commands', () => {
    const root = makeRoot();
    const under = panel(root, [el(root, 'Add')]);
    enterTrap(under, root);
    const yes = el(root, 'Delete');
    const over = panel(root, [yes]);
    enterTrap(over, root);
    expect(wrapTab(tab(), under, root)).toBe(false);
    expect(wrapTab(tab(), over, root)).toBe(true);
    expect(root.activeElement).toBe(yes);
    leaveTrap(over);
    leaveTrap(under);
  });
});

describe('use:dialog.trap (hooks/use-focus-return)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('takes focus into the dialog, wraps Tab, and lets go on close', () => {
    const root = makeRoot();
    const listeners = new Map<string, (e: unknown) => void>();
    vi.stubGlobal('document', root);
    vi.stubGlobal('window', {
      addEventListener: (type: string, f: (e: unknown) => void) => listeners.set(type, f),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    const grid = el(root, 'grid');
    grid.focus();

    const { trap } = useFocusReturn();
    const cancel = el(root, 'Cancel');
    const ok = el(root, 'Delete');
    const p = panel(root, [cancel, ok]);
    const action = trap(p as unknown as HTMLElement);
    expect(root.activeElement).toBe(p);

    ok.focus();
    const e = tab();
    listeners.get('keydown')?.(e);
    expect(e.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(cancel);

    action.destroy();
    expect(listeners.has('keydown')).toBe(false);
  });
});

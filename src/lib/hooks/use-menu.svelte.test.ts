import { describe, expect, it, vi } from 'vitest';
import { useMenu, type MenuItem } from './use-menu.svelte';

/** a toolbar button: where the menu opens below, and where focus goes back to */
const button = () => ({
  getBoundingClientRect: () => ({ left: 10, bottom: 20 }),
  focus: vi.fn(),
});

// Called straight, not inside `$effect.root`: its callback does not run synchronously here, so
// assertions inside one never execute (a probe with `expect(1).toBe(2)` inside it passed).
// `useMenu` creates no effects, so it needs no root.
const inRoot = (fn: (menu: ReturnType<typeof useMenu>) => void) => fn(useMenu());

describe('useMenu focus', () => {
  it('gives the keyboard back to the button that opened it', () => {
    inRoot((menu) => {
      const el = button();
      menu.openBelow(el as unknown as HTMLElement);
      expect(menu.open).toBe(true);
      menu.close();
      expect(menu.open).toBe(false);
      expect(el.focus).toHaveBeenCalledWith({ preventScroll: true });
    });
  });

  it('leaves focus where the click went when it closes on a click outside', () => {
    inRoot((menu) => {
      const el = button();
      menu.openBelow(el as unknown as HTMLElement);
      menu.close(false);
      expect(menu.open).toBe(false);
      expect(el.focus).not.toHaveBeenCalled();
    });
  });

  it('runs a row after focus is back, so a command that moves focus itself keeps it', () => {
    inRoot((menu) => {
      const order: string[] = [];
      const el = { ...button(), focus: vi.fn(() => order.push('focus')) };
      const item: MenuItem = {
        kind: 'item',
        key: 'rename',
        label: 'x',
        run: () => order.push('run'),
      };
      menu.openBelow(el as unknown as HTMLElement);
      menu.run(item);
      expect(order).toEqual(['focus', 'run']);
    });
  });

  it('does nothing for a disabled row: the menu stays open', () => {
    inRoot((menu) => {
      const run = vi.fn();
      const item: MenuItem = { kind: 'item', key: 'x', label: 'x', enabled: () => false, run };
      menu.openBelow(button() as unknown as HTMLElement);
      menu.run(item);
      expect(run).not.toHaveBeenCalled();
      expect(menu.open).toBe(true);
    });
  });

  it('focuses only once: a second close is a no-op', () => {
    inRoot((menu) => {
      const el = button();
      menu.openBelow(el as unknown as HTMLElement);
      menu.close();
      menu.close();
      expect(el.focus).toHaveBeenCalledTimes(1);
    });
  });
});

describe('useMenu flyouts', () => {
  it('keeps one open flyout per depth, and closing a depth closes everything under it', () => {
    inRoot((menu) => {
      menu.openBelow(button() as unknown as HTMLElement);
      menu.openSub('sort-by', 0);
      menu.openSub('more', 1);
      expect(menu.openPath).toEqual(['sort-by', 'more']);
      menu.openSub('group-by', 0); // a sibling at depth 0 replaces the whole path below it
      expect(menu.openPath).toEqual(['group-by']);
      menu.openSub('more', 1);
      menu.closeBelow(1); // ← in the deeper flyout: only that one closes
      expect(menu.openPath).toEqual(['group-by']);
      menu.closeBelow(0);
      expect(menu.openPath).toEqual([]);
      expect(menu.open).toBe(true);
    });
  });

  it('closing the menu, or opening it again, starts with no flyout open', () => {
    inRoot((menu) => {
      menu.openAt(5, 5);
      menu.openSub('sort-by', 0);
      menu.close();
      expect(menu.openPath).toEqual([]);
      menu.openAt(5, 5);
      menu.openSub('sort-by', 0);
      menu.openAt(6, 6);
      expect(menu.openPath).toEqual([]);
    });
  });
});

describe('useMenu submenu click', () => {
  it('opens the submenu and keeps it open when hover already opened it', () => {
    inRoot((menu) => {
      menu.clickSub('sort', 0);
      expect(menu.openPath).toEqual(['sort']);
      menu.openSub('sort', 0); // hover
      menu.clickSub('sort', 0);
      expect(menu.openPath).toEqual(['sort']);
    });
  });
});

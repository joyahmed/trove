// A popup menu's reactivity: open at an anchor or a point, close on outside click / Escape /
// item run, and the keyboard (utils/menu-keys.ts): arrows walk the rows and the flyouts. One
// instance per menu; the items are data (data/menus.ts or a caller's array).
import { tick } from 'svelte';
import type { Action } from 'svelte/action';
import type { GlyphName } from '$lib/data/glyphs';
import { placeMenu } from '$lib/utils/flyout-position';
import { menuKey, stepIndex } from '$lib/utils/menu-keys';

export type MenuItem =
  | { kind: 'divider'; key: string; visible?: () => boolean }
  | {
      kind: 'item';
      key: string;
      label: string;
      glyph?: GlyphName;
      /**
       * A real image for the leading slot, used where there is no Fluent glyph to name — a
       * registry verb's own `Icon`, a custom command's program. `glyph` wins when both are set.
       * The slot is reserved either way, so a broken or missing icon leaves a blank, never a
       * shifted label.
       */
      iconSrc?: string;
      shortcut?: string;
      /** a checkmark / radio state, read live */
      checked?: () => boolean;
      enabled?: () => boolean;
      /** hidden entirely when false (Explorer drops "Pin" for files); default shown */
      visible?: () => boolean;
      run: () => unknown;
    }
  /**
   * A row that opens a flyout to its side instead of doing something — Explorer's "Sort by ▸".
   * It has no `run`: clicking or hovering it opens `items`, and only a leaf ever acts. Nesting
   * is arbitrary (the renderer recurses), but one level is what Explorer uses and all we ship.
   */
  | {
      kind: 'submenu';
      key: string;
      label: string;
      glyph?: GlyphName;
      /** greyed when false: the row cannot be focused and its flyout does not open */
      enabled?: () => boolean;
      visible?: () => boolean;
      items: MenuItem[];
    };

/** The items a menu renders right now: `visible` is read live, like `checked`. */
export const visibleItems = (items: MenuItem[]) => items.filter((i) => i.visible?.() !== false);

export interface MenuPosition {
  x: number;
  y: number;
}

/**
 * Cap a panel's height and let it scroll. The scrollbar takes its width out of the content, which
 * would cut the labels: widen the panel by exactly what the scrollbar took. Widths are read as
 * fractions and rounded UP — `offsetWidth` rounds down, and a label track one sub-pixel short of
 * its text is enough to show an ellipsis.
 */
export const capPanel = (el: HTMLElement, maxHeight: number) => {
  const before = el.getBoundingClientRect().width;
  const gutterBefore = el.offsetWidth - el.clientWidth;
  el.style.maxHeight = `${maxHeight}px`;
  el.style.overflowY = 'auto';
  const scrollbar = el.offsetWidth - el.clientWidth - gutterBefore;
  el.style.width = `${Math.ceil(before + Math.max(0, scrollbar))}px`;
  el.style.maxWidth = 'none';
};

/**
 * Whether the last thing the user did was a key or the pointer. A menu opened from the keyboard
 * (Shift+F10, the Menu key, Enter on a toolbar button) puts focus on its first row, as Windows
 * does; one opened by a click only takes the keyboard, and ↓ then starts at the top. Read at open
 * time rather than passed in, so every caller (and the browser's own keyboard `contextmenu`) gets
 * it without knowing about it.
 */
let lastInput: 'key' | 'pointer' = 'pointer';

/**
 * The key that just closed a menu, until it is released. Holding a key a little too long sends
 * auto-repeat keydowns (`repeat: true`), and once the menu is gone nothing stops them: a held
 * Esc closed the menu and then its repeats reached the list, which cleared the selection (seen
 * on Linux and Mac); a held Enter on "Open" would open the file a second time. Those repeats and
 * the key's release belong to the menu that closed. A new press of the same key is not a repeat
 * and goes through, so a second Esc still clears the selection.
 */
let closedBy: string | null = null;
const swallow = (e: Event) => {
  e.stopImmediatePropagation();
  e.preventDefault();
};

let tracking = false;
const trackInput = () => {
  if (tracking || typeof window === 'undefined') return;
  tracking = true;
  // window, capture, registered first: ahead of every other key listener in the app, including
  // an open menu's own (also window, capture)
  window.addEventListener(
    'keydown',
    (e) => {
      lastInput = 'key';
      if (closedBy === null) return;
      if (e.repeat && e.key === closedBy) swallow(e);
      else closedBy = null;
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (closedBy === null || e.key !== closedBy) return;
      closedBy = null;
      swallow(e);
    },
    true,
  );
  window.addEventListener('pointerdown', () => (lastInput = 'pointer'), true);
};

/** A panel of the menu, the popup (level 0) or a flyout (its rows' depth), carries this. */
const LEVEL = 'data-menu-level';
const rowsOf = (panel: HTMLElement) =>
  [...panel.querySelectorAll<HTMLElement>('[data-menu-row]')].filter(
    (r) => r.closest(`[${LEVEL}]`) === panel,
  );
const canFocus = (row: HTMLElement) => !(row as HTMLButtonElement).disabled;

/**
 * Roving tabindex: the row with focus is its panel's one tab stop, its siblings are -1. `scroll`
 * is off for the pointer: a hovered row is already in view, and a capped menu must not jump.
 */
const focusRow = (row: HTMLElement | undefined, scroll = true) => {
  if (!row) return;
  const panel = row.closest<HTMLElement>(`[${LEVEL}]`);
  if (panel) for (const r of rowsOf(panel)) r.tabIndex = r === row ? 0 : -1;
  row.focus({ preventScroll: !scroll });
};
const focusFirst = (panel: HTMLElement) => {
  const rows = rowsOf(panel);
  focusRow(rows[stepIndex(rows.map(canFocus), -1, 'first')]);
};

export const useMenu = () => {
  trackInput();
  let open = $state(false);
  let position = $state<MenuPosition>({ x: 0, y: 0 });
  /**
   * Which flyout is open at each depth, by key: `['sort-by']` while Sort by is showing. A path
   * rather than one key so a nested flyout does not close its own parent, and so hovering a
   * sibling at depth N closes everything below it in one assignment.
   */
  let openPath = $state<string[]>([]);
  /** where the keyboard goes back to when the menu closes: the button, or what had focus */
  let returnTo: HTMLElement | null = null;

  const focused = () =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);

  /** Open just below an element (a toolbar button). */
  const openBelow = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    position = { x: r.left, y: r.bottom + 4 };
    returnTo = el;
    openPath = [];
    open = true;
  };

  /** Open at a point (a right-click, or the Menu key on the focused row). */
  const openAt = (x: number, y: number) => {
    position = { x, y };
    returnTo = focused();
    openPath = [];
    open = true;
  };

  /**
   * Close, and give the keyboard back to whatever opened the menu. `restore: false` for a click
   * outside: focus is going where the user clicked.
   */
  const close = (restore = true) => {
    if (!open) return;
    open = false;
    openPath = [];
    const el = returnTo;
    returnTo = null;
    if (restore && el?.isConnected !== false) el?.focus({ preventScroll: true });
  };

  const openSub = (key: string, depth: number) => {
    openPath = [...openPath.slice(0, depth), key];
  };
  /** a click on a submenu row opens it and never closes it: hovering already opened it, so a toggle shut it again */
  const clickSub = (key: string, depth: number) => {
    if (openPath[depth] !== key) openSub(key, depth);
  };
  const closeBelow = (depth: number) => {
    if (openPath.length > depth) openPath = openPath.slice(0, depth);
  };

  const run = (item: MenuItem) => {
    if (item.kind !== 'item' || item.enabled?.() === false) return;
    // focus back first, then the command: one that moves focus itself (Rename) keeps it
    close();
    void item.run();
  };

  /**
   * The pointer moved on a row: it becomes the keyboard's row too, so ↓ carries on from it. A
   * menu draws ONE highlight, the focused row (Menu.svelte styles `:focus`, not `:hover`), so
   * whichever input came last wins: moving the mouse takes the highlight to the row under it,
   * an arrow key takes it away from there. `pointermove`, not `mouseenter`: the browser also
   * fires mouseenter when keyboard scrolling slides a row under a resting pointer, and that
   * would snatch focus back from the keys. A disabled row cannot hold focus, so the pointer on
   * one parks focus on its panel: no row lit, as the old row is no longer where the user is.
   */
  const pointRow = (e: PointerEvent) => {
    const row = e.currentTarget;
    if (!(row instanceof HTMLElement) || row === focused()) return;
    if (canFocus(row)) focusRow(row, false);
    else row.closest<HTMLElement>(`[${LEVEL}]`)?.focus({ preventScroll: true });
  };

  /** `use:` action on the popup: outside click and the keys; keep it on screen. */
  const popup: Action<HTMLElement> = (el) => {
    el.setAttribute(LEVEL, '0');
    /** the panel whose rows sit at `level`: the popup, or a flyout (moved to <body>) */
    const panelAt = (level: number) =>
      level === 0
        ? el
        : document.querySelector<HTMLElement>(`[data-menu-flyout][${LEVEL}="${level}"]`);
    /** → / Enter on a row with a flyout: open it and put focus on its first row */
    const enterSub = async (row: HTMLElement, level: number) => {
      const key = row.dataset.menuRow;
      if (key === undefined) return;
      openSub(key, level);
      await tick();
      const fly = panelAt(level + 1);
      if (fly) focusFirst(fly);
    };
    /** ← / Esc in a flyout: close it (and all below it), focus back on the row that owns it */
    const leaveSub = (level: number) => {
      const owner = openPath[level - 1];
      const parent = panelAt(level - 1);
      closeBelow(level - 1);
      if (parent) focusRow(rowsOf(parent).find((r) => r.dataset.menuRow === owner));
    };

    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Element;
      // a flyout is moved to <body> (see Menu.svelte), so it is no longer inside `el`
      if (!el.contains(t) && !t.closest?.('[data-menu-flyout],[data-menu-toggle]')) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // While a menu is up it owns the keyboard, as on Windows: no key reaches the list, the
      // window's shortcuts or a panel underneath. That is what makes one Esc close ONE layer (the
      // menu, not the Find anything panel or the list's selection with it), and what keeps Delete
      // or Ctrl+K from acting on what sits behind an open menu. Immediate as well: the menu
      // listens on window, where other listeners share the node.
      e.stopImmediatePropagation();
      if (!open) return; // closed earlier in this tick, not yet unmounted
      const k = menuKey(e);
      if (k === null) return;
      e.preventDefault();
      const active = focused();
      const inPanel = active?.closest<HTMLElement>(`[${LEVEL}]`);
      const panel =
        inPanel && (inPanel === el || inPanel.dataset.menuFlyout !== undefined) ? inPanel : el;
      const level = Number(panel.dataset.menuLevel ?? 0);
      const rows = rowsOf(panel);
      const row = rows.find((r) => r === active);
      const isSub = row?.dataset.menuSub !== undefined;
      switch (k) {
        case 'next':
        case 'prev':
        case 'first':
        case 'last':
          // the keys leave the row whose flyout the pointer opened: that flyout closes with it,
          // or its row would stay lit beside the focused one
          closeBelow(level);
          focusRow(rows[stepIndex(rows.map(canFocus), row ? rows.indexOf(row) : -1, k)]);
          break;
        case 'open':
          if (row && isSub) void enterSub(row, level);
          break;
        case 'back':
          // the top level has no menu bar to step along: ← there does nothing
          if (level > 0) leaveSub(level);
          break;
        case 'run':
          if (row && isSub) void enterSub(row, level);
          else row?.click();
          break;
        case 'close':
          // the deepest flyout first (a hover may have opened one), the menu itself last
          if (openPath.length > 0) leaveSub(openPath.length);
          else close();
          break;
        case 'tab':
          // a Windows menu has no Tab order: the keyboard stays in the menu
          break;
      }
      // this key closed the menu (Esc, or Enter / Space on a row): its repeats are the menu's too
      if (!open) closedBy = e.key;
    };
    // Place once rendered: measure at (0,0) so a click near the right edge does not squeeze the
    // panel's shrink-to-fit width, then shift in / cap its height (see `placeMenu`).
    el.style.left = '0px';
    el.style.top = '0px';
    const height = el.offsetHeight;
    const place = (width: number) =>
      placeMenu({
        x: position.x,
        y: position.y,
        width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
    let p = place(el.offsetWidth);
    el.style.top = `${p.top}px`;
    if (p.maxHeight !== undefined) {
      capPanel(el, p.maxHeight);
      // capping adds a scrollbar and widens the panel: place it again so it keeps the right margin
      p = { ...p, left: place(el.offsetWidth).left };
    }
    el.style.left = `${p.left}px`;
    position = { x: p.left, y: p.top };

    // Take the keyboard: opened by a key, onto the first row; by a click, onto the panel itself
    if (lastInput === 'key') focusFirst(el);
    else el.focus({ preventScroll: true });

    // Rows that arrive after the menu opened (Windows' own items, plan 08 D.1) make it taller:
    // keep the top where it is unless the bottom would leave the screen, then move up or cap
    // it, by the same rule as the first placement. A capped panel already scrolls; done.
    let placedHeight = el.offsetHeight;
    const regrow = () => {
      if (el.style.maxHeight || el.offsetHeight <= placedHeight) return;
      placedHeight = el.offsetHeight;
      const q = placeMenu({
        x: position.x,
        y: position.y,
        width: el.offsetWidth,
        height: placedHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
      el.style.top = `${q.top}px`;
      if (q.maxHeight !== undefined) capPanel(el, q.maxHeight);
      position = { x: position.x, y: q.top };
    };
    // absent under jsdom; a test menu never grows
    const grown = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(regrow);
    grown?.observe(el);

    document.addEventListener('pointerdown', onPointerDown, true);
    // window, capture: the first node any key reaches, so nothing in the page sees it first
    window.addEventListener('keydown', onKey, true);
    return {
      destroy() {
        grown?.disconnect();
        document.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('keydown', onKey, true);
      },
    };
  };

  return {
    get open() {
      return open;
    },
    get position() {
      return position;
    },
    /** the open flyout's key at each depth (see `openPath` above) */
    get openPath() {
      return openPath;
    },
    openBelow,
    openAt,
    close,
    openSub,
    clickSub,
    closeBelow,
    run,
    pointRow,
    popup,
  };
};

export type Menu = ReturnType<typeof useMenu>;

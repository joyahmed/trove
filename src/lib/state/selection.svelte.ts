// Which rows are selected, and where the keyboard focus is. Explorer's rules: click selects
// one, Ctrl toggles, Shift selects the range from the anchor, arrows move the focus (Shift
// extends), Ctrl+A selects all. Paths are the identity; the list passes its visible order in.
// One API, stored per tab: `paths` / `anchor` / `focused` live on `tabs.active`, so switching
// tabs keeps each tab's selection and focus.
import { tabs } from '$lib/state/tabs.svelte';

export interface Modifiers {
  ctrl: boolean;
  shift: boolean;
}

class SelectionState {
  get paths() {
    return tabs.active.selected;
  }
  /** where a Shift-range starts */
  get anchor() {
    return tabs.active.anchor;
  }
  set anchor(v: string | null) {
    tabs.active.anchor = v;
  }
  /** the row keyboard navigation moves */
  get focused() {
    return tabs.active.focused;
  }
  set focused(v: string | null) {
    tabs.active.focused = v;
  }

  get count() {
    return this.paths.size;
  }

  has = (path: string) => this.paths.has(path);

  clear() {
    this.paths.clear();
    this.anchor = null;
    this.focused = null;
  }

  /** Esc: drop the selection but keep the focused row, so Space or an arrow carries on from it. */
  deselect() {
    this.paths.clear();
    this.anchor = null;
  }

  /** Mouse click on a row. `order` is the visible list, for Shift ranges. */
  click(path: string, mods: Modifiers, order: string[]) {
    if (mods.shift && this.anchor !== null) {
      this.#range(this.anchor, path, order, mods.ctrl);
    } else if (mods.ctrl) {
      if (this.paths.has(path)) this.paths.delete(path);
      else this.paths.add(path);
      this.anchor = path;
    } else {
      this.paths.clear();
      this.paths.add(path);
      this.anchor = path;
    }
    this.focused = path;
  }

  /**
   * A click on a row's check box (Item check boxes on): toggles that row like a Ctrl+click,
   * so check after check builds a set without a key held; Shift adds the range from the anchor.
   */
  check(path: string, order: string[], shift = false) {
    this.click(path, { ctrl: true, shift }, order);
  }

  /**
   * Right-click on a row. Explorer's rule: an unselected row becomes the sole selection; a
   * selected row keeps the whole set (the menu acts on all of it) and only takes the focus.
   */
  contextClick(path: string) {
    if (!this.paths.has(path)) {
      this.paths.clear();
      this.paths.add(path);
      this.anchor = path;
    }
    this.focused = path;
  }

  /**
   * The path a navigation asked to have scrolled fully into view, until the list has done it.
   * A reveal selects a row in a folder that is still being drawn: the list scrolls once the row
   * exists and the tab's own scroll restore has run, then clears this.
   */
  scrollTo = $state<string | null>(null);

  /** "Open file location": select `path` alone and ask the list to bring it fully into view. */
  reveal(path: string) {
    this.click(path, { ctrl: false, shift: false }, []);
    this.scrollTo = path;
  }

  /** Arrow / Home / End. Moves focus by `delta` rows, or to an absolute index when given. */
  move(order: string[], delta: number, mods: Modifiers, absolute?: number) {
    if (order.length === 0) return;
    const current = this.focused === null ? -1 : order.indexOf(this.focused);
    const next = Math.max(0, Math.min(order.length - 1, absolute ?? current + delta));
    const path = order[next];
    if (mods.shift) {
      this.anchor ??= path;
      this.#range(this.anchor, path, order, false);
    } else if (!mods.ctrl) {
      this.paths.clear();
      this.paths.add(path);
      this.anchor = path;
    }
    this.focused = path;
  }

  selectAll(order: string[]) {
    for (const p of order) this.paths.add(p);
  }

  /** Explorer's Invert selection: every listed row flips; the focus and anchor stay. */
  invert(order: string[]) {
    const was: Record<string, true> = {};
    for (const p of this.paths) was[p] = true;
    this.paths.clear();
    for (const p of order) if (!was[p]) this.paths.add(p);
  }

  /** Add a set of paths (a rubber band with Ctrl held); the focus and anchor stay. */
  addAll(paths: Iterable<string>) {
    for (const p of paths) this.paths.add(p);
  }

  /** Replace the selection with exactly `paths` (a rubber band without Ctrl). */
  replaceAll(paths: Iterable<string>) {
    this.paths.clear();
    for (const p of paths) this.paths.add(p);
  }

  /** Ctrl+Space: toggle the focused row in and out of the selection. */
  toggleFocused() {
    const path = this.focused;
    if (path === null) return;
    if (this.paths.has(path)) this.paths.delete(path);
    else this.paths.add(path);
    this.anchor = path;
  }

  /** Shift+Space: select from the anchor to the focused row, like a Shift-click on it. */
  extendTo(order: string[], path = this.focused) {
    if (path === null) return;
    this.anchor ??= path;
    this.#range(this.anchor, path, order, false);
    this.focused = path;
  }

  /** Drop paths that no longer exist after a refresh or navigation. */
  retain(order: string[]) {
    const keep = new Set(order);
    for (const p of this.paths) if (!keep.has(p)) this.paths.delete(p);
    if (this.focused !== null && !keep.has(this.focused)) this.focused = null;
    if (this.anchor !== null && !keep.has(this.anchor)) this.anchor = null;
  }

  #range(from: string, to: string, order: string[], additive: boolean) {
    const a = order.indexOf(from);
    const b = order.indexOf(to);
    if (b < 0) return;
    if (a < 0) {
      // The anchor is a row that is not on screen — folded into a group heading, say. There is
      // no run to walk, so the target becomes the new anchor instead of the move doing nothing.
      if (!additive) this.paths.clear();
      this.paths.add(to);
      this.anchor = to;
      return;
    }
    if (!additive) this.paths.clear();
    for (const p of order.slice(Math.min(a, b), Math.max(a, b) + 1)) this.paths.add(p);
  }
}

export const selection = new SelectionState();

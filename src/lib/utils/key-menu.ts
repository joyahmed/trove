// The context menu from the keyboard: the Menu key and Shift+F10, as in Explorer. Pure helpers
// so the hook stays thin and the rules are testable without a DOM.
import type { KeyLike } from '$lib/data/shortcuts';

/** The Menu (ContextMenu) key on its own, or Shift+F10 — never with Ctrl, Alt or ⌘. */
export const isMenuKey = (e: KeyLike): boolean => {
  if (e.ctrlKey || e.altKey || (e.metaKey ?? false)) return false;
  if (e.key === 'ContextMenu') return !e.shiftKey;
  return e.key === 'F10' && e.shiftKey;
};

/** How long after a keyboard open the browser's own keyboard `contextmenu` event is ignored. */
export const KEY_MENU_ECHO_MS = 500;

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a keyboard-opened menu appears: inside the item, a little in from its left edge and
 * halfway down (the name's line), or just inside the view's top-left corner for the background.
 */
export const menuAnchor = (rect: RectLike, isItem: boolean): { x: number; y: number } =>
  isItem
    ? { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + rect.height / 2 }
    : { x: rect.left + 8, y: rect.top + 8 };

/**
 * Which item the menu is for: the focused one when it is selected, else the first selected
 * row in view order; `null` (the folder background) when nothing is selected.
 */
export const menuTarget = (
  focused: string | null,
  selected: (path: string) => boolean,
  order: readonly string[],
): string | null => {
  if (focused !== null && selected(focused)) return focused;
  return order.find(selected) ?? null;
};

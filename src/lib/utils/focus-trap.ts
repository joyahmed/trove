// A dialog takes the keyboard when it opens and keeps Tab inside it until it closes.
//
// Without this the dialogs never took focus: it stayed on whatever had it behind them (a folder
// tile, a sidebar row, the rename box, the address bar), and Enter there still acted while the
// question was up. `state/modal` guards the list and window handlers as a second layer; this is
// the first — focus is simply not behind the dialog any more.
//
// ⭐ The PANEL takes focus, not a button. Each dialog's Enter is a window listener (Confirm:
// Enter = OK; Custom commands: Enter = Save in the form) and must keep meaning what it meant.
// With a button focused, Enter would ALSO click that button, so "Cancel focused + Enter" would
// both answer yes and click Cancel. The panel is `tabindex="-1"`: Tab from it reaches the first
// button, Shift+Tab the last. Once Tab HAS put focus on a button, Enter is that button's: the
// dialog's handler checks `ownsEnter(e.target)` and stands aside.
//
// Closing hands focus back (utils/focus-return); dialogs stack (Confirm over Custom commands),
// so only the topmost trap acts — Tab here, and every dialog's key handler via `isTopTrap`.

/** What Tab can land on inside a dialog. */
export const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** The subset of an element this reads, so tests need no DOM. */
export interface TrapNode {
  focus: (options?: FocusOptions) => void;
  // method syntax: an HTMLElement's `contains(Node | null)` must fit
  contains(other: unknown): boolean;
  querySelectorAll: (selector: string) => ArrayLike<{ focus: (options?: FocusOptions) => void }>;
}

/** The subset of `document` this reads. */
export interface TrapRoot {
  activeElement: unknown;
  body: unknown;
}

export interface TabKey {
  key: string;
  /** where the key landed; a hotkey recorder that is listening owns it (see `isRecordingHotkey`) */
  target?: unknown;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  preventDefault: () => void;
}

const stack: TrapNode[] = [];

/** Open: push the panel and give it focus, unless something inside already took it. */
export const enterTrap = (panel: TrapNode, root: TrapRoot) => {
  stack.push(panel);
  if (!panel.contains(root.activeElement)) panel.focus({ preventScroll: true });
};

/** Close: drop the panel (focus goes back through utils/focus-return). */
export const leaveTrap = (panel: TrapNode) => {
  const i = stack.lastIndexOf(panel);
  if (i >= 0) stack.splice(i, 1);
};

/**
 * Tab / Shift+Tab while `panel` is the top dialog: wrap at the ends, and pull focus back in from
 * <body> (a click on the backdrop drops it there). Focus somewhere else outside — a popup menu
 * mounted on <body> — is left to its owner. Returns true when it moved focus.
 */
export const wrapTab = (e: TabKey, panel: TrapNode, root: TrapRoot): boolean => {
  if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (stack.at(-1) !== panel) return false;
  // a hotkey recorder is listening: Shift+Tab is the chord being recorded, not a move
  if (isRecordingHotkey(e.target) || isRecordingHotkey(root.activeElement)) return false;
  const active = root.activeElement;
  const inside = panel.contains(active);
  if (!inside && active !== root.body && active !== null) return false;
  const items = Array.from(panel.querySelectorAll(FOCUSABLE));
  const first = items[0];
  const last = items.at(-1);
  const atPanel = !inside || active === panel;
  // not at an end: the browser's own Tab order inside the panel is right
  const target = !first || !last ? panel : e.shiftKey ? last : first;
  if (first && last && !atPanel && active !== (e.shiftKey ? first : last)) return false;
  e.preventDefault();
  target.focus({ preventScroll: true });
  return true;
};

/**
 * Is `panel` the topmost open dialog? Dialogs stack (Confirm over Settings, over Custom
 * commands) and each listens on <svelte:window>, so one key reaches all of them —
 * `stopPropagation` does not stop other listeners on the same window. Each dialog's key
 * handler acts only when this is true: Escape on "Reset settings?" must not also close Settings.
 */
export const isTopTrap = (panel: TrapNode | undefined): boolean =>
  panel !== undefined && stack.at(-1) === panel;

/** HotkeyRow puts this on its button while it waits for a chord. */
export const RECORDING_ATTR = 'data-hotkey-recording';

/** Is `target` a hotkey recorder that is listening? Every key is its input then. */
export const isRecordingHotkey = (target: unknown): boolean => {
  const t = target as { hasAttribute?: (name: string) => boolean } | null | undefined;
  return typeof t?.hasAttribute === 'function' && t.hasAttribute(RECORDING_ATTR);
};

const INPUT_OWNS_ENTER = new Set(['button', 'submit', 'reset', 'image', 'file', 'color']);

/**
 * Does `target` do its own thing on Enter? A focused button clicks, a link follows, a select
 * opens, a textarea breaks the line. A dialog's "Enter = OK / Save" must then stand aside and
 * let that control act — otherwise Tab to Cancel + Enter answers YES (a permanent delete).
 * Enter on the panel itself, on <body>, or in a text field still means the dialog's default.
 * Reads `tagName`/`type` rather than `instanceof` so tests need no DOM.
 */
export const ownsEnter = (target: unknown): boolean => {
  const t = target as { tagName?: unknown; type?: unknown } | null | undefined;
  const tag = typeof t?.tagName === 'string' ? t.tagName.toLowerCase() : '';
  if (tag === 'button' || tag === 'a' || tag === 'select' || tag === 'textarea') return true;
  return tag === 'input' && typeof t?.type === 'string' && INPUT_OWNS_ENTER.has(t.type);
};

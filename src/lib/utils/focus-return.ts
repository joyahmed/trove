// Where the keyboard goes when a dialog closes: back to whatever had it when the dialog opened.
// Without this, a click on a dialog button ("Keep both") leaves focus on the button, the dialog
// unmounts, and focus falls to <body> — the file list's keys (Delete, ⌘⌫, F2, arrows) then do
// nothing until a row is clicked (the real-Mac check, fleet #521).
//
// One exception: a button of the window's chrome — the command bar's gear, a title-bar or tab
// button — does not get it back. Explorer's toolbar buttons never keep focus; the file list does,
// so Delete works after Settings is closed with its × (the Linux check, 2026-10-07 row 5a).
// A text field, a list row, the sidebar, or a button inside another dialog still get it back.

/** The file list's one focus owner (FileList.svelte): the fallback when the opener is gone. */
export const FILE_LIST_GRID = '[role="grid"], [data-focus-home]';

/** Containers whose buttons keep focus: another dialog, a list, the sidebar's places. */
const KEEPS_FOCUS = '[role="dialog"], [role="grid"], [role="listbox"], [role="tree"], aside';

export interface FocusTarget {
  focus: (options?: FocusOptions) => void;
  isConnected: boolean;
  tagName?: string;
  disabled?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

/** The subset of `document` this reads, so tests need no DOM. */
export interface FocusRoot {
  activeElement: unknown;
  body: unknown;
  querySelector: (selector: string) => unknown;
}

const asTarget = (el: unknown): FocusTarget | null =>
  el !== null && typeof el === 'object' && typeof (el as FocusTarget).focus === 'function'
    ? (el as FocusTarget)
    : null;

/** A button of the window's chrome (toolbar, title bar, tab strip), not one in a list or dialog. */
export const isChromeButton = (el: FocusTarget): boolean => {
  const role = el.getAttribute?.('role') ?? null;
  const button = el.tagName === 'BUTTON' || role === 'button';
  return button && (el.closest?.(KEEPS_FOCUS) ?? null) === null;
};

/**
 * Call when a dialog opens; call what it returns when the dialog closes. Focus goes back to the
 * element that had it, or — when that was <body>, has since left the page or been disabled (a context-menu item, the bin's
 * "Empty" button once the bin is empty), or is a chrome button (the gear) — to the file list, if one is
 * showing. With no list (a place view), a chrome button still gets it back.
 */
export const captureFocus = (root: FocusRoot | undefined = globalThis.document) => {
  if (!root) return () => {};
  const before = root.activeElement === root.body ? null : asTarget(root.activeElement);
  return () => {
    const opener =
      before !== null && before.isConnected && before.disabled !== true ? before : null;
    const grid = asTarget(root.querySelector(FILE_LIST_GRID));
    const target = opener !== null && !(grid !== null && isChromeButton(opener)) ? opener : grid;
    target?.focus({ preventScroll: true });
  };
};

/**
 * The rename box closed by its own key (Enter, Escape): the box is gone, so focus fell to <body>.
 * Put it on the file list, which is what Explorer does (the renamed item stays focused). Only
 * from <body>: a click elsewhere that already moved focus is left where the user put it.
 */
export const refocusFileList = (root: FocusRoot | undefined = globalThis.document) => {
  if (!root) return;
  if (root.activeElement !== root.body && root.activeElement != null) return;
  asTarget(root.querySelector(FILE_LIST_GRID))?.focus({ preventScroll: true });
};

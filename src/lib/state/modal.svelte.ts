// Is a modal dialog up? While one is, the keys belong to it alone.
//
// The dialogs take focus into their panel as they open (utils/focus-trap), so keys normally
// never reach the list behind them. This is the SECOND layer: during the lazy-load skeleton
// focus is still on the list grid (or a place view), and a keydown there reaches the list's
// handler before the dialog's window listener — Enter on "Delete permanently?" opened the
// focused file, Delete, letters, arrows and the window shortcuts (Backspace = Back, Ctrl+W,
// Ctrl+Z) acted behind the dialog. Every list and window key handler asks this before acting;
// Escape and Enter still reach the dialog's own window listener.
//
// Read from state, not the DOM: a dialog is lazy-loaded, and during its skeleton there is no
// `[role=dialog]` yet but the question is already pending.
import { confirm } from '$lib/state/confirm.svelte';
import { customize } from '$lib/state/customize.svelte';
import { settingsDialog } from '$lib/state/settings-dialog.svelte';
import { transfers } from '$lib/state/transfers.svelte';

/**
 * True while Confirm (permanent delete), Replace or Skip Files, Customize context menu or
 * Settings is open. Find anything (the palette) is not counted: it takes focus into its own
 * input, so the list never sees its keys, and its shortcut must keep toggling it.
 */
export const modalOpen = (): boolean =>
  confirm.pending !== null || transfers.pending !== null || customize.open || settingsDialog.open;

/** Keys the WebView acts on by itself (F5 reloads the app; the rest scroll or select the page). */
const BROWSER_KEYS = new Set([
  'F5',
  ' ',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/**
 * For a list or view key handler: true while a dialog is up, and the key is then the dialog's
 * alone. ⚠️ Returning early is not enough — the handler would have prevented the WebView's own
 * action, so F5 (reload the whole app), Ctrl+A and the scroll keys are still prevented here.
 * Enter, Escape and Tab are left alone: the dialog's window listener and its focus trap own them.
 */
export const heldByDialog = (e: KeyboardEvent): boolean => {
  if (!modalOpen()) return false;
  const selectAll = (e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A');
  if (BROWSER_KEYS.has(e.key) || selectAll) e.preventDefault();
  return true;
};

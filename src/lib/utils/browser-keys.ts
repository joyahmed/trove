// WebView2 keeps its browser shortcuts on (wry `browser_accelerator_keys`, and tauri 2.11 has no
// switch for it): F5 / Ctrl+R reload the whole app — tabs, transfers and unsaved Settings gone —
// Ctrl+F opens a find bar, Ctrl+P a print dialog. Trove's own handlers call preventDefault for the
// keys they own, but nothing does while a text field has focus, or for a chord Trove never uses.
// This is the catch-all: one capture-phase listener that cancels the browser's action and leaves
// the event travelling, so Trove's handlers still see it.

/** The chords that only mean something to a browser, as `ctrl+shift+r` style ids. */
const BROWSER_ONLY = new Set([
  'f3', // find next
  'shift+f3', // find previous
  'f5', // reload
  'ctrl+f5', // hard reload
  'shift+f5',
  'f7', // caret browsing prompt
  'ctrl+r', // reload
  'ctrl+shift+r', // hard reload
  'ctrl+f', // find bar
  'ctrl+g', // find next
  'ctrl+shift+g', // find previous
  'ctrl+p', // print
  'ctrl+u', // view source
  'ctrl+s', // save page
  'ctrl+o', // open file
]);

/** Dev tools keys: left alone in a dev build, where they are wanted. */
const DEVTOOLS = new Set(['f12', 'ctrl+shift+i', 'ctrl+shift+j', 'ctrl+shift+c']);

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'> &
  Partial<Pick<KeyboardEvent, 'code'>>;

/** Alt+Left / Alt+Right walk the webview's history; Trove's own Back/Forward run on the same keys. */
const HISTORY = new Set([
  'alt+arrowleft',
  'alt+arrowright',
  'browserback',
  'browserforward',
  'browserrefresh',
]);

/** The key's name for a chord: its character, or on a non-Latin layout the physical letter. */
const keyName = (e: KeyLike): string => {
  const key = e.key.toLowerCase();
  if (key.length === 1 && key.charCodeAt(0) < 128) return key;
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return key;
};

const chordOf = (e: KeyLike): string => {
  // autofill and IME can send a keydown with no key at all
  if (typeof e.key !== 'string') return '';
  const name = keyName(e);
  // a chord with Win/Cmd is never one of ours to cancel
  if (e.metaKey) return '';
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(name);
  const chord = parts.join('+');
  // other Alt chords are menus and Trove's own
  return e.altKey && !HISTORY.has(chord) ? '' : chord;
};

/** Whether this key press would trigger a browser-only action. */
export const isBrowserKey = (e: KeyLike, dev: boolean = import.meta.env.DEV): boolean => {
  const chord = chordOf(e);
  if (chord === '') return false;
  return BROWSER_ONLY.has(chord) || HISTORY.has(chord) || (!dev && DEVTOOLS.has(chord));
};

/** Capture-phase listener: cancels the browser action, never stops the event. Returns the remover. */
export const blockBrowserKeys = (
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): (() => void) => {
  const onkeydown = (e: KeyboardEvent) => {
    if (isBrowserKey(e)) e.preventDefault();
  };
  // the mouse's Back / Forward buttons (3, 4) walk the webview's history too; Trove has no use for them
  const onmouse = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };
  const opts = { capture: true };
  target.addEventListener('keydown', onkeydown, opts);
  target.addEventListener('mousedown', onmouse, opts);
  target.addEventListener('mouseup', onmouse, opts);
  target.addEventListener('auxclick', onmouse, opts);
  return () => {
    target.removeEventListener('keydown', onkeydown, opts);
    target.removeEventListener('mousedown', onmouse, opts);
    target.removeEventListener('mouseup', onmouse, opts);
    target.removeEventListener('auxclick', onmouse, opts);
  };
};

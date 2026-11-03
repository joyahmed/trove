// Ctrl+Z in a text field on Linux. WebKitGTK keeps an undo history for every input (the browser's
// `execCommand('undo')` walks it, measured 2026-10-19 on 2.52.6) but binds no key to it: the
// host app is expected to (Epiphany does it with its own Undo action). WebView2 and WKWebView
// bind Ctrl+Z / ⌘Z themselves, so this runs on Linux only. The terminal's textarea is left
// alone: Ctrl+Z there is the shell's suspend.
import { TERMINAL_PANE, type FocusLike } from '$lib/data/shortcuts';
import { onLinux } from '$lib/utils/platform';

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'> &
  Partial<Pick<KeyboardEvent, 'code'>>;

/** The letter pressed: its character, or on a non-Latin layout the physical key. */
const letter = (e: KeyLike): string => {
  const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  if (key.length === 1 && key.charCodeAt(0) < 128) return key;
  return /^Key[A-Z]$/.test(e.code ?? '') ? e.code!.slice(3).toLowerCase() : key;
};

/** The edit command a key press means in a text field: GTK's Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y. */
export const textUndoCommand = (e: KeyLike, focused: FocusLike | null): 'undo' | 'redo' | null => {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  if (focused?.tagName !== 'INPUT' && focused?.tagName !== 'TEXTAREA') return null;
  if (focused.closest(TERMINAL_PANE) !== null) return null;
  const k = letter(e);
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y' && !e.shiftKey) return 'redo';
  return null;
};

/** Capture-phase listener that gives text fields their undo keys on Linux. Returns the remover. */
export const bindTextUndo = (
  linux: boolean = onLinux(),
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  doc: { activeElement: FocusLike | null; execCommand: (cmd: string) => boolean } = document,
): (() => void) => {
  if (!linux) return () => {};
  const onkeydown = (e: KeyboardEvent) => {
    const cmd = textUndoCommand(e, doc.activeElement);
    if (cmd === null) return;
    e.preventDefault();
    doc.execCommand(cmd);
  };
  const opts = { capture: true };
  target.addEventListener('keydown', onkeydown, opts);
  return () => target.removeEventListener('keydown', onkeydown, opts);
};

// Chord formatting, and the warning for chords Windows takes for itself.
//
// ⚠️ Measured on 2026-09-24. `Win+Space` is REFUSED by Windows —
// `ERROR_HOTKEY_ALREADY_REGISTERED`, because the shell owns it for the input-language switcher —
// so that one does report an error. `super+shift+space` and `super+f1` did not fire either, and
// whether those were refused or silently swallowed was never established.
//
// ⛔ So this warning is not a substitute for the error; it comes BEFORE it. A person picking a
// chord should learn it is a bad idea while choosing, not after their palette stops opening —
// and an error that arrives as a toast is gone in seconds.

import { onLinux, onMac, onWindows } from './platform';

/** Modifier spellings the chord parser accepts, in the order a chord is written. */
const MODIFIERS = ['ctrl', 'alt', 'shift', 'super'] as const;

const capitalise = (part: string) => part.charAt(0).toUpperCase() + part.slice(1);

/**
 * The Spotlight chord when nobody has chosen one: `ctrl+alt+space` on Linux, `alt+space`
 * elsewhere. Read at call time, like every platform switch.
 *
 * ⛔ Not `alt+space` on Linux (Joy's pick 2026-10-23): GNOME binds `<Alt>space` to its window
 * menu (`activate-window-menu`, D.5.2) and swallows the press, so a fresh Ubuntu install had a
 * palette that never opened. `ctrl+alt+space` is free in a stock GNOME (`core/hotkey_conflicts`
 * fixture). Rust's fallback (`commands/spotlight.rs` `DEFAULT_HOTKEY`) says the same.
 */
export const defaultSpotlightHotkey = (linux: boolean = onLinux()): string =>
  linux ? 'ctrl+alt+space' : 'alt+space';

/**
 * A Mac chord the way its menus write one: modifiers as symbols in the order ⌃ ⌥ ⇧ ⌘, then the
 * key — `alt+space` → `⌥Space`. A global chord is the real Control key here, not ⌘, unlike the
 * app's own shortcuts (`utils/key-label`), so `ctrl` is ⌃.
 */
const MAC_MODIFIERS: Record<string, [number, string]> = {
  ctrl: [0, '⌃'],
  control: [0, '⌃'],
  alt: [1, '⌥'],
  shift: [2, '⇧'],
  super: [3, '⌘'],
  meta: [3, '⌘'],
  cmd: [3, '⌘'],
};

/**
 * A chord as the keyboard is labelled: `super+space` → `Win + Space` on Windows, `Super + Space`
 * on Linux, `⌘Space` on a Mac. `mac` / `windows` default to the running OS.
 */
export const prettyChord = (
  chord: string,
  mac: boolean = onMac(),
  windows: boolean = onWindows(),
): string => {
  const parts = chord.split('+');
  if (mac) {
    const key = parts.filter((p) => !(p in MAC_MODIFIERS));
    const mods = parts
      .filter((p) => p in MAC_MODIFIERS)
      .map((p) => MAC_MODIFIERS[p])
      .sort((a, b) => a[0] - b[0])
      .map(([, sym]) => sym)
      .join('');
    return `${mods}${key.map(capitalise).join('+')}`;
  }
  return parts
    .map((part) => {
      if (part === 'super' || part === 'meta' || part === 'cmd') return windows ? 'Win' : 'Super';
      if (part === 'ctrl' || part === 'control') return 'Ctrl';
      if (part === 'alt') return 'Alt';
      if (part === 'shift') return 'Shift';
      return capitalise(part);
    })
    .join(' + ');
};

/**
 * What is wrong with `chord`, in words, or null when nothing is.
 *
 * ⚠️ These are warnings, not refusals. The person may well know their machine better than this
 * list does — a box with one input language may hand `Win+Space` over quite happily — so the
 * chord is still theirs to choose.
 */
export const chordWarning = (
  chord: string,
  windows: boolean = onWindows(),
  mac: boolean = onMac(),
): string | null => {
  const parts = chord.split('+');
  const key = parts[parts.length - 1] ?? '';

  // The two measured warnings are about Windows' own shell; off Windows they are not true.
  if (windows && parts.some((p) => p === 'super' || p === 'meta' || p === 'cmd')) {
    return 'Windows keeps most Win+key shortcuts for itself. Win+Space is refused outright, and no Win chord opened the palette when this was tested — prefer a chord without Win.';
  }
  // A lone key would fire on every press anywhere in Windows, including inside other apps.
  if (!parts.some((p) => MODIFIERS.includes(p as (typeof MODIFIERS)[number]))) {
    return mac
      ? 'A shortcut needs at least one of ⌃, ⌥ or ⇧, or it fires on every keypress everywhere.'
      : 'A shortcut needs at least one of Ctrl, Alt or Shift, or it fires on every keypress everywhere.';
  }
  // ⚠️ Measured, not assumed: Alt+Space DOES work — a global registration beats the default
  // window-menu handling, and the palette opened. The cost is real but it is a trade, not a
  // failure, so this says what it costs instead of warning it off.
  if (windows && parts.length === 2 && parts[0] === 'alt' && key === 'space') {
    return 'This works, but while Trove holds it Alt+Space will no longer open the window menu in other apps.';
  }
  return null;
};

/**
 * The chord-parser name of a key, or null for a key a shortcut cannot use (a modifier on its
 * own, a key with no name). `code` rather than `key`: `key` is what the layout produced, so a
 * shortcut recorded on a Bengali or French layout would store a character the parser cannot name.
 */
export const keyName = (code: string): string | null => {
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5).toLowerCase();
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
  const named: Record<string, string> = {
    Space: 'space',
    Enter: 'enter',
    Tab: 'tab',
    Backquote: 'backquote',
    Minus: 'minus',
    Equal: 'equal',
    Comma: 'comma',
    Period: 'period',
    Slash: 'slash',
    Semicolon: 'semicolon',
    Quote: 'quote',
    BracketLeft: 'bracketleft',
    BracketRight: 'bracketright',
    Backslash: 'backslash',
  };
  return named[code] ?? null;
};

/**
 * Whether this keydown/keyup is the Super (Windows, ⌘) key itself.
 *
 * ⚠️ Measured on Ubuntu, WebKitGTK, 2026-10-19: Super arrives as `key: 'Super'`,
 * `code: 'OSLeft'`, and NO event — not Super itself, not the K pressed while it is held — ever
 * has `metaKey` or `getModifierState('Meta' | 'OS' | 'Super' | 'Hyper')` true, though X maps
 * Super_L to Mod4. So on Linux the only way to know Super is down is to watch the key itself.
 * Chrome and WebKit elsewhere say `Meta` / `MetaLeft`; every spelling is accepted.
 */
export const isSuperKey = (e: { key: string; code: string }): boolean =>
  ['Meta', 'OS', 'Super', 'Hyper'].includes(e.key) ||
  ['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'].includes(e.code);

export interface ChordPress {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * What one keydown records: `{ chord }`, `{ refused }` with the reason in words, or null to keep
 * listening (a modifier on its own, or a key with no name). `superHeld` is the Super key seen
 * down and not yet up (`isSuperKey`), because WebKitGTK never sets `metaKey` for it.
 */
export const recordChord = (
  e: ChordPress,
  superHeld: boolean,
): { chord: string } | { refused: string } | null => {
  const key = keyName(e.code);
  if (!key) return null;
  // ⛔ Fixed order. The parser is not fussy, but two spellings of one chord would compare
  // unequal and the "already registered" check would miss.
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey || superHeld) parts.push('super');
  // A bare key would fire on every press anywhere: say so instead of ignoring the press.
  if (parts.length === 0) return { refused: chordWarning(key) ?? '' };
  return { chord: [...parts, key].join('+') };
};

let recordingFlag = false;

/**
 * Is a hotkey recorder listening? Module-level because the target test is not enough: on the Mac
 * a click does not focus a button, so Escape lands on <body> and the Settings dialog (whose
 * window listener runs first) would close. The recorder sets it on start and clears it one task
 * AFTER the keydown that stopped it, so every listener of that very Escape still sees it set.
 */
export const isHotkeyRecording = (): boolean => recordingFlag;
export const setHotkeyRecording = (on: boolean): void => {
  recordingFlag = on;
};

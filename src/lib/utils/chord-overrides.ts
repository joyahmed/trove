// Plan 08 A3/A4: the person's own chords for palette actions, as plain data. A leaf module —
// `state/settings.svelte` sanitizes with it, so it imports nothing from state (an import there
// would close a cycle). Chords are written as the window table writes them (`utils/key-label`):
// `Ctrl` is ⌘ on a Mac and Ctrl elsewhere, `Control` the real Control key on a Mac. That is the
// IN-MEMORY spelling; settings.json stores `CmdOrCtrl` for it instead (`toStoredChord`), so a
// file never says "Ctrl" for the ⌘ key.
//
// The recorder (`hooks/use-hotkey-recorder`, the Spotlight row's) hands over `ctrl+alt+shift+
// super+key` built from `e.code`, never `e.key`: a chord recorded on a Bengali layout names the
// physical key, which this module turns into the table's spelling.

/**
 * The palette actions a person may rebind: every key of `data/action-chords` `ACTION_CHORDS`
 * except `LIST_OWNED` (Cut, Copy, Paste, Rename, Select all — the file list's own key handler
 * runs those, so a window-table chord could not take their key away). `action-chords.test.ts`
 * holds this list equal to that difference.
 */
export const REBINDABLE_ACTIONS: readonly string[] = [
  'new-tab',
  'new-folder',
  'toggle-hidden',
  'open-terminal',
  'open-this-pc',
  'open-home',
  'open-recycle-bin',
  'new-text-file',
  'undo',
  'redo',
  'invert-selection',
  'sort-name',
  'sort-modified',
  'sort-size',
  'sort-type',
  'view-icons',
  'view-list',
  'view-gallery',
  'view-details',
  'view-small-icons',
  'view-tiles',
  'view-content',
  'toggle-details',
  'open-settings',
];

/** Modifiers in the one order an override is written: Control, Ctrl, Alt, Shift, then the key. */
const MOD_ORDER = ['Control', 'Ctrl', 'Alt', 'Shift'] as const;

/** `utils/hotkeys` `keyName` → the key as the table writes it. */
const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  enter: 'Enter',
  tab: 'Tab',
  backquote: '`',
  minus: '-',
  equal: '=',
  comma: ',',
  period: '.',
  slash: '/',
  semicolon: ';',
  quote: "'",
  bracketleft: '[',
  bracketright: ']',
  backslash: '\\',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
};

/** The table's key → its `KeyboardEvent.code`: an override matches the physical key it was
 * recorded on, whatever the layout types there. */
export const keyCode = (key: string): string | null => {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return key;
  if (key.startsWith('Arrow')) return key;
  const codes: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
    '`': 'Backquote',
    '-': 'Minus',
    '=': 'Equal',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    ';': 'Semicolon',
    "'": 'Quote',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
  };
  return codes[key] ?? null;
};

/**
 * Whether `chord` is an override as this module writes one: known modifiers in `MOD_ORDER`,
 * each once, at least one of Control / Ctrl / Alt (Shift alone is typing), and a key `keyCode`
 * can name. Anything else — a hand-edited settings file, an older format — is dropped.
 */
export const isOverrideChord = (chord: unknown): chord is string => {
  if (typeof chord !== 'string') return false;
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  if (keyCode(key) === null) return false;
  let at = -1;
  for (const p of parts) {
    const i = MOD_ORDER.indexOf(p as (typeof MOD_ORDER)[number]);
    if (i <= at) return false;
    at = i;
  }
  return parts.some((p) => p !== 'Shift');
};

/** Settings' `shortcutOverrides`: unknown action ids and malformed chords are dropped. */
export const sanitizeOverrides = (raw: unknown): Record<string, string> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, chord] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof chord !== 'string') continue;
    const mem = fromStoredChord(chord);
    if (REBINDABLE_ACTIONS.includes(id) && isOverrideChord(mem)) out[id] = mem;
  }
  return out;
};

/** In-memory chord → settings.json spelling: the table's `Ctrl` (⌘ on a Mac) is `CmdOrCtrl`. */
export const toStoredChord = (chord: string): string =>
  chord
    .split('+')
    .map((p, i, all) => (i < all.length - 1 && p === 'Ctrl' ? 'CmdOrCtrl' : p))
    .join('+');

/** settings.json spelling → in-memory chord. A bare `Ctrl` from an older file means the same. */
export const fromStoredChord = (chord: string): string =>
  chord
    .split('+')
    .map((p, i, all) => (i < all.length - 1 && p === 'CmdOrCtrl' ? 'Ctrl' : p))
    .join('+');

/** `shortcutOverrides` as settings.json holds it. */
export const toStoredOverrides = (o: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).map(([id, c]) => [id, toStoredChord(c)]));

/**
 * A recorder chord (`ctrl+shift+super+h`) as an override (`Ctrl+Shift+H` on a Mac, where Super
 * is ⌘ and ctrl the real Control key), or the reason it cannot be one.
 */
export const fromRecorded = (
  recorded: string,
  mac: boolean,
): { chord: string } | { refused: string } => {
  const parts = recorded.split('+');
  const name = parts.pop() ?? '';
  const key = /^[a-z]$/.test(name)
    ? name.toUpperCase()
    : /^(\d|f\d{1,2})$/.test(name)
      ? name.toUpperCase()
      : NAMED_KEYS[name];
  if (key === undefined || keyCode(key) === null) {
    return { refused: 'That key cannot be part of a shortcut here.' };
  }
  const mods = new Set<string>();
  for (const p of parts) {
    if (p === 'super') {
      if (!mac) {
        return {
          refused:
            "Trove's own shortcuts cannot use the Windows (Super) key: the system keeps it. Use Ctrl or Alt.",
        };
      }
      mods.add('Ctrl');
    } else if (p === 'ctrl') mods.add(mac ? 'Control' : 'Ctrl');
    else if (p === 'alt') mods.add('Alt');
    else if (p === 'shift') mods.add('Shift');
  }
  if (![...mods].some((m) => m !== 'Shift')) {
    return {
      refused: mac
        ? 'Add ⌘, ⌥ or ⌃: with Shift alone the key would type a letter instead.'
        : 'Add Ctrl or Alt: with Shift alone the key would type a letter instead.',
    };
  }
  const chord = [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
  return { chord };
};

/**
 * What a chord physically presses on a host, for comparing two chords: on a Mac `Ctrl` is ⌘
 * (meta) and `Control` the Control key; elsewhere both are Ctrl. "meta,shift,h".
 */
export const chordSignature = (chord: string, mac: boolean): string => {
  const plusKey = chord.endsWith('++');
  const parts = (plusKey ? chord.slice(0, -2) : chord).split('+');
  const key = plusKey ? '+' : (parts.pop() ?? '');
  const mods = new Set<string>();
  for (const p of parts) {
    if (p === 'Ctrl') mods.add(mac ? 'meta' : 'ctrl');
    else if (p === 'Control') mods.add('ctrl');
    else if (p === 'Meta') mods.add('meta');
    else mods.add(p.toLowerCase());
  }
  const order = ['ctrl', 'meta', 'alt', 'shift'];
  return [...order.filter((m) => mods.has(m)), key.length === 1 ? key.toLowerCase() : key].join(
    ',',
  );
};

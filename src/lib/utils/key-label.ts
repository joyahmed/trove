// How a key chord is written in a menu: "Ctrl+Shift+N" on Windows and Linux, "⇧⌘N" on a Mac,
// matching what the keys actually are there (data/shortcuts.ts makes Ctrl into ⌘ on a Mac,
// except the terminal's Ctrl+`, which stays the Control key there and is written ⌃`).
// Two axes (plan 19, Phase 2): the "I'm coming from" STYLE picks which chord a hint names and
// which extra keys are on; the HOST (the OS Trove runs on) draws it — ⌘ only on a Mac keyboard.
import { onMac } from './platform';
import { comingFrom, hostStyle, type OsStyle } from '$lib/state/coming-from.svelte';

/** Mac modifier order is ⌃ ⌥ ⇧ ⌘, then the key. */
const MAC_ORDER: Record<string, [number, string]> = {
  /** the Control key itself, where a chord needs it beside ⌘ (⌃⌘1) or instead of it (⌃Tab) */
  Control: [0, '⌃'],
  Ctrl: [3, '⌘'],
  Alt: [1, '⌥'],
  Shift: [2, '⇧'],
};

/** Chords whose Ctrl is the Control key on a Mac too (`keepCtrl` in data/shortcuts.ts). */
/** Keys a Mac keyboard prints as a symbol: Return, delete (⌫, Backspace) and forward delete (⌦). */
const MAC_KEYS: Record<string, string> = { Enter: '↩', Backspace: '⌫', Delete: '⌦' };

/** Arrow keys are written as arrows on every platform: "Alt+←", "⌘↑". */
const ARROWS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

const KEEP_CTRL = new Set(['Ctrl+`']);

const arrowed = (chord: string): string => {
  const i = chord.lastIndexOf('+');
  const key = i > 0 && i < chord.length - 1 ? chord.slice(i + 1) : '';
  return ARROWS[key] ? `${chord.slice(0, i + 1)}${ARROWS[key]}` : chord;
};

export const keyLabel = (chord: string, mac: boolean = onMac()): string => {
  if (!mac) return arrowed(chord);
  if (KEEP_CTRL.has(chord)) return `⌃${chord.slice('Ctrl+'.length)}`;
  // "Ctrl++" is Ctrl and the + key: split off the key before splitting the modifiers
  const plusKey = chord.endsWith('++');
  const parts = (plusKey ? chord.slice(0, -2) : chord).split('+');
  const key = plusKey ? '+' : (parts.pop() ?? '');
  const mods = parts
    .map((p) => MAC_ORDER[p] ?? [9, p])
    .sort((a, b) => a[0] - b[0])
    .map(([, sym]) => sym)
    .join('');
  return `${mods}${MAC_KEYS[key] ?? ARROWS[key] ?? key}`;
};

/**
 * Commands whose chord is a different key on a Mac, not only written differently: Windows and
 * Linux first, then the Mac (the real-Mac check, fleet #521). The Ctrl here is ⌘ on a Mac,
 * as everywhere in data/shortcuts.ts, whose test binds every Mac chord below to its command —
 * so a menu hint and the key it names cannot drift apart.
 */
export const PLATFORM_CHORDS = {
  /** Explorer's F5; Finder's View ▸ Refresh, ⌘R */
  refresh: ['F5', 'Ctrl+R'],
  /** Explorer's Ctrl+Y; every Mac app's ⇧⌘Z */
  redo: ['Ctrl+Y', 'Ctrl+Shift+Z'],
  /** Explorer's Ctrl+Tab; ⌃Tab on a Mac (⌘Tab is the system's app switcher), ⇧⌘] too */
  nextTab: ['Ctrl+Tab', 'Control+Tab'],
  prevTab: ['Ctrl+Shift+Tab', 'Control+Shift+Tab'],
  /** Explorer's Ctrl+Shift+2/5/6; ⇧⌘3/4/5 are the system's screenshot keys, so ⌃⌘2/5/6 there */
  viewIcons: ['Ctrl+Shift+2', 'Control+Ctrl+2'],
  viewList: ['Ctrl+Shift+5', 'Control+Ctrl+5'],
  viewDetails: ['Ctrl+Shift+6', 'Control+Ctrl+6'],
  /** Ctrl+Shift+N / ⇧⌘N, from anywhere in the window (not only the list) */
  newFolder: ['Ctrl+Shift+N', 'Ctrl+Shift+N'],
  /** Explorer's Alt+Enter; Finder's Get Info, ⌘I */
  properties: ['Alt+Enter', 'Ctrl+I'],
  /** Explorer's Alt+←; Finder's Go ▸ Back, ⌘[ (⌥← still works there too) */
  back: ['Alt+ArrowLeft', 'Ctrl+['],
  /** Explorer's Alt+→; Finder's Go ▸ Forward, ⌘] */
  forward: ['Alt+ArrowRight', 'Ctrl+]'],
  /** Explorer's Alt+↑; Finder's Go ▸ Enclosing Folder, ⌘↑ */
  up: ['Alt+ArrowUp', 'Ctrl+ArrowUp'],
  /** the same chord as Properties off a Mac; Finder's Show Inspector, ⌥⌘I, on one */
  detailsPane: ['Alt+Enter', 'Ctrl+Alt+I'],
} as const satisfies Record<string, readonly [string, string]>;

/**
 * The same, for keys the file list itself handles (hooks/use-file-list), not the window table
 * above — so shortcuts.test.ts cannot bind them; key-label.test.ts pins the labels instead.
 */
export const LIST_CHORDS = {
  /** Return in the list opens the item on both; on a Mac also Finder's ⌘O (and ⌘↓) */
  open: ['Enter', 'Ctrl+O'],
  /** Explorer's F2; Finder's Return (`isReturnRenameKey`) — F2 still works under Mac style too */
  rename: ['F2', 'Enter'],
  /** Explorer's Delete; Finder's Move to Trash, ⌘⌫ (use-file-list's Backspace case) */
  delete: ['Delete', 'Ctrl+Backspace'],
  /**
   * Explorer's Shift+Delete; Finder's ⌥⌘⌫ (a Mac laptop has no forward delete without fn).
   * Both ask "Delete permanently?" first. Shift+Delete still works on a Mac with a ⌦ key.
   */
  deletePermanently: ['Shift+Delete', 'Ctrl+Alt+Backspace'],
  /** Find anything: Enter opens the row, Ctrl+Enter (⌘↩ on a Mac) shows it in its folder */
  revealInFolder: ['Ctrl+Enter', 'Ctrl+Enter'],
  /** a Gallery thumbnail opens on Return on both; on a Mac also Finder's ⌘O and ⌘↓ (isFinderOpenKey) */
  galleryOpen: ['Enter', 'Ctrl+O'],
  /** the Recycle Bin purges on Delete; the Trash on Finder's ⌥⌘⌫ (isFinderPurgeKey), Delete too */
  binPurge: ['Delete', 'Ctrl+Alt+Backspace'],
} as const satisfies Record<string, readonly [string, string]>;

const ALL_CHORDS = { ...PLATFORM_CHORDS, ...LIST_CHORDS };

export type PlatformCommand = keyof typeof ALL_CHORDS;

/**
 * Chords the HOST owns whatever the style: ⌘Tab is a Mac's app switcher and ⇧⌘3/4/5 its
 * screenshot keys, so a Mac keeps ⌃Tab / ⌃⌘2…; a PC has no ⌃⌘ to press. `data/shortcuts`
 * binds these by host too (`tabCycleShortcuts`, `viewShortcuts`).
 */
const HOST_RESERVED: ReadonlySet<PlatformCommand> = new Set([
  'nextTab',
  'prevTab',
  'viewIcons',
  'viewList',
  'viewDetails',
]);

/**
 * ⛔ Ctrl+Alt+Backspace is X11's "Zap" (kill the X server) on Linux. Off by default on Ubuntu and
 * unused under Wayland, but a user may have turned it on: a Linux host never names it, and the
 * list and the bin never answer it (`finderDeleteKey`, `isFinderPurgeKey`).
 */
const LINUX_ZAP: ReadonlySet<PlatformCommand> = new Set(['deletePermanently', 'binPurge']);

/**
 * The chord as the table writes it ("Ctrl+Shift+Z"): the Finder column when the style is Mac,
 * Explorer's otherwise — except host-reserved commands (the host's column) and, on a Linux
 * host, the Zap chord (Explorer's Shift+Delete / Delete instead).
 */
export const platformChord = (
  cmd: PlatformCommand,
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
): string => {
  const column = HOST_RESERVED.has(cmd) ? host : style;
  if (column === 'mac' && host === 'linux' && LINUX_ZAP.has(cmd)) return ALL_CHORDS[cmd][0];
  return ALL_CHORDS[cmd][column === 'mac' ? 1 : 0];
};

/**
 * The menu hint: the style's chord, drawn for the host's keyboard. It names the key you press:
 * on a PC "coming from Mac" Back reads Ctrl+[ (a PC has no ⌘); on a Mac "coming from Windows"
 * it reads ⌥←.
 */
export const commandHint = (
  cmd: PlatformCommand,
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
): string => keyLabel(platformChord(cmd, style, host), host === 'mac');

/**
 * The Show hidden items chord a menu names (G.59): Finder's ⇧⌘. under Mac style or on a Mac
 * host, Nautilus' Ctrl+H under Linux style or on a Linux host (never on a Mac, where ⌘H is Hide).
 * Explorer has none, so Windows style on a Windows host takes Finder's Ctrl+Shift+. (plan 08 A1).
 * The style's own chord wins where both are on. Null is kept in the type for callers' sake.
 * `data/shortcuts` `hiddenItemsShortcuts` binds the same keys; its test holds the two together.
 */
export const hiddenItemsChord = (
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
): string | null => {
  const finder = 'Ctrl+Shift+.';
  const nautilus = 'Ctrl+H';
  if (style === 'mac') return finder;
  if (style === 'linux' && host !== 'mac') return nautilus;
  if (host === 'linux') return nautilus;
  // Explorer has none: Windows style takes Finder's (plan 08 A1, every action has a chord)
  return finder;
};

/** The same, drawn for the host's keyboard ("⇧⌘." on a Mac), or undefined: no hint. */
export const hiddenItemsHint = (
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
): string | undefined => {
  const chord = hiddenItemsChord(style, host);
  return chord === null ? undefined : keyLabel(chord, host === 'mac');
};

/**
 * Plan 08 A1: the chords that give every palette action a key, one column per "I'm coming from"
 * style — `[windows, mac, linux]`, written as the table writes them (Ctrl is ⌘ on a Mac, `Control`
 * the real Control key). The file manager's own chord wherever one exists: Finder's ⇧⌘H Home and
 * ⌃⌥⌘1/2/5/6 Sort by, Nautilus' Alt+Home and Ctrl+Shift+I. The rest are Trove's, picked clear of
 * every chord already bound under any style and of each system's reserved keys (data/shortcuts
 * `action-chords.test.ts` holds both). `data/shortcuts` `styleChordShortcuts` binds this table,
 * so a hint and its key cannot drift.
 */
export const STYLE_CHORDS = {
  /** Finder's Go ▸ Home ⇧⌘H; Nautilus' Alt+Home; Explorer has none */
  openHome: ['Ctrl+Shift+H', 'Ctrl+Shift+H', 'Alt+Home'],
  /** none of the three has one (Finder's ⇧⌘C is Copy as path here): "My computer" */
  openThisPc: ['Ctrl+Shift+M', 'Ctrl+Shift+M', 'Ctrl+Shift+M'],
  /** none of the three has one: B for Bin */
  openRecycleBin: ['Ctrl+Shift+B', 'Ctrl+Shift+B', 'Ctrl+Shift+B'],
  /** none of the three has one; ⌥⌘N on a Mac (AltGr+N is refused on a PC, `isAltGraph`) */
  newTextFile: ['Ctrl+Alt+N', 'Ctrl+Alt+N', 'Ctrl+Alt+N'],
  /** Nautilus' Ctrl+Shift+I; Explorer and Finder have none */
  invertSelection: ['Ctrl+Shift+I', 'Ctrl+Shift+I', 'Ctrl+Shift+I'],
  /** VS Code's new-terminal chord beside the terminal pane's Ctrl+`; ⌃⇧` on a Mac (⇧⌘` is the
   * system's previous-window key) */
  openTerminal: ['Ctrl+Shift+`', 'Control+Shift+`', 'Ctrl+Shift+`'],
  /** Finder's View ▸ Sort By ⌃⌥⌘1 Name, 2 Kind, 5 Date Modified, 6 Size; Ctrl+Alt+digit on a PC */
  sortName: ['Ctrl+Alt+1', 'Control+Alt+Ctrl+1', 'Ctrl+Alt+1'],
  sortType: ['Ctrl+Alt+2', 'Control+Alt+Ctrl+2', 'Ctrl+Alt+2'],
  sortModified: ['Ctrl+Alt+5', 'Control+Alt+Ctrl+5', 'Ctrl+Alt+5'],
  sortSize: ['Ctrl+Alt+6', 'Control+Alt+Ctrl+6', 'Ctrl+Alt+6'],
  /** the ninth view, after Explorer's eight (Ctrl+Shift+1…8, ⌃⌘1…8 on a Mac) */
  viewGallery: ['Ctrl+Shift+9', 'Control+Ctrl+9', 'Ctrl+Shift+9'],
} as const satisfies Record<string, readonly [string, string, string]>;

export type StyleCommand = keyof typeof STYLE_CHORDS;

/**
 * Commands the HOST's column decides, whatever the style: their Mac chord needs the real Control
 * key (⌃⌥⌘, ⌃⌘, ⌃⇧), which a PC writes as Ctrl and a Mac keeps apart from ⌘ — as `HOST_RESERVED`.
 */
export const STYLE_HOST_RESERVED: ReadonlySet<StyleCommand> = new Set([
  'openTerminal',
  'sortName',
  'sortType',
  'sortModified',
  'sortSize',
  'viewGallery',
]);

const STYLE_COLUMN: Record<OsStyle, 0 | 1 | 2> = { windows: 0, mac: 1, linux: 2 };

/** The chord a style's hint names for a command, as the table writes it. */
export const styleChord = (
  cmd: StyleCommand,
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
): string => STYLE_CHORDS[cmd][STYLE_COLUMN[STYLE_HOST_RESERVED.has(cmd) ? host : style]];

/** The same, drawn for the host's keyboard ("⇧⌘H" on a Mac). */
export const styleHint = (
  cmd: StyleCommand,
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
): string => keyLabel(styleChord(cmd, style, host), host === 'mac');

type KeyChord = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & {
  getModifierState?: (key: string) => boolean;
};

/**
 * ⛔ AltGr is Ctrl+Alt on Windows (and some Linux layouts): a German or Polish user typing
 * AltGr+key sends ctrl+alt. On a PC a Ctrl+Alt chord refuses an event that says AltGraph.
 */
export const isAltGraph = (e: { getModifierState?: (key: string) => boolean }): boolean =>
  e.getModifierState?.('AltGraph') === true;

/** The host's main modifier is down (⌘ on a Mac, Ctrl elsewhere) and the other one is not. */
const mainOnly = (e: KeyChord, host: OsStyle): boolean =>
  host === 'mac' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;

/**
 * Finder's keys are on when the style is Mac — and always on a Mac host, whose own keys no
 * style takes away (plan 19 rules: a style ADDS a chord set, it never removes the host's).
 */
const finderKeysOn = (style: OsStyle, host: OsStyle): boolean => style === 'mac' || host === 'mac';

/**
 * Finder's Open: ⌘O or ⌘↓ (Ctrl+O / Ctrl+↓ on a PC coming from Mac), with no other modifier
 * (the same test as use-file-list).
 */
export const isFinderOpenKey = (
  e: KeyChord,
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
): boolean =>
  finderKeysOn(style, host) &&
  mainOnly(e, host) &&
  !(e.altKey || e.shiftKey) &&
  (e.key === 'o' || e.key === 'O' || e.key === 'ArrowDown');

/**
 * Finder's Return: rename the selected item, not open it (G.59). Mac STYLE only, not the host:
 * a Mac "coming from Windows" keeps Explorer's Return = open, and ⌘O / ⌘↓ open under Mac
 * style (`isFinderOpenKey`). Plain Return only; Shift+Return and Alt+Return keep their jobs.
 */
export const isReturnRenameKey = (e: KeyChord, style: OsStyle = comingFrom.style): boolean =>
  style === 'mac' && e.key === 'Enter' && !(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey);

/**
 * Finder's Delete Immediately: ⌥⌘⌫ exactly (Ctrl+Alt+Backspace on Windows coming from Mac).
 * Never on a Linux host (Zap), never AltGr+Backspace on a PC. The caller still asks first.
 */
export const isFinderPurgeKey = (
  e: KeyChord,
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
): boolean =>
  finderKeysOn(style, host) &&
  host !== 'linux' &&
  e.key === 'Backspace' &&
  mainOnly(e, host) &&
  e.altKey &&
  !e.shiftKey &&
  !(host !== 'mac' && isAltGraph(e));

/**
 * Finder's delete keys in the file list: ⌘⌫ (Ctrl+Backspace on a PC coming from Mac) moves to
 * the bin, ⌥⌘⌫ (Ctrl+Alt+Backspace) is "delete permanently". Exact chords: no ⇧, no other
 * main modifier, no AltGr on a PC, no Zap on Linux. Null for anything else. ⛔ The caller maps
 * 'bin' to `actions.deleteSelected()` and 'permanent' to `actions.deletePermanently()`, which
 * asks first — never to the fs API directly.
 */
export const finderDeleteKey = (
  e: KeyChord,
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
): 'bin' | 'permanent' | null => {
  if (!finderKeysOn(style, host) || e.key !== 'Backspace') return null;
  if (!mainOnly(e, host) || e.shiftKey) return null;
  if (!e.altKey) return 'bin';
  if (host === 'linux' || (host !== 'mac' && isAltGraph(e))) return null;
  return 'permanent';
};

/** Find anything's "show in folder": Ctrl+Enter, ⌘↩ on a Mac (where Ctrl+Return is the system's). */
export const isRevealKey = (
  e: Pick<KeyChord, 'ctrlKey'> & { metaKey?: boolean },
  mac: boolean = onMac(),
): boolean => (mac ? !!e.metaKey && !e.ctrlKey : e.ctrlKey);

/** Select all: ⌘A on a Mac, Ctrl+A elsewhere — never the other platform's modifier. */
export const isSelectAllKey = (e: KeyChord, mac: boolean = onMac()): boolean =>
  (e.key === 'a' || e.key === 'A') && (mac ? e.metaKey : e.ctrlKey);

/** The four Snap keys (plan 20), as `commands::window_layout::SnapKey` names them. */
export type SnapKey = 'left' | 'right' | 'up' | 'down';

/**
 * Trove's own Snap, Windows' Win+arrows on a Mac coming from Windows (plan 20): Control+Option
 * and an arrow, Rectangle's own modifier for halves. Not ⌃+arrows (Spaces, Mission Control), not
 * Fn+⌃+arrows (macOS 15's tiling), not ⌘+arrows (text, ⌘↑ Enclosing Folder). `Control` is the
 * real Control key (`keepCtrl` in data/shortcuts.ts).
 */
export const SNAP_CHORDS: Record<SnapKey, string> = {
  left: 'Control+Alt+ArrowLeft',
  right: 'Control+Alt+ArrowRight',
  up: 'Control+Alt+ArrowUp',
  down: 'Control+Alt+ArrowDown',
};

/**
 * Whether Trove binds the Snap keys: only a Mac host coming from Windows. Windows has its own
 * Snap (Win+arrows reach the frameless window), and on Linux the desktop's Super+arrows win and
 * every free-looking fallback is a workspace key somewhere (plan 20 Q1). Mac style on a Mac has
 * macOS 15's own tiling.
 */
export const snapKeysOn = (style: OsStyle = comingFrom.style, host: OsStyle = hostStyle()) =>
  host === 'mac' && style === 'windows';

/** The hint a menu shows for a Snap key ("⌃⌥←"), or undefined where the keys are not bound. */
export const snapHint = (
  key: SnapKey,
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
): string | undefined => (snapKeysOn(style, host) ? keyLabel(SNAP_CHORDS[key], true) : undefined);

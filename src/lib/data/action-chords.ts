// Plan 08 A1: every palette action's keyboard chord, per "I'm coming from" style, as one table
// the palette rows and the menus print and `action-chords.test.ts` holds against the keys
// `data/shortcuts` actually binds. The chord strings live in `utils/key-label` (PLATFORM_CHORDS,
// LIST_CHORDS, STYLE_CHORDS); this file only says which one each action uses.
import { comingFrom, hostStyle, type OsStyle } from '$lib/state/coming-from.svelte';
import { settings } from '$lib/state/settings.svelte';
import {
  hiddenItemsChord,
  keyLabel,
  platformChord,
  styleChord,
  type PlatformCommand,
  type StyleCommand,
} from '$lib/utils/key-label';

type ChordOf = (style: OsStyle, host: OsStyle) => string | null;

const fixed =
  (chord: string): ChordOf =>
  () =>
    chord;
const platform =
  (cmd: PlatformCommand): ChordOf =>
  (style, host) =>
    platformChord(cmd, style, host);
const styled =
  (cmd: StyleCommand): ChordOf =>
  (style, host) =>
    styleChord(cmd, style, host);

/**
 * Explorer's view chord for step `n` of its View menu (1 extra large … 8 content): Ctrl+Shift+n,
 * ⌃⌘n on a Mac where ⇧⌘3/4/5 are the screenshot keys (`data/shortcuts` `viewShortcuts`).
 */
export const viewStepChord = (n: number, host: OsStyle = hostStyle()): string =>
  host === 'mac' ? `Control+Ctrl+${n}` : `Ctrl+Shift+${n}`;

/** Palette action key → its chord as the table writes it ("Ctrl+Shift+N"; Ctrl is ⌘ on a Mac). */
export const ACTION_CHORDS: Record<string, ChordOf> = {
  'new-tab': fixed('Ctrl+T'),
  'new-folder': platform('newFolder'),
  'toggle-hidden': (style, host) => hiddenItemsChord(style, host),
  'open-terminal': styled('openTerminal'),
  'open-this-pc': styled('openThisPc'),
  'open-home': styled('openHome'),
  'open-recycle-bin': styled('openRecycleBin'),
  'new-text-file': styled('newTextFile'),
  cut: fixed('Ctrl+X'),
  copy: fixed('Ctrl+C'),
  paste: fixed('Ctrl+V'),
  rename: platform('rename'),
  undo: fixed('Ctrl+Z'),
  redo: platform('redo'),
  'select-all': fixed('Ctrl+A'),
  'invert-selection': styled('invertSelection'),
  'sort-name': styled('sortName'),
  'sort-modified': styled('sortModified'),
  'sort-size': styled('sortSize'),
  'sort-type': styled('sortType'),
  'view-icons': platform('viewIcons'),
  'view-list': platform('viewList'),
  'view-gallery': styled('viewGallery'),
  'view-details': platform('viewDetails'),
  'view-small-icons': (_style, host) => viewStepChord(4, host),
  'view-tiles': (_style, host) => viewStepChord(7, host),
  'view-content': (_style, host) => viewStepChord(8, host),
  'toggle-details': platform('detailsPane'),
  'open-settings': fixed('Ctrl+,'),
};

/**
 * Actions whose chord the file list's own key handler runs (hooks/use-file-list), not the window
 * table: they act on the list's selection, so they only mean something with the list focused.
 */
export const LIST_OWNED: ReadonlySet<string> = new Set([
  'cut',
  'copy',
  'paste',
  'rename',
  'select-all',
]);

/**
 * ⛔ The allow-list: actions that deliberately have NO chord, each with the reason. The palette
 * (Ctrl+K, ⌘K) still reaches every one of them from the keyboard. Keys are palette action keys,
 * or `command:<key>` for a toolbar button (`data/command-actions`).
 */
export const CHORD_FREE: Record<string, string> = {
  'cascade-windows':
    'arranges every Trove window at once, a rare layout command; Explorer, Finder and Nautilus give it no key, and the free-looking chords (Ctrl+Alt+arrows, Super+arrows) are window-manager keys',
  'stack-windows': 'the same arrange family as Cascade windows: rare, palette and Window menu only',
  'windows-side-by-side':
    'the same arrange family as Cascade windows: rare, palette and Window menu only',
  'save-tab-set':
    'a rare, name-it-once command, like the tab-set rows it feeds (open, rename, delete); no browser or file manager gives "save these tabs as a set" a key, and the free chords are taken',
  'undo-history':
    'a panel opened to pick an older action, not a step: Ctrl+Z and Ctrl+Y stay the keys for the newest one, Explorer and Finder have no history list to give a key to, and the palette reaches it (the More menu is at its 24-row budget)',
  'paste-paths-terminal':
    'a rare, "if it proves useful" command (plan 08 E3, low priority); the row menu and the palette reach it, and every free chord near Copy as path (Ctrl+Shift+C) belongs to a terminal',
  'command:new':
    'a menu button, not an action: its rows carry the chords (New folder Ctrl+Shift+N, New text document Ctrl+Alt+N)',
  'command:filters':
    'a menu of the search chips that exists only while a search is on; it is a toolbar button in the Tab order (Shift+Tab from the search box)',
};

/** Toolbar buttons (`data/command-actions`) that run a palette action, by button key. */
export const COMMAND_ACTIONS: Record<string, string> = {
  details: 'toggle-details',
  settings: 'open-settings',
};

/** An action's chord as its style gives it on a host, ignoring the person's own (`actionChord`). */
export const defaultChord = (
  key: string,
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
): string | null => ACTION_CHORDS[key]?.(style, host) ?? null;

/**
 * ⭐ Plan 08 A3: THE effective chord — the person's override (Settings ▸ Keyboard) or else the
 * style's. The window table (`data/shortcuts` `applyOverrides`), the menus, the palette rows and
 * the toolbar tooltips all read it, so a rebind shows and fires everywhere at once.
 */
export const actionChord = (
  key: string,
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
  overrides: Readonly<Record<string, string>> = settings.shortcutOverrides,
): string | null =>
  (Object.hasOwn(overrides, key) ? overrides[key] : undefined) ?? defaultChord(key, style, host);

/** The hint a palette row prints ("⇧⌘H" on a Mac, "Ctrl+Shift+H" elsewhere), or undefined. */
export const actionHint = (
  key: string,
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
  overrides: Readonly<Record<string, string>> = settings.shortcutOverrides,
): string | undefined => {
  const chord = actionChord(key, style, host, overrides);
  return chord === null ? undefined : keyLabel(chord, host === 'mac');
};

/**
 * The palette's view rows by their step in `explorerViewOrder` (extra large and medium have
 * none): the View menu's rows and `data/shortcuts` `viewShortcuts` both read it.
 */
export const VIEW_STEP_ACTIONS: readonly (string | undefined)[] = [
  undefined,
  'view-icons',
  undefined,
  'view-small-icons',
  'view-list',
  'view-details',
  'view-tiles',
  'view-content',
];

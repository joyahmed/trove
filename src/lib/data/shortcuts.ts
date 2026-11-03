// The window-wide keyboard shortcuts, as data (CONTRIBUTING § 2): the shell's keydown handler
// walks this table. Every `run` reads state at call time. `whileTyping: false` (the default)
// skips a chord while a text field owns the keyboard — the rename box and the address bar
// have their own undo and their own Backspace.
import { actions } from '$lib/state/actions.svelte';
import { panes } from '$lib/state/panes.svelte';
import { selection } from '$lib/state/selection.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { terminal } from '$lib/state/terminal.svelte';
import { closeTab } from '$lib/hooks/use-tab-strip.svelte';
import { ADDRESS_HISTORY_EVENT } from '$lib/hooks/use-address-bar.svelte';
import { openWindow, snapWindow } from '$lib/api/window';
import { settingsDialog } from '$lib/state/settings-dialog.svelte';
import { findAnything } from '$lib/hooks/use-palette.svelte';
import { onMac } from '$lib/utils/platform';
import { isAltGraph, SNAP_CHORDS, snapKeysOn, type SnapKey } from '$lib/utils/key-label';
import { comingFrom, hostStyle, type OsStyle } from '$lib/state/coming-from.svelte';
import { explorerViewOrder, stepIconSize, type ViewStep } from '$lib/utils/view-steps';

export interface Shortcut {
  /** `KeyboardEvent.key`, matched case-insensitively for letters */
  key: string;
  /** `KeyboardEvent.code` instead, for chords where Shift changes `key` (Ctrl+Shift+1 is `!`) */
  code?: string;
  /** a `KeyboardEvent.code` that ALSO matches, next to `key`: the physical key, for a chord whose
   * character moves between layouts (Ctrl+` is "^" on German) */
  orCode?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** ⌘ on a Mac. Left out, the chord does not care whether ⌘ is down — every chord but Find
   * anything's, which is ⌘K on a Mac and must not also answer Ctrl+⌘+K there */
  meta?: boolean;
  /** Ctrl even on a Mac (the terminal's Ctrl+`); every other `ctrl` chord is ⌘ on a Mac */
  keepCtrl?: boolean;
  /** still fires while an <input> / <textarea> has focus */
  whileTyping?: boolean;
  /** …but not from the terminal pane, whose shell has its own meaning for it (^L clear,
   * ^K kill line, ^E end of line, ^F forward, Alt+D delete word) */
  shellOwns?: boolean;
  run: () => unknown;
}

/** The subset of a KeyboardEvent the matcher reads, so tests need no DOM. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey?: boolean;
  /** AltGr on a PC arrives as ctrl+alt; this tells the two apart (`isAltGraph`) */
  getModifierState?: (key: string) => boolean;
}

/**
 * Open (or close) Find anything. A rename in progress is cancelled first, keeping the old name:
 * the palette taking focus would blur the rename box, and a blur commits — the half-typed name.
 */
const toggleFindAnything = () => {
  if (actions.renaming !== null) actions.cancelRename();
  findAnything.toggle();
};

/** Find anything: Ctrl+K, ⌘K on a Mac — the in-window palette, from anywhere, typing or not. */
export const findAnythingShortcut = (mac: boolean): Shortcut =>
  mac
    ? { key: 'k', meta: true, whileTyping: true, shellOwns: true, run: toggleFindAnything }
    : { key: 'k', ctrl: true, whileTyping: true, shellOwns: true, run: toggleFindAnything };

/** The chip in the search box that names the chord. */
export const findAnythingHint = (mac: boolean): string => (mac ? '⌘K' : 'Ctrl K');

const focusSearch = () => {
  // the one DOM lookup in the shell: the search box marks itself with data-search. A narrow
  // window takes the box off the toolbar (plan 15 G.73); the palette is the search then.
  const box = document.querySelector<HTMLInputElement>('[data-search]');
  if (box) box.focus();
  else findAnything.show();
};

/** The subset of `document` the address-bar lookup reads, so tests need no DOM. */
export interface QueryRoot {
  querySelector: (selector: string) => Element | null;
}

/**
 * Ctrl+L / Alt+D (⌘L on a Mac): type a path. The address bar becomes its text field — focused,
 * path selected — when its crumb row is clicked, so this clicks that row. The crumbs mark
 * themselves with data-drop-kind="crumb" (there is always at least one); their row is the
 * nearest role="presentation" above them. False when there is no address bar, or it is
 * already a text field (which then has the focus).
 */
export const focusAddressBar = (root: QueryRoot = document): boolean => {
  const row = root
    .querySelector('[data-drop-kind="crumb"]')
    ?.closest<HTMLElement>('[role="presentation"]');
  if (!row) return false;
  row.click();
  return true;
};

/** Ctrl+L everywhere (⌘L on a Mac); Explorer's Alt+D too, but not on a Mac, where ⌥D types ∂. */
export const addressBarShortcuts = (mac: boolean): Shortcut[] => [
  { key: 'l', ctrl: true, whileTyping: true, shellOwns: true, run: () => focusAddressBar() },
  ...(mac
    ? []
    : [{ key: 'd', alt: true, whileTyping: true, shellOwns: true, run: () => focusAddressBar() }]),
];

/**
 * F4: the address bar's ▾ list of recent places, as in Explorer. The bar marks itself with
 * data-address-bar; false when there is none. From the address field itself the field's own
 * key handler opens it (Alt+↓ too), so this chord is not `whileTyping`.
 */
export const openAddressHistory = (root: QueryRoot = document): boolean => {
  const bar = root.querySelector('[data-address-bar]');
  if (!bar) return false;
  bar.dispatchEvent(new CustomEvent(ADDRESS_HISTORY_EVENT));
  return true;
};

export const addressHistoryShortcut: Shortcut = { key: 'F4', run: () => openAddressHistory() };

/**
 * Alt+Enter, Properties (the details pane), wherever the window has focus — not only in the
 * list, as the menus' "Alt+Enter" hint promises. It needs a selection to show, or the pane
 * open already (the chord then closes it). Not from a text field, which owns its keys.
 */
export const propertiesShortcut: Shortcut = {
  key: 'Enter',
  alt: true,
  run: () => (selection.count > 0 || panes.isOpen('details')) && panes.toggle('details'),
};

/**
 * Finder's chords (utils/key-label `PLATFORM_CHORDS`' Mac column, which the menus' hints read):
 * Redo ⇧⌘Z, ⌘I Properties, ⌥⌘I the Details pane, and Finder's Go menu (Mac, 2026-10-07: only ⌥↑
 * did anything) — ⌘[ Back, ⌘] Forward, ⌘↑ the enclosing folder. The table's Ctrl is ⌘ on a Mac
 * and Ctrl on a PC coming from Mac (plan 19), matched exactly — ⌥⌘[ or ⇧⌘↑ is not them. ⌘↓ is
 * NOT bound here: it is Finder's Open, the list's own key (`isFinderOpenKey`). Refresh needs no
 * entry: Ctrl+R (⌘R) is bound on every platform, and F5 is the list's own key.
 */
export const finderShortcuts = (): Shortcut[] => [
  { key: 'z', ctrl: true, shift: true, run: () => actions.redo() },
  { key: 'i', ctrl: true, run: propertiesShortcut.run },
  { key: 'i', ctrl: true, alt: true, run: () => panes.toggle('details') },
  { key: '[', ctrl: true, run: () => tabs.active.back() },
  { key: ']', ctrl: true, run: () => tabs.active.forward() },
  { key: 'ArrowUp', ctrl: true, run: () => tabs.active.up() },
];

/** Explorer's chord that differs from Finder's: Redo is Ctrl+Y (⌘Y on a Mac coming from Windows).
 * Explorer's Alt+←/→/↑ stay in the main table on every platform. */
export const explorerShortcuts = (): Shortcut[] => [
  { key: 'y', ctrl: true, run: () => actions.redo() },
];

const jump = (n: number): Shortcut => ({
  key: String(n),
  ctrl: true,
  whileTyping: true,
  run: () => tabs.jump(n),
});

const setView = (view: ViewStep) => () => {
  tabs.active.setView(view.view, stepIconSize(view));
};

/**
 * Explorer's view chords, its View menu's order: Ctrl+Shift+1 extra large, 2 large, 3 medium,
 * 4 small icons, 5 list, 6 details, 7 tiles, 8 content. On a Mac ⇧⌘3/4/5 are the system's
 * screenshot keys, so the views are ⌃⌘1…8 there (⌘1-9 stay tabs).
 */
export const viewShortcuts = (mac: boolean): Shortcut[] =>
  explorerViewOrder.map((view, i) => {
    const n = i + 1;
    const base = { key: String(n), code: `Digit${n}`, run: setView(view) };
    return mac
      ? { ...base, ctrl: true, meta: true, keepCtrl: true }
      : { ...base, ctrl: true, shift: true };
  });

/**
 * Next / previous tab. ⌘Tab is macOS's app switcher, so a Mac gets Control+Tab (as Safari and
 * Finder) and ⇧⌘] / ⇧⌘[ (matched by key position: Shift types } and {).
 */
export const tabCycleShortcuts = (mac: boolean): Shortcut[] => {
  const next = () => tabs.next();
  const prev = () => tabs.prev();
  const t = { whileTyping: true };
  return mac
    ? [
        { key: 'Tab', ctrl: true, keepCtrl: true, meta: false, ...t, run: next },
        { key: 'Tab', ctrl: true, keepCtrl: true, meta: false, shift: true, ...t, run: prev },
        { key: ']', code: 'BracketRight', ctrl: true, shift: true, ...t, run: next },
        { key: '[', code: 'BracketLeft', ctrl: true, shift: true, ...t, run: prev },
      ]
    : [
        // ⚠️ matched by `code` too: WebKitGTK on X11 reports Shift+Tab (keysym ISO_Left_Tab) as
        // key "Unidentified", code "Tab" — measured on Linux, so key alone never saw Ctrl+Shift+Tab
        { key: 'Tab', code: 'Tab', ctrl: true, ...t, run: next },
        { key: 'Tab', code: 'Tab', ctrl: true, shift: true, ...t, run: prev },
      ];
};

const toggleHidden = () => (settings.showHidden = !settings.showHidden);

/**
 * Show / hide hidden items (G.59), the key each system's file manager uses: Finder's ⇧⌘. (by key
 * position, `Period` — Shift types ">"), Nautilus' Ctrl+H. Explorer has none, so Windows style on
 * a Windows host binds nothing. Finder's chord is the host's own on a Mac and comes with Mac
 * style anywhere; Ctrl+H is a Linux host's own and comes with Linux style on a PC — never on a
 * Mac, where ⌘H is the system's Hide. `utils/key-label` `hiddenItemsChord` names the same keys.
 */
export const hiddenItemsShortcuts = (
  mac: boolean,
  style: OsStyle,
  linuxHost = false,
): Shortcut[] => [
  ...(mac || style === 'mac'
    ? [{ key: '.', code: 'Period', ctrl: true, shift: true, run: toggleHidden }]
    : []),
  ...(!mac && (linuxHost || style === 'linux')
    ? [{ key: 'h', ctrl: true, run: toggleHidden }]
    : []),
];

/**
 * Trove's own Snap (plan 20): ⌃⌥←/→/↑/↓ on a Mac coming from Windows, built from
 * `utils/key-label` `SNAP_CHORDS` so the menu hint and the key cannot drift. Exact: ⌃⌥⌘← and
 * ⇧⌃⌥← are not it. Everywhere else nothing — Windows' own Snap and the Linux desktop's win.
 */
export const snapShortcuts = (style: OsStyle, host: OsStyle): Shortcut[] =>
  snapKeysOn(style, host)
    ? (Object.keys(SNAP_CHORDS) as SnapKey[]).map((key) => ({
        key: SNAP_CHORDS[key].slice(SNAP_CHORDS[key].lastIndexOf('+') + 1),
        ctrl: true,
        keepCtrl: true,
        alt: true,
        meta: false,
        whileTyping: true,
        run: () => snapWindow(key).catch(() => {}),
      }))
    : [];

/** Ctrl+Shift+N (⇧⌘N), the folder the active tab shows, from anywhere in the window. */
export const newFolderShortcut: Shortcut = {
  key: 'n',
  ctrl: true,
  shift: true,
  run: () => actions.newFolder(),
};

/** The chords a Mac's File menu also offers (`commands/app_menu.rs`), by its command name. */
const menuCommands = {
  'new-tab': () => tabs.open(),
  'new-window': () => openWindow(),
  'close-tab': () => closeTab(),
};
type MenuCommand = keyof typeof menuCommands;

/**
 * Ctrl+` opens and closes the terminal pane; Ctrl on a Mac too, as every editor there does.
 * Matched by the character and by the key left of 1, which types "^" on German, "²" on French.
 */
const terminalToggle: Shortcut = {
  key: '`',
  orCode: 'Backquote',
  ctrl: true,
  keepCtrl: true,
  whileTyping: true,
  run: () => terminal.toggle(),
};

/**
 * The window table for a host (`mac`: the table's Ctrl is ⌘) and an "I'm coming from" style
 * (plan 19). The host's own set is always on and the style's set is ADDED — a style never takes
 * a key away: a Mac keeps ⌘[ under Windows style, a PC keeps Ctrl+Y under Mac style. The host
 * alone decides the chords its system reserves: views, tab cycle, Alt+D, Find anything.
 * `linuxHost` adds the Linux host's own keys (Ctrl+H, hidden items) whatever the style.
 */
export const shortcutTable = (
  mac: boolean,
  style: OsStyle = mac ? 'mac' : 'windows',
  linuxHost = false,
): Shortcut[] => [
  { key: 't', ctrl: true, whileTyping: true, run: menuCommands['new-tab'] },
  { key: 'n', ctrl: true, whileTyping: true, run: menuCommands['new-window'] },
  { key: ',', ctrl: true, whileTyping: true, run: () => settingsDialog.show() },
  { key: 't', ctrl: true, shift: true, whileTyping: true, run: () => tabs.reopen() },
  { key: 'w', ctrl: true, whileTyping: true, run: menuCommands['close-tab'] },
  ...tabCycleShortcuts(mac),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(jump),
  ...viewShortcuts(mac),
  newFolderShortcut,
  // Explorer's Ctrl+R, Finder-style ⌘R: re-read the folder from anywhere, not only the list
  { key: 'r', ctrl: true, run: () => tabs.active.refresh() },
  { key: 'z', ctrl: true, run: () => actions.undo() },
  ...(mac || style === 'mac' ? finderShortcuts() : []),
  ...(!mac || style !== 'mac' ? explorerShortcuts() : []),
  ...hiddenItemsShortcuts(mac, style, linuxHost),
  ...snapShortcuts(style, mac ? 'mac' : linuxHost ? 'linux' : 'windows'),
  { key: 'f', ctrl: true, whileTyping: true, shellOwns: true, run: focusSearch },
  { key: 'e', ctrl: true, whileTyping: true, shellOwns: true, run: focusSearch },
  ...addressBarShortcuts(mac),
  addressHistoryShortcut,
  findAnythingShortcut(mac),
  terminalToggle,
  { key: 'p', alt: true, run: () => panes.toggle('preview') },
  propertiesShortcut,
  // text size, as a browser: the whole UI zooms and the factor is remembered
  { key: '+', ctrl: true, whileTyping: true, run: () => settings.zoomBy(1) },
  { key: '=', ctrl: true, whileTyping: true, run: () => settings.zoomBy(1) },
  { key: '-', ctrl: true, whileTyping: true, run: () => settings.zoomBy(-1) },
  { key: '0', ctrl: true, whileTyping: true, run: () => (settings.zoom = 1) },
  // Explorer's navigation chords; Backspace is Back only outside a text field and a rename
  { key: 'ArrowLeft', alt: true, run: () => tabs.active.back() },
  { key: 'ArrowRight', alt: true, run: () => tabs.active.forward() },
  { key: 'ArrowUp', alt: true, run: () => tabs.active.up() },
  { key: 'Backspace', run: () => actions.renaming === null && tabs.active.back() },
];

let memo: { key: string; table: Shortcut[] } | null = null;

/**
 * The table in force: the host's, plus the chosen style's set. Rebuilt only when the style (or,
 * in tests, the host) changes, so a Settings flip takes effect on the next key with no restart.
 */
export const currentShortcuts = (): Shortcut[] => {
  const mac = onMac();
  const style = comingFrom.style;
  const linuxHost = hostStyle() === 'linux';
  const key = `${mac}|${style}|${linuxHost}`;
  if (memo?.key !== key) memo = { key, table: shortcutTable(mac, style, linuxHost) };
  return memo.table;
};

/**
 * A Mac menu-bar command (`MENU_EVENT`, `commands/app_menu.rs`) → the action the keydown table
 * runs for the same chord. The menu owns ⌘T / ⌘N / ⌘W there, so their keydown never arrives;
 * both read `menuCommands`, so there is one action per chord. Null for an unknown command.
 */
export const menuCommandFor = (command: string): (() => unknown) | null =>
  Object.hasOwn(menuCommands, command) ? menuCommands[command as MenuCommand] : null;

const sameKey = (a: string, b: string) =>
  a.length === 1 && b.length === 1 ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * The physical key of a one-letter or one-digit chord. An Option chord on a Mac types another
 * character (Option+P is "π"), so Alt chords compare the key's position, not what it typed.
 */
const codeOf = (key: string): string | null =>
  /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : null;

const keyMatches = (e: KeyLike, s: Shortcut): boolean => {
  if (s.orCode !== undefined && e.code === s.orCode) return true;
  if (s.code !== undefined && e.code !== undefined) return e.code === s.code;
  if (sameKey(e.key, s.key)) return true;
  return s.alt === true && e.code !== undefined && e.code === codeOf(s.key);
};

/**
 * '+' is itself typed with Shift on a US keyboard (⇧⌘=), so Shift held is not a modifier there.
 * Chromium and WebKitGTK report Ctrl+Shift+= as key "+"; a Mac WKWebView reports a ⌘ chord's
 * UNshifted key, so ⇧⌘= arrives as "=" with Shift held (measured, plan 15 E) - on a Mac's ⌘
 * chord, '=' takes Shift too. Off a Mac, Ctrl+Shift+"=" stays unmatched, as before.
 */
const shiftIsTheKey = (s: Shortcut, macMeta: boolean): boolean =>
  s.shift === undefined && (s.key === '+' || (macMeta && s.key === '='));

/**
 * The first shortcut the event matches, or null. `typing` skips the chords a text field owns.
 * On a Mac the table's Ctrl is ⌘ (⌘F, ⌘T, ⌘W…), as every Mac app does it, except `keepCtrl`
 * chords; a chord that names `meta` itself (⌘K) is matched as written.
 * ⛔ Off a Mac, ctrl+alt with AltGraph is AltGr typing a character (German, Polish…), never a
 * chord: Mac style brings Ctrl+Alt+I to PCs (plan 19 rules).
 */
export const matchShortcut = (
  e: KeyLike,
  typing: boolean,
  table: Shortcut[] = currentShortcuts(),
  mac: boolean = onMac(),
  inTerminal = false,
): Shortcut | null => {
  if (!mac && e.ctrlKey && e.altKey && isAltGraph(e)) return null;
  return (
    table.find((s) => {
      const primaryIsMeta = mac && s.meta === undefined && !s.keepCtrl;
      const wantCtrl = primaryIsMeta ? false : (s.ctrl ?? false);
      const wantMeta = primaryIsMeta ? (s.ctrl ?? false) : s.meta;
      return (
        keyMatches(e, s) &&
        e.ctrlKey === wantCtrl &&
        e.altKey === (s.alt ?? false) &&
        (e.shiftKey === (s.shift ?? false) || shiftIsTheKey(s, primaryIsMeta)) &&
        (wantMeta === undefined || (e.metaKey ?? false) === wantMeta) &&
        (!typing || s.whileTyping === true) &&
        !(inTerminal && s.shellOwns === true)
      );
    }) ?? null
  );
};

/** The terminal pane marks itself so (TerminalHost.svelte); Find anything stands down there too. */
export const TERMINAL_PANE = '[aria-label="Terminal pane"]';

/** The focused element, as the window handler sees it — tests pass a stand-in. */
export interface FocusLike {
  tagName: string;
  isContentEditable?: boolean;
  closest: (selector: string) => unknown;
}

/**
 * The shortcut a window keydown runs, given what has focus: a text field (rename box, address
 * bar, search, the terminal's textarea) owns its keys, and the terminal also owns `shellOwns`.
 */
export const shortcutFor = (
  e: KeyLike,
  focused: FocusLike | null,
  table: Shortcut[] = currentShortcuts(),
  mac: boolean = onMac(),
): Shortcut | null => {
  const typing =
    focused?.tagName === 'INPUT' ||
    focused?.tagName === 'TEXTAREA' ||
    focused?.isContentEditable === true;
  const inTerminal = focused !== null && focused.closest(TERMINAL_PANE) !== null;
  return matchShortcut(e, typing, table, mac, inTerminal);
};

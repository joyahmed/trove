// Plan 08 A3/A4: rebinding a palette action's chord (Settings ▸ Keyboard). The chord comes from
// the Spotlight row's recorder (`hooks/use-hotkey-recorder`, `e.code`, fixed modifier order);
// this module refuses a chord another command already answers or the system keeps, and only a
// chord it accepts reaches `settings.shortcutOverrides`. `action-chords` `actionChord` then
// carries it to the window table, the menus, the palette rows and the toolbar tooltips.
import { comingFrom, hostStyle, type OsStyle } from '$lib/state/coming-from.svelte';
import { settings } from '$lib/state/settings.svelte';
import { actionChord, defaultChord, LIST_OWNED } from '$lib/data/action-chords';
import { paletteActions } from '$lib/data/palette-actions';
import { shortcutTable, type Shortcut } from '$lib/data/shortcuts';
import { chordSignature, fromRecorded, REBINDABLE_ACTIONS } from '$lib/utils/chord-overrides';
import { keyLabel, platformChord, type PlatformCommand } from '$lib/utils/key-label';

interface Reserved {
  chord: string;
  why: string;
}

/**
 * Keys each system keeps for itself, as the table writes chords for that system (`Ctrl` is ⌘ on
 * a Mac). A rebind is checked against the host's list and the "I'm coming from" style's: a PC
 * coming from Mac keeps Ctrl+Q free because the hand reaching for it means ⌘Q.
 */
export const RESERVED_CHORDS: Record<OsStyle, readonly Reserved[]> = {
  mac: [
    { chord: 'Ctrl+Tab', why: "the Mac's app switcher (⌘Tab)" },
    { chord: 'Ctrl+Shift+Tab', why: "the Mac's app switcher (⇧⌘Tab)" },
    { chord: 'Ctrl+Space', why: 'Spotlight on a Mac (⌘Space)' },
    { chord: 'Control+Space', why: "the Mac's input source switch (⌃Space)" },
    { chord: 'Ctrl+Q', why: 'Quit on a Mac (⌘Q)' },
    { chord: 'Ctrl+H', why: 'Hide on a Mac (⌘H)' },
    { chord: 'Ctrl+M', why: 'Minimize on a Mac (⌘M)' },
    { chord: 'Ctrl+`', why: "the Mac's next-window key (⌘`)" },
    { chord: 'Ctrl+Shift+`', why: "the Mac's previous-window key (⇧⌘`)" },
    { chord: 'Ctrl+Shift+3', why: "a Mac's screenshot key (⇧⌘3)" },
    { chord: 'Ctrl+Shift+4', why: "a Mac's screenshot key (⇧⌘4)" },
    { chord: 'Ctrl+Shift+5', why: "a Mac's screenshot key (⇧⌘5)" },
    { chord: 'Control+ArrowUp', why: 'Mission Control on a Mac (⌃↑)' },
    { chord: 'Control+ArrowDown', why: 'App Exposé on a Mac (⌃↓)' },
    { chord: 'Control+ArrowLeft', why: "a Mac's switch-space key (⌃←)" },
    { chord: 'Control+ArrowRight', why: "a Mac's switch-space key (⌃→)" },
  ],
  windows: [
    { chord: 'Alt+Tab', why: "Windows' app switcher" },
    { chord: 'Alt+Shift+Tab', why: "Windows' app switcher" },
    { chord: 'Ctrl+Alt+Tab', why: "Windows' sticky app switcher" },
    { chord: 'Alt+F4', why: 'Close window in Windows' },
    { chord: 'Alt+Space', why: "the window menu in Windows (Trove's Spotlight default too)" },
  ],
  linux: [
    { chord: 'Alt+Tab', why: "the Linux desktop's app switcher" },
    { chord: 'Alt+Shift+Tab', why: "the Linux desktop's app switcher" },
    { chord: 'Alt+F4', why: 'Close window on the Linux desktop' },
    { chord: 'Alt+F2', why: "GNOME's run-a-command box" },
    { chord: 'Alt+Space', why: "GNOME's window menu" },
    { chord: 'Ctrl+Alt+T', why: "Ubuntu's open-a-terminal key" },
    { chord: 'Ctrl+Alt+ArrowLeft', why: "GNOME's switch-workspace key" },
    { chord: 'Ctrl+Alt+ArrowRight', why: "GNOME's switch-workspace key" },
    { chord: 'Ctrl+Alt+ArrowUp', why: "GNOME's switch-workspace key" },
    { chord: 'Ctrl+Alt+ArrowDown', why: "GNOME's switch-workspace key" },
  ],
};

/** The file list's own keys with a modifier (`hooks/use-file-list`): never in the window table. */
const LIST_KEYS: readonly PlatformCommand[] = [
  'open',
  'delete',
  'deletePermanently',
  'revealInFolder',
];

/** A palette action's name as Settings ▸ Keyboard lists it. */
export const actionLabel = (id: string): string =>
  paletteActions.find((a) => a.key === id)?.label ?? id;

/** A window-table row as a chord string (`Control+Ctrl+1`, `Ctrl+Shift+H`). */
export const rowChord = (s: Shortcut): string => {
  const mods: string[] = [];
  if (s.keepCtrl === true) {
    mods.push('Control');
    if (s.meta === true) mods.push('Ctrl');
  } else if (s.ctrl === true || s.meta === true) mods.push('Ctrl');
  if (s.alt === true) mods.push('Alt');
  if (s.shift === true) mods.push('Shift');
  const key = s.key.length === 1 ? s.key.toUpperCase() : s.key;
  return [...mods, key].join('+');
};

interface Where {
  style?: OsStyle;
  host?: OsStyle;
  overrides?: Readonly<Record<string, string>>;
}

/**
 * Why `chord` cannot be `id`'s, in words, or null when it can: a key the host or the style's
 * system keeps (`RESERVED_CHORDS`), or a key another command already answers in the current
 * style — another action (its override included), a built-in window chord, or a file-list key.
 */
export const rebindRefusal = (id: string, chord: string, where: Where = {}): string | null => {
  const style = where.style ?? comingFrom.style;
  const host = where.host ?? hostStyle();
  const overrides = where.overrides ?? settings.shortcutOverrides;
  const mac = host === 'mac';
  const sig = chordSignature(chord, mac);
  const shown = keyLabel(chord, mac);
  const same = (other: string) => chordSignature(other, mac) === sig;

  const reserved = [...RESERVED_CHORDS[host], ...(style === host ? [] : RESERVED_CHORDS[style])];
  const kept = reserved.find((r) => same(r.chord));
  if (kept) return `${shown} is ${kept.why}. Pick another key.`;

  const others = Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== id));
  const table = shortcutTable(mac, style, host === 'linux', others);
  const hit = table.find((s) => (s.id !== id || s.rebindKeeps === true) && same(rowChord(s)));
  if (hit) {
    const name = hit.rebindKeeps
      ? 'Properties'
      : hit.id !== undefined
        ? actionLabel(hit.id)
        : 'a built-in Trove shortcut';
    return `${shown} is already ${name}. Pick another key, or change that one first.`;
  }
  for (const listId of LIST_OWNED) {
    const c = actionChord(listId, style, host, others);
    if (c !== null && same(c))
      return `${shown} is already ${actionLabel(listId)} in the file list.`;
  }
  for (const cmd of LIST_KEYS) {
    if (same(platformChord(cmd, style, host))) {
      return `${shown} is already a file-list key. Pick another key.`;
    }
  }
  return null;
};

/** Whether the person has their own chord for `id`. */
export const isOverridden = (id: string): boolean => Object.hasOwn(settings.shortcutOverrides, id);

/** Back to the style's chord for one action. */
export const resetChord = (id: string): void => {
  if (!isOverridden(id)) return;
  const next = { ...settings.shortcutOverrides };
  delete next[id];
  settings.shortcutOverrides = next;
};

/** Back to the style's chord for every action. */
export const resetAllChords = (): void => {
  settings.shortcutOverrides = {};
};

/**
 * The recorder pressed `recorded` (`ctrl+shift+h`) for `id`: saved, or the reason it was not
 * (nothing is saved then). The action's own default is a reset, not an override.
 */
export const rebind = (id: string, recorded: string, where: Where = {}): string | null => {
  const style = where.style ?? comingFrom.style;
  const host = where.host ?? hostStyle();
  const made = fromRecorded(recorded, host === 'mac');
  if ('refused' in made) return made.refused;
  const own = defaultChord(id, style, host);
  if (
    own !== null &&
    chordSignature(own, host === 'mac') === chordSignature(made.chord, host === 'mac')
  ) {
    resetChord(id);
    return null;
  }
  const why = rebindRefusal(id, made.chord, { ...where, style, host });
  if (why !== null) return why;
  settings.shortcutOverrides = { ...settings.shortcutOverrides, [id]: made.chord };
  return null;
};

/** The actions Settings ▸ Keyboard lists, in the palette's order. */
export const keyboardActions = (): string[] =>
  paletteActions.map((a) => a.key).filter((k) => REBINDABLE_ACTIONS.includes(k));

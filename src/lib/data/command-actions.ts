// The toolbar's own buttons, as data: the "+ New" button, the search filters, and the right end
// (Details pane, Settings). Plan 12 G.1 dropped Explorer's command bar; its other commands live
// in the right-click menus, the palette and the keyboard (`command-actions.test.ts` lists where).
// `kind` decides the rendering: labelled buttons carry text and a chevron, icon buttons are
// squares, dividers are 1px rules. `enabled` is read live.
import type { GlyphName } from '$lib/data/glyphs';
import { panes } from '$lib/state/panes.svelte';
import { settingsDialog } from '$lib/state/settings-dialog.svelte';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import { actions } from '$lib/state/actions.svelte';
import { newMenu } from '$lib/data/menus';
import { searchChipItems } from '$lib/data/search-chips';
import { search } from '$lib/state/search.svelte';
import { commandHint, keyLabel } from '$lib/utils/key-label';

interface Base {
  key: string;
  /** static, or a closure read live (the search chips say which preset is picked) */
  label: string | (() => string);
  glyph: GlyphName;
  run?: () => unknown;
  enabled?: () => boolean;
  /** a toggle that is currently on (the Details pane button), read live */
  active?: () => boolean;
  /** how many things a menu button is narrowing by (Filters); spoken in its name, never as a toggle */
  activeCount?: () => number;
}

export type CommandItem =
  | { kind: 'divider'; key: string }
  | ({ kind: 'labelled'; menu?: MenuItem[] } & Base)
  | ({ kind: 'icon'; menu?: MenuItem[] } & Base);

/** The text a command shows right now. */
export const labelOf = (item: Exclude<CommandItem, { kind: 'divider' }>) =>
  typeof item.label === 'function' ? item.label() : item.label;

/** The name a screen reader hears: "Filters, 2 active" when a menu button has settings on. */
export const accessibleName = (item: Exclude<CommandItem, { kind: 'divider' }>) => {
  const n = item.activeCount?.() ?? 0;
  return n > 0 ? `${labelOf(item)}, ${n} active` : labelOf(item);
};

export const isEnabled = (item: CommandItem) =>
  item.kind !== 'divider' &&
  (item.run !== undefined || item.menu !== undefined) &&
  (item.enabled?.() ?? true);

/** "+ New": the one command-bar button that kept a button — Folder, Text Document, … */
export const newCommand: CommandItem = {
  kind: 'labelled',
  key: 'new',
  label: 'New',
  glyph: 'add',
  menu: newMenu,
  enabled: () => actions.inFolder,
};

/** One search chip's radio menu, by its key in `data/search-chips`. */
const chipMenu = (key: string): MenuItem[] => {
  const chip = searchChipItems.find((c) => c.key === key);
  return chip && chip.kind !== 'divider' ? (chip.menu ?? []) : [];
};

/**
 * While a search is on, "+ New" gives its place to one Filters button: the Kind / Date modified /
 * Size chips the command bar used to line up, as flyouts of one menu, so the toolbar stays one
 * fixed width at 800px whatever the chips' labels say.
 */
export const filterCommand: CommandItem = {
  kind: 'labelled',
  key: 'filters',
  label: 'Filters',
  glyph: 'sort',
  // a menu button, not a toggle: the chips in force are said in its name ("Filters, 2 active")
  active: () => Object.values(search.chips).some((v) => v !== null),
  activeCount: () => Object.values(search.chips).filter((v) => v !== null).length,
  menu: [
    { kind: 'submenu', key: 'chip-kind', label: 'Kind', items: chipMenu('chip-kind') },
    {
      kind: 'submenu',
      key: 'chip-modified',
      label: 'Date modified',
      items: chipMenu('chip-modified'),
    },
    { kind: 'submenu', key: 'chip-size', label: 'Size', items: chipMenu('chip-size') },
  ],
};

/**
 * The right end of the toolbar. The gear is a second door to the same dialog the palette and
 * `Ctrl+,` open — Windows 11's Explorer hides settings behind the overflow menu alone and it is
 * one of the loudest complaints about it, so that is a mistake to drop, not parity to keep. A
 * gear is the one settings affordance nobody has to learn, and the tooltip carries `Ctrl+,` (VS
 * Code's and Zed's convention, already live in `data/shortcuts`) because a chord nobody can see
 * is a chord nobody uses.
 */
export const commandTrailing: CommandItem[] = [
  {
    kind: 'icon',
    key: 'details',
    get label() {
      return `Details pane (${commandHint('detailsPane')})`;
    },
    glyph: 'details',
    run: () => panes.toggle('details'),
    active: () => panes.isOpen('details'),
  },
  {
    kind: 'icon',
    key: 'settings',
    label: `Settings (${keyLabel('Ctrl+,')})`,
    glyph: 'settings',
    run: () => settingsDialog.show(),
  },
];

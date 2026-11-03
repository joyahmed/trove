// The toolbar's "…" menu (plan 15 G.73): whatever a narrow window took off the toolbar, as menu
// rows. One list, each row visible only while its part has given way (`utils/toolbar-fit`), so the
// menu never offers a button that is still on screen.
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import { commandTrailing, labelOf, type CommandItem } from '$lib/data/command-actions';
import { viewFlyout } from '$lib/data/menus';
import { findAnythingHint } from '$lib/data/shortcuts';
import { findAnything } from '$lib/hooks/use-palette.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { commandHint } from '$lib/utils/key-label';
import { onMac } from '$lib/utils/platform';
import type { ToolbarPart } from '$lib/utils/toolbar-fit';

/** "Details pane (Alt+P)" → the row's label and its shortcut column, as a menu shows them. */
export const splitHint = (label: string): { label: string; shortcut?: string } => {
  const m = /^(.*) \(([^()]+)\)$/.exec(label);
  return m ? { label: m[1], shortcut: m[2] } : { label };
};

/** A toolbar button as a menu row: same glyph, same action, its on/off as a checkmark. */
const asRow = (item: Exclude<CommandItem, { kind: 'divider' }>, visible: () => boolean) => {
  const text = () => splitHint(labelOf(item));
  return {
    kind: 'item',
    key: item.key,
    get label() {
      return text().label;
    },
    get shortcut() {
      return text().shortcut;
    },
    glyph: item.glyph,
    checked: item.active,
    visible,
    run: () => item.run?.(),
  } satisfies MenuItem;
};

/** The "…" menu's rows; `collapsed` says which parts have left the toolbar, read live. */
export const toolbarOverflowItems = (collapsed: (part: ToolbarPart) => boolean): MenuItem[] => [
  {
    kind: 'item',
    key: 'refresh',
    label: 'Refresh',
    glyph: 'refresh',
    get shortcut() {
      return commandHint('refresh');
    },
    visible: () => collapsed('refresh'),
    run: () => tabs.active.refresh(),
  },
  // the search box gave way: the palette is the search that needs no room on the toolbar
  {
    kind: 'item',
    key: 'find-anything',
    label: 'Find anything',
    glyph: 'search',
    shortcut: findAnythingHint(onMac()),
    visible: () => collapsed('search'),
    run: () => findAnything.show(),
  },
  { ...viewFlyout, visible: () => collapsed('view') },
  ...commandTrailing.flatMap((item) =>
    item.kind === 'divider' ? [] : [asRow(item, () => collapsed('trailing'))],
  ),
];

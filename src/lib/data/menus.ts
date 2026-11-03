// The shared menus, as data: the + New button's, the right-click menus' flyouts, the folder
// header's Sort, and the old command bar's See more list. Read live through closures so checks follow state.
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import type { ArchiveFormat } from '$lib/types/archive';
import { REQUIRED_COLUMN, fileColumns, isGroupKey, type SortKey } from '$lib/data/file-columns';
import { newItemKinds } from '$lib/data/new-items';
import { knownKeyOf } from '$lib/data/sidebar-sections';
import { zoomItems } from '$lib/data/zoom-items';
import { actions } from '$lib/state/actions.svelte';
import { settingsDialog } from '$lib/state/settings-dialog.svelte';
import { undo } from '$lib/state/undo.svelte';
import { listing } from '$lib/state/listing.svelte';
import { panes } from '$lib/state/panes.svelte';
import { selection } from '$lib/state/selection.svelte';
import { settings } from '$lib/state/settings.svelte';
import {
  explorerViewOrder,
  isStep,
  stepGlyph,
  stepIconSize,
  stepLabel,
  type ViewStep,
} from '$lib/utils/view-steps';
import { tabs } from '$lib/state/tabs.svelte';
import { terminal } from '$lib/state/terminal.svelte';
import { commandHint, hiddenItemsHint, keyLabel } from '$lib/utils/key-label';
import { propertiesLabel } from '$lib/utils/platform';
import { opensAsFolder } from '$lib/utils/app-bundle';

const sortItem = (key: SortKey, label: string): MenuItem => ({
  kind: 'item',
  key,
  label,
  checked: () => tabs.active.sortKey === key,
  run: () => tabs.active.sortBy(key),
});

const groupItem = (key: SortKey | null, label: string): MenuItem => ({
  kind: 'item',
  key: `group-${key ?? 'none'}`,
  label,
  checked: () => tabs.active.groupKey === key,
  run: () => tabs.active.groupBy(key),
});

/** The columns you can sort on. `fileColumns` is already the set — Folder is search's alone. */
export const sortKeyItems: MenuItem[] = fileColumns.map((c) => sortItem(c.key, c.label));

/** Explorer's Ascending / Descending pair, which *set* the direction rather than flip it. */
export const sortDirItems: MenuItem[] = [
  {
    kind: 'item',
    key: 'asc',
    label: 'Ascending',
    checked: () => tabs.active.sortDir === 'asc',
    run: () => tabs.active.setSortDir('asc'),
  },
  {
    kind: 'item',
    key: 'desc',
    label: 'Descending',
    checked: () => tabs.active.sortDir === 'desc',
    run: () => tabs.active.setSortDir('desc'),
  },
];

/**
 * The Group by rows, Explorer's own: the groupable columns, then "(None)". `null` is a real
 * choice, not an absence, so it gets a row — without it, grouping could be turned on and never
 * off, which is what would make the Downloads seed a trap instead of a convenience.
 */
export const groupKeyItems: MenuItem[] = [
  ...fileColumns.filter((c) => isGroupKey(c.key)).map((c) => groupItem(c.key, c.label)),
  { kind: 'divider', key: 'd-none' },
  groupItem(null, '(None)'),
];

/** "Compress to ▸": one row per format; each starts the same archive job with its format. */
const compressRow = (key: string, label: string, format: ArchiveFormat): MenuItem => ({
  kind: 'item',
  key,
  label,
  enabled: () => actions.hasSelection,
  run: () => actions.compress(format),
});
export const compressToFlyout: MenuItem = {
  kind: 'submenu',
  key: 'compress-to',
  label: 'Compress to',
  // greyed with nothing to compress: no selection, or inside an archive (read-only, no real paths)
  enabled: () => actions.hasSelection,
  items: [
    compressRow('compress', 'ZIP file', 'zip'),
    compressRow('compress-7z', '7z file', '7z'),
    compressRow('compress-tar-gz', 'tar.gz file', 'tar.gz'),
    compressRow('compress-tar-xz', 'tar.xz file', 'tar.xz'),
    compressRow('compress-tar-zst', 'tar.zst file', 'tar.zst'),
  ],
};

/** "Group by ▸" — the one row that stands for all of `groupKeyItems`, shared by both menus. */
export const groupByFlyout: MenuItem = {
  kind: 'submenu',
  key: 'group-by',
  label: 'Group by',
  items: groupKeyItems,
};

/** "Sort by ▸": the columns and the direction. Grouping hangs off its own row, as Explorer's. */
export const sortByFlyout: MenuItem = {
  kind: 'submenu',
  key: 'sort-by',
  label: 'Sort by',
  glyph: 'sort',
  items: [...sortKeyItems, { kind: 'divider', key: 'd' }, ...sortDirItems],
};

export const sortMenu: MenuItem[] = [
  ...sortKeyItems,
  { kind: 'divider', key: 'd' },
  ...sortDirItems,
  { kind: 'divider', key: 'd-group' },
  groupByFlyout,
];

/**
 * The details header's right-click menu: which columns show, as Explorer's does. Name is
 * listed but never off — there is no list without it.
 */
export const columnsMenu: MenuItem[] = fileColumns.map((c) => ({
  kind: 'item',
  key: `col-${c.key}`,
  label: c.label,
  checked: () => settings.columns.includes(c.key),
  enabled: () => c.key !== REQUIRED_COLUMN,
  run: () => settings.toggleColumn(c.key),
}));

const viewItem = (step: ViewStep): MenuItem => ({
  kind: 'item',
  key: `${step.view}-${step.iconSize}`,
  label: stepLabel(step),
  glyph: stepGlyph(step),
  checked: () => isStep(step, tabs.active),
  run: () => tabs.active.setView(step.view, stepIconSize(step)),
});

/** Explorer's eight views as radio checks, biggest first — the toolbar's view switch and the context menu. */
export const viewModeItems: MenuItem[] = explorerViewOrder.map(viewItem);

/**
 * Explorer's "View ▸" on empty space: the eight views as one flyout, so the right-click menu
 * grows by one line rather than eight. The toolbar's overflow "…" hangs the same flyout.
 */
export const viewFlyout: MenuItem = {
  kind: 'submenu',
  key: 'view',
  label: 'View',
  glyph: 'view',
  items: viewModeItems,
};

export const showHiddenItem: MenuItem = {
  kind: 'item',
  key: 'hidden',
  label: 'Show hidden items',
  glyph: 'showHidden',
  get shortcut() {
    return hiddenItemsHint();
  },
  checked: () => settings.showHidden,
  run: () => (settings.showHidden = !settings.showHidden),
};

/** The right-side panes as radio-like checks: opening one closes the other. */
export const paneItems: MenuItem[] = [
  {
    kind: 'item',
    key: 'preview-pane',
    label: 'Preview pane',
    shortcut: keyLabel('Alt+P'),
    checked: () => panes.isOpen('preview'),
    run: () => panes.toggle('preview'),
  },
  {
    kind: 'item',
    key: 'details-pane',
    label: 'Details pane',
    // off a Mac the chord is Properties' too, and the Properties row beside it keeps the hint
    get shortcut() {
      const hint = commandHint('detailsPane');
      return hint === commandHint('properties') ? undefined : hint;
    },
    checked: () => panes.isOpen('details'),
    run: () => panes.toggle('details'),
  },
  {
    kind: 'item',
    key: 'terminal-pane',
    label: 'Terminal pane',
    glyph: 'terminal',
    shortcut: keyLabel('Ctrl+`'),
    checked: () => terminal.open,
    run: () => terminal.toggle(),
  },
];

/** New → Folder / Text Document / …: the + New button's menu, from `data/new-items`. */
export const newMenu: MenuItem[] = newItemKinds.map((kind, i) => ({
  kind: 'item',
  key: kind.key,
  label: kind.label,
  glyph: kind.glyph,
  shortcut: i === 0 ? keyLabel('Ctrl+Shift+N') : undefined,
  enabled: () => actions.inFolder,
  run: () => actions.newItem(kind),
}));

/** "New ▸" — the same rows as the + New button, hung off the empty-space right-click menu. */
export const newFlyout: MenuItem = {
  kind: 'submenu',
  key: 'new',
  label: 'New',
  glyph: 'newItem',
  items: newMenu,
};

/**
 * The folder a pin action targets: the one selected folder, else the current folder; null
 * on Home / This PC, where there is no folder to pin.
 */
const pinTarget = (): string | null => {
  if (!tabs.active.isFolder) return null;
  const [only] = [...selection.paths];
  const entry = selection.count === 1 ? listing.rows.find((e) => e.path === only) : undefined;
  // a Mac's `X.app` is not a folder to pin: like a file, it leaves the current folder the target
  return entry && opensAsFolder(entry) ? entry.path : tabs.active.path;
};
const pinTargetPinned = () => {
  const target = pinTarget();
  return target !== null && settings.pins.includes(target);
};
const togglePinTarget = () => {
  const target = pinTarget();
  if (target !== null) settings.togglePin(target, knownKeyOf(target));
};

/** The rows on screen — folded groups are left out, as Ctrl+A leaves them. */
const allRows = () => listing.shown.map((e) => e.path);

/**
 * The old command bar's "See more" menu, in Explorer's order (now under More ▸, `moreFlyout`): Undo / Redo · Pin, Compress, Extract here, Copy as path,
 * Properties · Refresh, Show hidden · Select all / none / Invert · Open in Terminal · the
 * app's own switches · the way back after unpinning built-ins · Text size.
 */
export const moreMenu: MenuItem[] = [
  {
    kind: 'item',
    key: 'undo',
    // getters: the row names what it reverses ("Undo Rename"), live as the stack changes
    get label() {
      return undo.undoLabel;
    },
    glyph: 'undo',
    shortcut: keyLabel('Ctrl+Z'),
    enabled: () => undo.canUndo,
    run: actions.undo,
  },
  {
    kind: 'item',
    key: 'redo',
    get label() {
      return undo.redoLabel;
    },
    glyph: 'redo',
    get shortcut() {
      return commandHint('redo');
    },
    enabled: () => undo.canRedo,
    run: actions.redo,
  },
  { kind: 'divider', key: 'd0' },
  {
    kind: 'item',
    key: 'pin',
    label: 'Pin to sidebar',
    glyph: 'pinTo',
    enabled: () => pinTarget() !== null && !pinTargetPinned(),
    run: togglePinTarget,
  },
  {
    kind: 'item',
    key: 'unpin',
    label: 'Unpin from sidebar',
    glyph: 'unpin',
    enabled: pinTargetPinned,
    run: togglePinTarget,
  },
  compressToFlyout,
  {
    kind: 'item',
    key: 'extract-here',
    label: 'Extract here',
    enabled: () => actions.canExtractHere,
    run: actions.extractHere,
  },
  {
    kind: 'item',
    key: 'copy-path',
    label: 'Copy as path',
    shortcut: keyLabel('Ctrl+Shift+C'),
    enabled: () => actions.hasSelection,
    run: actions.copyAsPath,
  },
  {
    kind: 'item',
    key: 'properties',
    get label() {
      return propertiesLabel();
    },
    get shortcut() {
      return commandHint('properties');
    },
    checked: () => panes.isOpen('details'),
    run: () => panes.toggle('details'),
  },
  { kind: 'divider', key: 'd-view' },
  {
    kind: 'item',
    key: 'refresh',
    label: 'Refresh',
    glyph: 'refresh',
    get shortcut() {
      return commandHint('refresh');
    },
    run: () => tabs.active.refresh(),
  },
  showHiddenItem,
  { kind: 'divider', key: 'd' },
  {
    kind: 'item',
    key: 'select-all',
    label: 'Select all',
    shortcut: keyLabel('Ctrl+A'),
    enabled: () => actions.inFolder,
    run: () => selection.selectAll(allRows()),
  },
  {
    kind: 'item',
    key: 'select-none',
    label: 'Select none',
    enabled: () => actions.hasSelection,
    run: () => selection.clear(),
  },
  {
    kind: 'item',
    key: 'invert-selection',
    label: 'Invert selection',
    enabled: () => actions.inFolder,
    run: () => selection.invert(allRows()),
  },
  { kind: 'divider', key: 'd-terminal' },
  {
    kind: 'item',
    key: 'terminal',
    label: 'Open in Terminal',
    glyph: 'terminal',
    enabled: () => actions.inFolder,
    run: actions.openTerminal,
  },
  { kind: 'divider', key: 'd-settings' },
  {
    kind: 'item',
    key: 'settings',
    label: 'Settings…',
    shortcut: keyLabel('Ctrl+,'),
    run: () => settingsDialog.show(),
  },
  { kind: 'divider', key: 'd-zoom' },
  ...zoomItems,
];

/**
 * "More ▸" at the foot of the empty-space right-click menu: the right-side panes, then the whole
 * "See more" list above. It is where the dropped command bar's View panes and `…` menu went
 * (plan 12 G.1, D4), so the two cannot drift apart.
 */
export const moreFlyout: MenuItem = {
  kind: 'submenu',
  key: 'more',
  label: 'More',
  glyph: 'more',
  items: [...paneItems, { kind: 'divider', key: 'd-more' }, ...moreMenu],
};

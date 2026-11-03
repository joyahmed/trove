// The Recycle Bin row's right-click menu and its header actions, as data. The handlers come
// in from the hook so this stays data.
import { binName } from '$lib/utils/platform';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import type { GlyphName } from '$lib/data/glyphs';
import { commandHint } from '$lib/utils/key-label';

export interface RecycleMenuHandlers {
  restore: () => unknown;
  purge: () => unknown;
  openLocation: () => unknown;
}

/** For the selected rows (the right-clicked row joins the selection first). */
export const recycleMenuFor = (count: number, on: RecycleMenuHandlers): MenuItem[] => [
  {
    kind: 'item',
    key: 'restore',
    label: count > 1 ? `Restore ${count} items` : 'Restore',
    glyph: 'undo',
    run: on.restore,
  },
  {
    kind: 'item',
    key: 'open-location',
    label: 'Open original location',
    glyph: 'folder',
    visible: () => count === 1,
    run: on.openLocation,
  },
  { kind: 'divider', key: 'd1' },
  {
    kind: 'item',
    key: 'purge',
    label: 'Delete permanently',
    glyph: 'delete',
    shortcut: commandHint('binPurge'),
    run: on.purge,
  },
];

export interface RecycleHeaderAction {
  key: string;
  label: string;
  glyph: GlyphName;
  /** the destructive one is styled red */
  danger: boolean;
  run: () => unknown;
}

/** Explorer's "Manage" ribbon for the bin, as two buttons. */
export const recycleHeaderActions = (on: {
  empty: () => unknown;
  restoreAll: () => unknown;
}): RecycleHeaderAction[] => [
  { key: 'empty', label: `Empty ${binName()}`, glyph: 'delete', danger: true, run: on.empty },
  {
    key: 'restore-all',
    label: 'Restore all items',
    glyph: 'undo',
    danger: false,
    run: on.restoreAll,
  },
];

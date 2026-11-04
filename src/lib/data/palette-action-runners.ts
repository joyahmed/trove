// The main-window side of data/palette-actions.ts: what each key does, read live through
// closures like every other data file.
import { newItemKinds } from '$lib/data/new-items';
import { arrangeWindows } from '$lib/data/window-menu';
import { actions } from '$lib/state/actions.svelte';
import { listing } from '$lib/state/listing.svelte';
import { panes } from '$lib/state/panes.svelte';
import { selection } from '$lib/state/selection.svelte';
import { settings } from '$lib/state/settings.svelte';
import { settingsDialog } from '$lib/state/settings-dialog.svelte';
import { tabSets } from '$lib/state/tab-sets.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { undoHistory } from '$lib/state/undo-history.svelte';
import { TAB_SET_VERBS, tabSetActionKey } from '$lib/utils/tab-sets';
import { HOME, RECYCLE_BIN, THIS_PC } from '$lib/utils/location';

export const paletteActionRunners: Record<string, () => unknown> = {
  'new-tab': () => tabs.open(),
  'new-folder': () => actions.newFolder(),
  'toggle-hidden': () => (settings.showHidden = !settings.showHidden),
  'open-terminal': () => actions.openTerminal(),
  'open-this-pc': () => tabs.active.navigate(THIS_PC),
  'open-home': () => tabs.active.navigate(HOME),
  'open-recycle-bin': () => tabs.active.navigate(RECYCLE_BIN),
  'new-text-file': () =>
    actions.newItem(newItemKinds.find((k) => k.key === 'text') ?? newItemKinds[0]),
  cut: () => actions.cut(),
  copy: () => actions.copy(),
  paste: () => actions.paste(),
  'paste-paths-terminal': () => actions.pastePathsIntoTerminal(),
  rename: () => actions.startRename(),
  undo: () => actions.undo(),
  redo: () => actions.redo(),
  'undo-history': () => undoHistory.show(),
  'select-all': () => selection.selectAll(listing.shown.map((e) => e.path)),
  'invert-selection': () => selection.invert(listing.rows.map((e) => e.path)),
  'sort-name': () => tabs.active.sortTo('name'),
  'sort-modified': () => tabs.active.sortTo('modifiedMs'),
  'sort-size': () => tabs.active.sortTo('size'),
  'sort-type': () => tabs.active.sortTo('ext'),
  'view-icons': () => tabs.active.setView('grid'),
  'view-list': () => tabs.active.setView('list'),
  // a place has no files to show as a gallery (plan 15 G.52)
  'view-gallery': () => {
    if (tabs.active.isFolder) tabs.active.setView('gallery');
  },
  'view-details': () => tabs.active.setView('details'),
  'view-small-icons': () => tabs.active.setView('small'),
  'view-tiles': () => tabs.active.setView('tiles'),
  'view-content': () => tabs.active.setView('content'),
  'toggle-details': () => panes.toggle('details'),
  'cascade-windows': () => arrangeWindows('cascade'),
  'stack-windows': () => arrangeWindows('stacked'),
  'windows-side-by-side': () => arrangeWindows('side-by-side'),
  'save-tab-set': () => tabSets.saveAs(),
  'open-settings': () => settingsDialog.show(),
};

/** What a palette key runs: a fixed action, or one of a saved tab set's rows. */
export const runPaletteAction = (key: string) => {
  const fixed = paletteActionRunners[key];
  if (fixed) return fixed();
  for (const verb of TAB_SET_VERBS) {
    const prefix = tabSetActionKey(verb, '');
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    if (verb === 'open') return tabSets.open(name);
    if (verb === 'rename') return tabSets.rename(name);
    return tabSets.remove(name);
  }
};

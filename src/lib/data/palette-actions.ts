// The explorer's own actions as palette rows — the list both windows share. The palette shows
// them and emits the key; the main window maps the key to a call (data/palette-action-runners).
import { binName } from '$lib/utils/platform';
import type { GlyphName } from '$lib/data/glyphs';
import { locationLabel, THIS_PC } from '$lib/utils/location';

export interface PaletteAction {
  key: string;
  label: string;
  glyph: GlyphName;
  /** extra words that should also find it */
  keywords: string;
}

export const paletteActions: PaletteAction[] = [
  { key: 'new-tab', label: 'New tab', glyph: 'add', keywords: 'tab open' },
  { key: 'new-folder', label: 'New folder here', glyph: 'newItem', keywords: 'create directory' },
  {
    key: 'toggle-hidden',
    label: 'Toggle hidden files',
    glyph: 'showHidden',
    keywords: 'show hide',
  },
  {
    key: 'open-terminal',
    label: 'Open terminal here',
    glyph: 'terminal',
    keywords: 'shell console',
  },
  {
    key: 'open-this-pc',
    // getters: the word follows "I'm coming from" live (plan 19, 1.4.2)
    get label() {
      return `Open ${locationLabel(THIS_PC)}`;
    },
    glyph: 'thisPc',
    keywords: 'drives computer',
  },
  { key: 'open-home', label: 'Open Home', glyph: 'home', keywords: 'quick access start' },
  {
    key: 'open-recycle-bin',
    get label() {
      return `Open ${binName()}`;
    },
    glyph: 'delete',
    keywords: 'trash deleted restore',
  },
  // ⭐ What Explorer's command bar held before plan 12 G.1 dropped it (D4): every one of these is
  // also on a right-click menu or a key, and the palette is the door that needs neither.
  // ⛔ Delete is left out on purpose: the Spotlight window runs these against the main window's
  // selection, which may not be on screen, and a delete nobody saw selected is the wrong default.
  {
    key: 'new-text-file',
    label: 'New text document here',
    glyph: 'file',
    keywords: 'create file txt',
  },
  { key: 'cut', label: 'Cut', glyph: 'cut', keywords: 'move clipboard selection' },
  { key: 'copy', label: 'Copy', glyph: 'copy', keywords: 'duplicate clipboard selection' },
  { key: 'paste', label: 'Paste', glyph: 'paste', keywords: 'clipboard put here' },
  { key: 'rename', label: 'Rename', glyph: 'rename', keywords: 'name change f2' },
  { key: 'undo', label: 'Undo', glyph: 'undo', keywords: 'revert back' },
  { key: 'redo', label: 'Redo', glyph: 'redo', keywords: 'again forward' },
  { key: 'select-all', label: 'Select all', glyph: 'check', keywords: 'selection everything' },
  { key: 'invert-selection', label: 'Invert selection', glyph: 'check', keywords: 'select others' },
  { key: 'sort-name', label: 'Sort by name', glyph: 'sort', keywords: 'order arrange' },
  { key: 'sort-modified', label: 'Sort by date modified', glyph: 'sort', keywords: 'order newest' },
  { key: 'sort-size', label: 'Sort by size', glyph: 'sort', keywords: 'order largest' },
  { key: 'sort-type', label: 'Sort by type', glyph: 'sort', keywords: 'order kind extension' },
  {
    key: 'view-icons',
    label: 'View as icons',
    glyph: 'viewTiles',
    keywords: 'grid cards thumbnails',
  },
  { key: 'view-list', label: 'View as list', glyph: 'viewList', keywords: 'compact' },
  {
    key: 'view-gallery',
    label: 'View as gallery',
    glyph: 'gallery',
    keywords: 'photos pictures images thumbnails',
  },
  {
    key: 'view-details',
    label: 'View as details',
    glyph: 'viewDetails',
    keywords: 'table columns',
  },
  {
    key: 'view-small-icons',
    label: 'View as small icons',
    glyph: 'viewSmallIcons',
    keywords: 'compact grid',
  },
  { key: 'view-tiles', label: 'View as tiles', glyph: 'viewTiles', keywords: 'cards type size' },
  {
    key: 'view-content',
    label: 'View as content',
    glyph: 'viewContent',
    keywords: 'rows date modified size',
  },
  {
    key: 'toggle-details',
    label: 'Toggle details pane',
    glyph: 'details',
    keywords: 'properties info',
  },
  // the window arrange commands (plan 20); same words as data/window-menu ARRANGE_ROWS
  {
    key: 'cascade-windows',
    label: 'Cascade windows',
    glyph: 'restore',
    keywords: 'arrange layout overlap',
  },
  {
    key: 'stack-windows',
    label: 'Show windows stacked',
    glyph: 'viewList',
    keywords: 'arrange layout rows tile',
  },
  {
    key: 'windows-side-by-side',
    label: 'Show windows side by side',
    glyph: 'viewTiles',
    keywords: 'arrange layout columns tile',
  },
  {
    key: 'open-settings',
    label: 'Open settings',
    glyph: 'settings',
    keywords: 'preferences options',
  },
];

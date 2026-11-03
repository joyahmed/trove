import type { GlyphName } from '$lib/data/glyphs';
import type { ViewMode } from '$lib/state/settings.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { commandHint } from '$lib/utils/key-label';

export interface NavAction {
  key: string;
  label: string;
  glyph: GlyphName;
  run: () => unknown;
  enabled: () => boolean;
  /** the glyph turns while this is true (Refresh while it re-reads) */
  busy?: () => boolean;
}

// The toolbar's leading buttons are this array rendered once — CONTRIBUTING.md § 2. Every closure
// reads `tabs.active` at call time, so the buttons follow the active tab. Refresh stays a button
// (plan 12 G.1 weighed dropping it): F5 only works where the list or a place view has focus, and
// its turning glyph is the one sign that a slow folder is being re-read.
export const navActions: NavAction[] = [
  {
    key: 'back',
    get label() {
      return `Back (${commandHint('back')})`;
    },
    glyph: 'back',
    run: () => tabs.active.back(),
    enabled: () => tabs.active.canGoBack,
  },
  {
    key: 'forward',
    get label() {
      return `Forward (${commandHint('forward')})`;
    },
    glyph: 'forward',
    run: () => tabs.active.forward(),
    enabled: () => tabs.active.canGoForward,
  },
  {
    key: 'up',
    get label() {
      return `Up (${commandHint('up')})`;
    },
    glyph: 'up',
    run: () => tabs.active.up(),
    enabled: () => tabs.active.canGoUp,
  },
  {
    key: 'refresh',
    get label() {
      return `Refresh (${commandHint('refresh')})`;
    },
    glyph: 'refresh',
    run: () => tabs.active.refresh(),
    busy: () => tabs.active.refreshing,
    enabled: () => true,
  },
];

export interface ViewChoice {
  key: ViewMode;
  label: string;
  glyph: GlyphName;
  /** offered only in a real folder: Gallery needs files to show (plan 15 G.52) */
  folderOnly?: boolean;
}

/**
 * The toolbar's view switch, one press away (plan 12 G.1; Gallery plan 15 G.52). Picking Icons keeps the
 * icon size last chosen; the sizes themselves stay on the right-click menu's view rows and on
 * Explorer's Ctrl+Shift+1…8 (⌃⌘1…8 on a Mac), which the tooltips name.
 */
export const viewChoices: ViewChoice[] = [
  {
    key: 'grid',
    get label() {
      return `Icons (${commandHint('viewIcons')})`;
    },
    glyph: 'viewLargeIcons',
  },
  {
    key: 'list',
    get label() {
      return `List (${commandHint('viewList')})`;
    },
    glyph: 'viewList',
  },
  {
    key: 'details',
    get label() {
      return `Details (${commandHint('viewDetails')})`;
    },
    glyph: 'viewDetails',
  },
  {
    key: 'gallery',
    label: 'Gallery — the photos and videos as big thumbnails, by month',
    glyph: 'gallery',
    folderOnly: true,
  },
];

/** The switch's segments where you stand: Gallery only in a real folder (plan 15 G.52). */
export const viewChoicesFor = (isFolder: boolean): ViewChoice[] =>
  viewChoices.filter((c) => isFolder || !c.folderOnly);

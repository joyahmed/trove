// Explorer's eight views as one ladder: Content → Tiles → Details → List → Small icons → Medium
// icons → Large icons → Extra large icons. Ctrl+wheel walks it, the View menu lists it biggest
// first, and Ctrl+Shift+1…8 are its rungs in that same biggest-first order — Explorer's own.
// Gallery is not on the ladder. Pure; the hook decides the direction from the wheel and the
// settings take the result.
import type { GlyphName } from '$lib/data/glyphs';
import type { IconSize, ListViewMode, ViewMode } from '$lib/state/settings.svelte';

export interface ViewStep {
  /** Gallery is not a zoom step: Ctrl+wheel stays within the list views */
  view: ListViewMode;
  iconSize: IconSize;
}

/** Smallest to largest. `iconSize` is what the grid would use; the other views keep theirs. */
export const viewSteps: ViewStep[] = [
  { view: 'content', iconSize: 48 },
  { view: 'tiles', iconSize: 48 },
  { view: 'details', iconSize: 48 },
  { view: 'list', iconSize: 48 },
  { view: 'small', iconSize: 48 },
  { view: 'grid', iconSize: 48 },
  { view: 'grid', iconSize: 96 },
  { view: 'grid', iconSize: 256 },
];

/**
 * Biggest first: the order of Explorer's View menu, and of its chords — Ctrl+Shift+1 is Extra
 * large icons, 6 is Details, 8 is Content.
 */
export const explorerViewOrder: ViewStep[] = [...viewSteps].reverse();

/** `s` is the layout `current` shows: same view, and for the grid the same icon size too. */
export const isStep = (s: ViewStep, current: { view: ViewMode; iconSize: IconSize }): boolean =>
  s.view === current.view && (s.view !== 'grid' || s.iconSize === current.iconSize);

const indexOf = (s: { view: ViewMode; iconSize: IconSize }) =>
  viewSteps.findIndex((v) => isStep(v, s));

/** The icon size `setView` takes for a step: only a grid step names one. */
export const stepIconSize = (s: ViewStep): IconSize | undefined =>
  s.view === 'grid' ? s.iconSize : undefined;

/** One step bigger (`dir` > 0) or smaller; the ends clamp. A grid step keeps the icon size. */
export const stepView = (
  current: { view: ViewMode; iconSize: IconSize },
  dir: 1 | -1,
): ViewStep => {
  const i = Math.max(0, indexOf(current));
  const next = viewSteps[Math.min(viewSteps.length - 1, Math.max(0, i + dir))];
  return next.view === 'grid' ? next : { view: next.view, iconSize: current.iconSize };
};

const viewNames: Record<Exclude<ListViewMode, 'grid'>, string> = {
  content: 'Content',
  tiles: 'Tiles',
  details: 'Details',
  list: 'List',
  small: 'Small icons',
};

const gridNames: Record<IconSize, string> = {
  48: 'Medium icons',
  96: 'Large icons',
  256: 'Extra large icons',
};

/** Explorer's name for a step, for the View menu. */
export const stepLabel = (s: ViewStep): string =>
  s.view === 'grid' ? (gridNames[s.iconSize] ?? gridNames[48]) : viewNames[s.view];

const viewGlyphs: Record<ListViewMode, GlyphName> = {
  content: 'viewContent',
  tiles: 'viewTiles',
  details: 'viewDetails',
  list: 'viewList',
  small: 'viewSmallIcons',
  grid: 'viewLargeIcons',
};

/** The glyph a step's menu row and palette row draw. */
export const stepGlyph = (s: ViewStep): GlyphName => viewGlyphs[s.view];

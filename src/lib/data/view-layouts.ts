import { onMac } from '$lib/utils/platform';
import type { IconSize, ListViewMode, ViewMode } from '$lib/state/settings.svelte';

/**
 * How each view lays its items out, for the virtualizer. The list is cut into "chunks" along
 * the scroll axis — a row in details, a row of tiles in grid, a column in list — and only the
 * chunks in view are rendered. Sizes are the ones the row components declare in Tailwind, or
 * the tile geometry below for the grid, whose size follows the icon size.
 */
export interface ViewLayout {
  /** the list scrolls sideways (Explorer's list view) */
  horizontal: boolean;
  /** px one chunk occupies along the scroll axis */
  chunkSize: number;
  /**
   * px a group heading occupies along the scroll axis. A heading is a chunk of its own — it
   * spans the whole cross axis, so it cannot share a chunk with tiles — and in the grid it is
   * a different size from a row of tiles, which is why the virtualizer needs a plan rather
   * than one uniform `chunkSize`. 0 where the view does not group (the sideways list).
   */
  headerSize: number;
  /** px one item occupies across the scroll axis; 0 = one item per chunk */
  itemSpan: number;
  /** px before the first chunk (the container's top padding) */
  paddingStart: number;
  /** chunks rendered beyond the viewport on each side */
  overscan: number;
  /** utilities for the chunk wrapper */
  chunkClass: string;
}

/** One grid tile's box for an icon size: Explorer's Medium / Large / Extra large. */
export interface TileGeometry {
  icon: IconSize;
  /** tile width, px */
  width: number;
  /** tile height, px: card padding, the thumbnail box (icon + 16), a gap, a name line and a meta line */
  height: number;
  /** px between tiles */
  gap: number;
}

export const tileGeometries: Record<IconSize, TileGeometry> = {
  48: { icon: 48, width: 120, height: 128, gap: 4 },
  96: { icon: 96, width: 148, height: 168, gap: 4 },
  256: { icon: 256, width: 300, height: 328, gap: 4 },
};

export const tileGeometry = (size: IconSize): TileGeometry => tileGeometries[size];

/**
 * A grid group heading: the 28 px of a details heading plus 6 px of air above it, so a bucket
 * of tiles is not welded to the one before it. Fixed rather than scaled with the icon size —
 * the text is the same size at Medium and at Extra large.
 */
const GRID_HEADER_PX = 34;

/** Explorer's Tiles: one card, the icon beside three lines of text. */
export const TILES_CARD = { width: 256, height: 64, gap: 4, icon: 48 } as const;

/** Explorer's Content: one full-width row per item, two lines tall. */
export const CONTENT_ROW_PX = 52;

const gridLayout = (size: IconSize): ViewLayout => {
  const t = tileGeometry(size);
  return {
    horizontal: false,
    chunkSize: t.height + t.gap,
    headerSize: GRID_HEADER_PX,
    itemSpan: t.width + t.gap,
    paddingStart: 8,
    overscan: 2,
    chunkClass: 'flex gap-1',
  };
};

/** A details row: Explorer's 28 px, Finder's 24 px on a Mac. ⚠️ Mirrored in CSS by
 * `--spacing-row` under `[data-mac='file-list']` in `styles/mac/panes.css` — change both. */
export const DETAILS_ROW_PX = 28;
export const MAC_DETAILS_ROW_PX = 24;
export const detailsRowPx = (mac: boolean = onMac()): number =>
  mac ? MAC_DETAILS_ROW_PX : DETAILS_ROW_PX;

export const viewLayouts: Record<ListViewMode, ViewLayout> = {
  // FileRow: h-row (28 px; 24 px on a Mac, see layoutFor), full width
  details: {
    horizontal: false,
    chunkSize: 28,
    headerSize: 28,
    itemSpan: 0,
    paddingStart: 8,
    overscan: 6,
    chunkClass: 'w-full',
  },
  // FileListItem: h-[22px] w-56 (224 px) + gap-x-2 (8 px) between columns
  list: {
    horizontal: true,
    chunkSize: 232,
    headerSize: 0,
    itemSpan: 22,
    paddingStart: 0,
    overscan: 1,
    chunkClass: 'flex h-full flex-col',
  },
  // FileTile at Medium: 120 × 128 px + gap-1 (4 px)
  grid: gridLayout(48),
  // Small icons: the List view's FileListItem (224 × 22 px), but flowing across then down,
  // the gap-x-2 (8 px) between them as in List
  small: {
    horizontal: false,
    chunkSize: 22,
    headerSize: 28,
    itemSpan: 232,
    paddingStart: 8,
    overscan: 6,
    chunkClass: 'flex gap-x-2',
  },
  // FileCardTile: a 48 px icon beside the name, type and size, 256 × 64 px + gap-1 (4 px)
  tiles: {
    horizontal: false,
    chunkSize: TILES_CARD.height + TILES_CARD.gap,
    headerSize: GRID_HEADER_PX,
    itemSpan: TILES_CARD.width + TILES_CARD.gap,
    paddingStart: 8,
    overscan: 2,
    chunkClass: 'flex gap-1',
  },
  // FileContentRow: a full-width 52 px row — a 32 px icon, name and type, then date and size
  content: {
    horizontal: false,
    chunkSize: CONTENT_ROW_PX,
    headerSize: 28,
    itemSpan: 0,
    paddingStart: 8,
    overscan: 4,
    chunkClass: 'w-full',
  },
};

/** The layout for a view; the grid's depends on the icon size. */
export const layoutFor = (
  view: ViewMode,
  iconSize: IconSize,
  mac: boolean = onMac(),
): ViewLayout => {
  if (view === 'grid') return gridLayout(iconSize);
  // headerSize stays 28: a group heading is a chunk of its own and its button is 28 px tall.
  // Gallery is not drawn by the file list (`GalleryView`); a list still asked for it gets Details.
  if (view === 'details' || view === 'gallery')
    return { ...viewLayouts.details, chunkSize: detailsRowPx(mac) };
  return viewLayouts[view];
};

/**
 * How the arrow keys move in a layout: `rows` packs items across then down (the icon views,
 * Small icons, Tiles) so ← → step one and ↑ ↓ hop a row; `columns` packs them down then across
 * (List) so the hop is sideways; `single` is one item per line (Details, Content), ↑ ↓ only.
 */
export const arrowAxis = (layout: ViewLayout): 'rows' | 'columns' | 'single' =>
  layout.itemSpan === 0 ? 'single' : layout.horizontal ? 'columns' : 'rows';

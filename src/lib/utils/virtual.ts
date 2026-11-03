// Index math for the virtualized list: items ↔ chunks. Pure, so the hook stays thin.
import type { ViewLayout } from '$lib/data/view-layouts';

/** Items per chunk for a viewport of `width` × `height` content pixels. Never below 1. */
export const itemsPerChunk = (layout: ViewLayout, width: number, height: number): number => {
  if (layout.itemSpan === 0) return 1;
  const across = layout.horizontal ? height : width;
  return Math.max(1, Math.floor(across / layout.itemSpan));
};

/** How many chunks `count` items fill at `perChunk` each. */
export const chunkCount = (count: number, perChunk: number): number => Math.ceil(count / perChunk);

/** The chunk holding item `index`. */
export const chunkOf = (index: number, perChunk: number): number => Math.floor(index / perChunk);

/** The `[start, end)` item range of chunk `chunk`, clipped to `count`. */
export const chunkRange = (
  chunk: number,
  perChunk: number,
  count: number,
): [start: number, end: number] => [chunk * perChunk, Math.min(count, (chunk + 1) * perChunk)];

/**
 * One chunk of a grouped list. Grouping breaks the uniform math above: a heading spans the
 * whole cross axis, so it cannot share a chunk with the tiles beside it, and a bucket's last
 * row of tiles is usually short. So a grouped list is planned once — a chunk per heading, a
 * chunk per row of items within a bucket — and the virtualizer measures from the plan.
 */
export interface PlannedChunk {
  /** px from the start of the scroll axis, `paddingStart` included */
  offset: number;
  /** px this chunk occupies along the scroll axis */
  size: number;
  /** index of its first item in the rendered list */
  first: number;
  /** how many items it holds; 1 for a heading */
  count: number;
  /** a full-width group heading rather than a row of items */
  header: boolean;
}

/** The sizes a plan is laid out with — `ViewLayout`'s, named so the math stays testable. */
export interface PlanSizes {
  chunkSize: number;
  headerSize: number;
  paddingStart: number;
}

/**
 * Cut `total` rendered items into chunks: a heading alone in one, then up to `perChunk` items
 * from the same bucket in the next. A bucket never shares a chunk with its neighbour, which is
 * what keeps a heading at the start of its own row of tiles.
 */
export const planChunks = (
  total: number,
  perChunk: number,
  isHeaderAt: (index: number) => boolean,
  { chunkSize, headerSize, paddingStart }: PlanSizes,
): PlannedChunk[] => {
  const per = Math.max(1, perChunk);
  const plan: PlannedChunk[] = [];
  let offset = paddingStart;
  let i = 0;
  while (i < total) {
    if (isHeaderAt(i)) {
      plan.push({ offset, size: headerSize, first: i, count: 1, header: true });
      offset += headerSize;
      i += 1;
      continue;
    }
    let n = 1;
    while (n < per && i + n < total && !isHeaderAt(i + n)) n++;
    plan.push({ offset, size: chunkSize, first: i, count: n, header: false });
    offset += chunkSize;
    i += n;
  }
  return plan;
};

/**
 * The chunk holding item `index`, by binary search on `first` — the plan is ascending and a
 * grouped 100k-entry folder has 100k of them, so a scan per keystroke is a scan too many.
 * -1 when the plan is empty or the index is past its end.
 */
export const chunkAtItem = (plan: PlannedChunk[], index: number): number => {
  let lo = 0;
  let hi = plan.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (plan[mid].first <= index) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && index < plan[found].first + plan[found].count ? found : -1;
};

/**
 * The first chunk whose box reaches `px` along the scroll axis — the same binary search, on
 * the offsets, for the rubber band's hit test.
 */
export const chunkAtOffset = (plan: PlannedChunk[], px: number): number => {
  let lo = 0;
  let hi = plan.length - 1;
  let found = plan.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (plan[mid].offset + plan[mid].size > px) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return found;
};

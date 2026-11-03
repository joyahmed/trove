// Rubber-band selection: the rectangle dragged over the list background and which items it
// touches. The hit-test is geometry from the virtualizer's layout, not the DOM — most rows of
// a big folder are not mounted. `use-rubber-band` owns the pointer; this file is the state
// and the pure math.

import { chunkAtOffset, type PlannedChunk } from '$lib/utils/virtual';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The numbers the hit-test needs, all in content pixels of the scroll container. */
export interface BandLayout {
  /** the list scrolls sideways (list view): chunks are columns */
  horizontal: boolean;
  /** px per chunk along the scroll axis */
  chunkSize: number;
  /** items in one chunk (1 in details) */
  perChunk: number;
  /** px one item occupies across the scroll axis; 0 = the whole cross size */
  itemSpan: number;
  /** px before the first chunk */
  paddingStart: number;
  /** how many items there are */
  total: number;
  /**
   * The chunk plan while the list is grouped: a heading is a chunk of its own and a bucket's
   * last row is usually short, so the uniform math above cannot place an item. `null` (or
   * absent) while the list is flat, which is the fast path.
   */
  plan?: PlannedChunk[] | null;
}

/** A rectangle from two corners, in whatever order they were given. */
export const rectFrom = (x1: number, y1: number, x2: number, y2: number): Rect => ({
  left: Math.min(x1, x2),
  top: Math.min(y1, y2),
  width: Math.abs(x2 - x1),
  height: Math.abs(y2 - y1),
});

/** Item indices whose box intersects `rect`. A zero-area rect touches nothing. */
export const itemsInRect = (rect: Rect, layout: BandLayout): number[] => {
  if (layout.total === 0 || rect.width <= 0 || rect.height <= 0) return [];
  const perChunk = Math.max(1, layout.perChunk);
  // along = the scroll axis, across = the other one
  const alongStart = layout.horizontal ? rect.left : rect.top;
  const alongEnd = alongStart + (layout.horizontal ? rect.width : rect.height);
  const acrossStart = layout.horizontal ? rect.top : rect.left;
  const acrossEnd = acrossStart + (layout.horizontal ? rect.height : rect.width);

  // Grouped: walk the plan from the first chunk the rectangle reaches. Headings are skipped —
  // a band dragged across one selects the rows above and below it, not the heading.
  if (layout.plan) {
    const hits: number[] = [];
    for (let c = chunkAtOffset(layout.plan, alongStart); c < layout.plan.length; c++) {
      const chunk = layout.plan[c];
      if (chunk.offset >= alongEnd) break;
      if (chunk.header) continue;
      let first = 0;
      let last = chunk.count - 1;
      if (layout.itemSpan > 0) {
        first = Math.max(0, Math.floor(acrossStart / layout.itemSpan));
        last = Math.min(chunk.count - 1, Math.floor((acrossEnd - 1e-6) / layout.itemSpan));
        if (last < first) continue;
      }
      for (let k = first; k <= last; k++) hits.push(chunk.first + k);
    }
    return hits;
  }

  const chunkCount = Math.ceil(layout.total / perChunk);
  const firstChunk = Math.max(0, Math.floor((alongStart - layout.paddingStart) / layout.chunkSize));
  const lastChunk = Math.min(
    chunkCount - 1,
    Math.floor((alongEnd - layout.paddingStart - 1e-6) / layout.chunkSize),
  );
  if (lastChunk < firstChunk) return [];

  let firstSlot = 0;
  let lastSlot = perChunk - 1;
  if (layout.itemSpan > 0) {
    firstSlot = Math.max(0, Math.floor(acrossStart / layout.itemSpan));
    lastSlot = Math.min(perChunk - 1, Math.floor((acrossEnd - 1e-6) / layout.itemSpan));
    if (lastSlot < firstSlot) return [];
  }

  const hits: number[] = [];
  for (let c = firstChunk; c <= lastChunk; c++) {
    for (let k = firstSlot; k <= lastSlot; k++) {
      const i = c * perChunk + k;
      if (i < layout.total) hits.push(i);
    }
  }
  return hits;
};

class RubberBandState {
  /** the rectangle being dragged, in content pixels; null when idle */
  rect = $state<Rect | null>(null);
  /** Ctrl was held at the press: the band adds to the selection instead of replacing it */
  additive = $state(false);

  get active() {
    return this.rect !== null;
  }

  begin(additive: boolean) {
    this.additive = additive;
    this.rect = null;
  }

  update(rect: Rect) {
    this.rect = rect;
  }

  end() {
    this.rect = null;
  }
}

export const rubberBand = new RubberBandState();

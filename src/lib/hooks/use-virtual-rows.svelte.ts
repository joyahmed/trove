// Virtual scrolling for the file list: only the chunks in view exist in the DOM, so a 100k-file
// folder costs a viewport's worth of rows. TanStack's core does the range math; this hook
// wires it to runes (the package's own adapter is a Svelte store, which we do not use) and to
// the view's layout — one row per chunk in details, a row of tiles in grid, a column in list.
import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
} from '@tanstack/svelte-virtual';
import { layoutFor, type ViewLayout } from '$lib/data/view-layouts';
import { useSidewaysWheel } from '$lib/hooks/use-sideways-wheel.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import {
  chunkAtItem,
  chunkCount,
  chunkOf,
  chunkRange,
  itemsPerChunk,
  planChunks,
  type PlannedChunk,
} from '$lib/utils/virtual';

export interface Chunk<T> {
  index: number;
  /** px from the start of the scroll axis */
  start: number;
  /** item index of the first entry, for aria-rowindex */
  first: number;
  items: T[];
  /** a full-width group heading rather than a row of items */
  header: boolean;
}

export interface VirtualOptions<T> {
  /**
   * True while the list carries group headings. Off is the allocation-free path — uniform
   * chunks, pure index math — which is what a 100k-entry folder wants; on, the list is planned
   * once per change into `PlannedChunk[]`, which costs one array of that folder's size.
   */
  grouped?: () => boolean;
  /** which items are headings, for the plan */
  isHeader?: (item: T) => boolean;
}

export const useVirtualRows = <T>(items: () => T[], options: VirtualOptions<T> = {}) => {
  let el = $state<HTMLElement | null>(null);
  let width = $state(0);
  let height = $state(0);
  /** bumped whenever the virtualizer's range changes; the deriveds below depend on it */
  let version = $state(0);
  let ticks = 0;
  // `version++` would read the signal, and an effect that reads what it writes loops forever.
  const bump = () => {
    version = ++ticks;
  };

  const layout = $derived(layoutFor(tabs.active.view, tabs.active.iconSize));
  const perChunk = $derived(itemsPerChunk(layout, width, height));

  /**
   * The chunk plan while the list is grouped, `null` while it is not. A heading spans the
   * cross axis and is a different height from a row of tiles, so a grouped list has no single
   * `chunkSize` and the virtualizer has to be told each chunk's own.
   */
  const plan = $derived.by((): PlannedChunk[] | null => {
    const { grouped, isHeader } = options;
    if (!grouped?.() || !isHeader) return null;
    const all = items();
    return planChunks(all.length, perChunk, (i) => isHeader(all[i]), layout);
  });

  const count = $derived(plan ? plan.length : chunkCount(items().length, perChunk));
  /** items one viewport holds — what PageUp / PageDown move by */
  const viewportItems = $derived(
    Math.max(
      perChunk,
      Math.floor((layout.horizontal ? width : height) / layout.chunkSize) * perChunk,
    ),
  );

  const virtualizerOptions = () => ({
    count,
    horizontal: layout.horizontal,
    estimateSize: (i: number) => plan?.[i]?.size ?? layout.chunkSize,
    paddingStart: layout.paddingStart,
    overscan: layout.overscan,
    getScrollElement: () => el,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    onChange: bump,
  });

  const virtualizer = new Virtualizer<HTMLElement, HTMLElement>(virtualizerOptions());

  // Keep the virtualizer's options in step with the view and the listing; a layout change
  // invalidates its size cache (estimateSize is not one of its memo keys).
  let lastLayout: ViewLayout | null = null;
  let lastPlan: PlannedChunk[] | null = null;
  $effect(() => {
    virtualizer.setOptions(virtualizerOptions());
    // A new plan is a new set of sizes, and `estimateSize` is not one of the memo keys either
    if (layout !== lastLayout || plan !== lastPlan) {
      lastLayout = layout;
      lastPlan = plan;
      virtualizer.measure();
    }
    virtualizer._willUpdate();
    bump();
  });

  // Mount: the virtualizer's scroll/rect observers, plus our own size for items-per-chunk.
  $effect(() => {
    if (!el) return;
    const unmount = virtualizer._didMount();
    const ro = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      unmount();
    };
  });

  // List view scrolls only sideways; let the plain wheel drive it, as Explorer does
  useSidewaysWheel(
    () => el,
    () => layout.horizontal,
  );

  const chunks = $derived.by((): Chunk<T>[] => {
    void version;
    const all = items();
    const p = plan;
    if (p)
      return virtualizer
        .getVirtualItems()
        .filter((v) => p[v.index] !== undefined)
        .map((v) => {
          const c = p[v.index];
          return {
            index: v.index,
            start: v.start,
            first: c.first,
            items: all.slice(c.first, c.first + c.count),
            header: c.header,
          };
        });
    return virtualizer.getVirtualItems().map((v) => {
      const [start, end] = chunkRange(v.index, perChunk, all.length);
      return {
        index: v.index,
        start: v.start,
        first: start,
        items: all.slice(start, end),
        header: false,
      };
    });
  });

  const totalSize = $derived.by(() => {
    void version;
    return virtualizer.getTotalSize();
  });

  /** `use:` action for the scroll container. */
  const attach = (node: HTMLElement) => {
    el = node;
    return {
      destroy: () => {
        el = null;
      },
    };
  };

  /** Bring item `index` into view with the least movement, like `scrollIntoView` nearest. */
  const scrollToItem = (index: number) => {
    const chunk = plan ? chunkAtItem(plan, index) : chunkOf(index, perChunk);
    if (chunk >= 0) virtualizer.scrollToIndex(chunk, { align: 'auto' });
  };

  return {
    attach,
    scrollToItem,
    get layout() {
      return layout;
    },
    get perChunk() {
      return perChunk;
    },
    /** the chunk plan while the list is grouped, `null` while it is not — the band reads it */
    get plan() {
      return plan;
    },
    get viewportItems() {
      return viewportItems;
    },
    /** the scroll container, for anyone who needs its geometry (the rubber band) */
    get element() {
      return el;
    },
    get chunks() {
      return chunks;
    },
    get totalSize() {
      return totalSize;
    },
  };
};

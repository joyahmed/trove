// Reordering the details columns (G.59): drag a header sideways, or focus it and press Alt+← /
// Alt+→. A press that does not travel DRAG_PX stays a click, which sorts. While dragging, the
// gap the header would land in is `slot`, and `marker` tells each header whether the drop line
// is on its left or right edge. Name stays first and does not drag; the Folder column (search)
// is not stored and takes no part. The order lands in `settings.columns`, saved like the widths.
import { tick } from 'svelte';
import { REQUIRED_COLUMN, type SortKey } from '$lib/data/file-columns';
import { columns } from '$lib/state/columns.svelte';
import { settings } from '$lib/state/settings.svelte';
import { dropSlot } from '$lib/utils/column-order';

/** How far a press moves before it is a drag, not a click. */
export const DRAG_PX = 5;

/** The header row marks itself so, and each header cell with `data-col-key`. */
const HEADER_ROW = '[data-mac="colhead"]';

export type DropMarker = 'before' | 'after' | null;

/**
 * Where the drop line is drawn for `key`, given the order, the dragged column and the gap: on
 * the left edge of the column at the gap, or the right edge of the last one for the end gap.
 * Nothing where the drop would leave the column where it is.
 */
export const markerFor = (
  order: readonly SortKey[],
  dragged: SortKey | null,
  slot: number | null,
  key: SortKey,
): DropMarker => {
  if (dragged === null || slot === null) return null;
  const from = order.indexOf(dragged);
  const floor = order[0] === REQUIRED_COLUMN ? 1 : 0;
  const gap = Math.max(floor, slot);
  if (from < 0 || gap === from || gap === from + 1) return null;
  if (gap < order.length) return order[gap] === key ? 'before' : null;
  return order[order.length - 1] === key ? 'after' : null;
};

export const useColumnDrag = () => {
  let dragged = $state<SortKey | null>(null);
  let slot = $state<number | null>(null);
  /** a drag just ended: the click the browser sends after pointerup must not sort */
  let swallowClick = false;

  /** The stored columns' header middles, in order, read once per move from the header row. */
  const middles = (row: Element): number[] =>
    settings.columns.map((k) => {
      const cell = row.querySelector(`[data-col-key="${k}"]`);
      const r = cell?.getBoundingClientRect();
      return r ? r.left + r.width / 2 : Number.POSITIVE_INFINITY;
    });

  const onpointerdown = (key: SortKey, e: PointerEvent) => {
    if (e.button !== 0 || key === REQUIRED_COLUMN || !settings.columns.includes(key)) return;
    const row = (e.currentTarget as HTMLElement).closest(HEADER_ROW);
    if (!row) return;
    const startX = e.clientX;
    const move = (ev: PointerEvent) => {
      if (dragged === null && Math.abs(ev.clientX - startX) < DRAG_PX) return;
      dragged = key;
      slot = dropSlot(middles(row), ev.clientX);
    };
    const stop = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      if (dragged !== null && slot !== null && ev.type === 'pointerup') {
        columns.moveTo(dragged, slot);
      }
      if (dragged !== null) {
        swallowClick = true;
        setTimeout(() => (swallowClick = false), 0);
      }
      dragged = null;
      slot = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  /** The header's click: sorts, unless it is the tail of a drag. */
  const onclick = (sort: () => void) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    sort();
  };

  /**
   * Alt+← / Alt+→ on a focused header moves it one place. Stopped here so the window's Alt+←
   * (Back) does not also run; the header keeps the focus after the row re-renders.
   */
  const onkeydown = (key: SortKey, e: KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const row = (e.currentTarget as HTMLElement).closest(HEADER_ROW);
    if (!columns.shift(key, e.key === 'ArrowLeft' ? -1 : 1)) return;
    void tick().then(() =>
      row?.querySelector<HTMLElement>(`[data-col-key="${key}"] button`)?.focus(),
    );
  };

  return {
    get dragged() {
      return dragged;
    },
    marker: (key: SortKey): DropMarker => markerFor(settings.columns, dragged, slot, key),
    onpointerdown,
    onclick,
    onkeydown,
  };
};

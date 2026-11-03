// Column widths for the details view: the user's override from settings, else the column
// default. A drag on a header's right edge changes it; double-click resets. App-wide, so the
// header and every row read the same numbers. The columns' ORDER is `settings.columns`; a header
// dragged sideways (hooks/use-column-drag) or Alt+←/→ moves one (utils/column-order, G.59).
import { allColumns, type FileColumn, type SortKey } from '$lib/data/file-columns';
import { settings } from '$lib/state/settings.svelte';
import { moveColumn, shiftColumn } from '$lib/utils/column-order';

class ColumnsState {
  widths = $derived<Record<SortKey, number>>(
    Object.fromEntries(
      allColumns.map((c) => [c.key, settings.columnWidths[c.key] ?? c.defaultWidth]),
    ) as Record<SortKey, number>,
  );

  startDrag = (col: FileColumn, e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startW = this.widths[col.key];
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      settings.columnWidths[col.key] = Math.max(
        col.minWidth,
        Math.round(startW + ev.clientX - startX),
      );
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };

  /** Move `key` into gap `slot` of the shown columns; a no-op move writes nothing. */
  moveTo = (key: SortKey, slot: number): boolean =>
    this.#set(moveColumn(settings.columns, key, slot));

  /** One place left or right; false at an end (or for Name, which stays first). */
  shift = (key: SortKey, step: -1 | 1): boolean =>
    this.#set(shiftColumn(settings.columns, key, step));

  #set = (next: SortKey[]): boolean => {
    if (next === settings.columns) return false;
    settings.columns = next;
    return true;
  };

  reset = (col: FileColumn, e: MouseEvent) => {
    e.stopPropagation();
    delete settings.columnWidths[col.key];
  };
}

export const columns = new ColumnsState();

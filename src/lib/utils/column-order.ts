// The order of the details columns (G.59): a header dragged sideways, or moved with Alt+←/→,
// changes `settings.columns`, which lists the shown columns IN THEIR ORDER. Pure functions, so
// the drag, the keyboard and the settings loader share one set of rules:
//   - Name stays first. It holds the icon and the rename box, and search slots its Folder
//     column in right after it (`state/listing`); a list whose names sit mid-row is not a list.
//   - The Folder column is search's alone and never stored.
import { REQUIRED_COLUMN, fileColumns, isSortKey, type SortKey } from '$lib/data/file-columns';

/** A stored list, cleaned: known keys only, no repeats, no Folder, Name present and first. */
export const cleanColumnOrder = (raw: readonly unknown[]): SortKey[] => {
  const seen = new Set<SortKey>();
  for (const k of raw) if (isSortKey(k) && k !== 'path') seen.add(k);
  seen.delete(REQUIRED_COLUMN);
  return [REQUIRED_COLUMN, ...seen];
};

/**
 * `key` moved so it sits at `slot`, a gap in `order` (0 = before the first column, `length` =
 * after the last). Name never moves and nothing goes before it. An unknown key, or a slot that
 * leaves the column where it is, returns `order` itself (no write, no save).
 */
export const moveColumn = (order: readonly SortKey[], key: SortKey, slot: number): SortKey[] => {
  const from = order.indexOf(key);
  if (from < 0 || key === REQUIRED_COLUMN) return order as SortKey[];
  const floor = order[0] === REQUIRED_COLUMN ? 1 : 0;
  const gap = Math.max(floor, Math.min(order.length, Math.round(slot)));
  // the gaps just before and just after the column itself are where it already is
  if (gap === from || gap === from + 1) return order as SortKey[];
  const rest = order.filter((k) => k !== key);
  const at = gap > from ? gap - 1 : gap;
  return [...rest.slice(0, at), key, ...rest.slice(at)];
};

/** One place left (-1) or right (+1): the keyboard's Alt+← / Alt+→ on a focused header. */
export const shiftColumn = (order: readonly SortKey[], key: SortKey, step: -1 | 1): SortKey[] => {
  const from = order.indexOf(key);
  if (from < 0) return order as SortKey[];
  return moveColumn(order, key, step > 0 ? from + 2 : from - 1);
};

/**
 * The gap a pointer at `x` drops into, given each header's horizontal middle in order: the
 * number of middles left of the pointer. Past a column's middle is after it.
 */
export const dropSlot = (middles: readonly number[], x: number): number =>
  middles.filter((m) => m < x).length;

/**
 * A column turned on from the header's menu: placed after the nearest column that comes before
 * it in Explorer's order (`fileColumns`) and is shown, so a list never reordered stays in
 * Explorer's order and a reordered one keeps its order. Already shown: unchanged.
 */
export const insertColumn = (order: readonly SortKey[], key: SortKey): SortKey[] => {
  if (order.includes(key)) return order as SortKey[];
  const canonical = fileColumns.map((c) => c.key);
  const before = canonical.slice(0, canonical.indexOf(key)).reverse();
  const anchor = before.find((k) => order.includes(k));
  const at = anchor === undefined ? 0 : order.indexOf(anchor) + 1;
  return [...order.slice(0, at), key, ...order.slice(at)];
};

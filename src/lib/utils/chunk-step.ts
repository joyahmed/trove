// Arrow keys across a GROUPED list. Ungrouped, "one row down" is `perChunk` places on in the
// flat order; grouped, each group's last row is short and a heading sits between groups, so
// that arithmetic lands on the wrong tile. The plan knows the real rows, so step by those.
import { chunkAtItem, type PlannedChunk } from '$lib/utils/virtual';

/**
 * Where an arrow key across chunks (a row of tiles in grid view, a column in list view) lands:
 * the item in the same slot of the next chunk that holds items, or the last item of it when it
 * is shorter. Headings are skipped. Returns an index into `order` (the rows on screen, headings
 * left out), or `null` when there is nothing further that way or `focused` is not on screen —
 * the caller then stays put or falls back to a flat step.
 *
 * `positions` is the rendered list: the path at each position, `undefined` for a heading.
 */
export const stepAcrossChunks = (
  plan: PlannedChunk[],
  positions: (string | undefined)[],
  order: string[],
  focused: string | null,
  dir: 1 | -1,
): number | null => {
  if (focused === null) return null;
  const at = positions.indexOf(focused);
  const from = at < 0 ? -1 : chunkAtItem(plan, at);
  if (from < 0) return null;
  const slot = at - plan[from].first;
  for (let c = from + dir; c >= 0 && c < plan.length; c += dir) {
    const chunk = plan[c];
    if (chunk.header) continue;
    const path = positions[chunk.first + Math.min(slot, chunk.count - 1)];
    return path === undefined ? null : order.indexOf(path);
  }
  return null;
};

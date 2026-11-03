// Arrow keys between the Home / This PC tiles (plan 15 G.74). The tiles wrap in rows of
// different widths (a drive is wider than a folder) across several sections, so "the tile below"
// is found from where the tiles sit on screen, not from a column count. Pure, for the tests.

/** Where one tile sits: what `getBoundingClientRect()` gives, reduced to the four numbers used. */
export interface TileBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

const centreX = (b: TileBox) => b.left + b.width / 2;
const centreY = (b: TileBox) => b.top + b.height / 2;

/** The nearest row above (-1) or below (+1) `from`, and in it the tile closest across. */
const vertical = (boxes: TileBox[], from: number, dir: -1 | 1): number => {
  const here = boxes[from];
  const others = boxes
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => (dir === 1 ? centreY(b) > here.top + here.height : centreY(b) < here.top));
  if (others.length === 0) return from;
  // the row next to this one: the smallest step in `dir`; a tile counts as in that row when its
  // middle lies inside the first tile's height (rows of mixed heights still read as one row)
  const nearest = others.reduce((a, c) => (dir * (c.b.top - a.b.top) < 0 ? c : a));
  const row = others.filter(
    ({ b }) => Math.abs(centreY(b) - centreY(nearest.b)) < nearest.b.height / 2,
  );
  const x = centreX(here);
  return row.reduce((a, c) => (Math.abs(centreX(c.b) - x) < Math.abs(centreX(a.b) - x) ? c : a)).i;
};

/**
 * Which tile a key moves to from tile `from`: ← / → the one before / after (across section
 * breaks), ↑ / ↓ the closest one in the row above / below, Home / End the first / last. At an edge
 * it stays put. `null` = not a move key (or a modifier is held: Alt+← is Back), so the caller
 * leaves the event alone.
 */
export const tileMove = (e: KeyLike, from: number, boxes: TileBox[]): number | null => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (from < 0 || from >= boxes.length) return null;
  const last = boxes.length - 1;
  switch (e.key) {
    case 'ArrowRight':
      return Math.min(last, from + 1);
    case 'ArrowLeft':
      return Math.max(0, from - 1);
    case 'ArrowDown':
      return vertical(boxes, from, 1);
    case 'ArrowUp':
      return vertical(boxes, from, -1);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
};

/** Roving tab stop: the remembered tile while it is still shown, else the first. */
export const rovingKey = (keys: string[], remembered: string | null): string | null =>
  remembered !== null && keys.includes(remembered) ? remembered : (keys[0] ?? null);

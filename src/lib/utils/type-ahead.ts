// Explorer's type-to-select: letters typed in quick succession form a prefix, and the focus
// jumps to the next name that starts with it. Pure; the 1 s reset timer lives in the hook.

export const TYPE_AHEAD_RESET_MS = 1000;

/**
 * The index of the first name starting with `prefix` (case-insensitive), searching from the
 * row after `from` and wrapping round; `from` itself is tried last. -1 when nothing matches.
 * A one-letter prefix that repeats (`d`, `d`, `d`) walks through the matches like Explorer.
 * With `includeFrom` the search starts at `from` itself: the prefix just grew, and the focused
 * row may still match it (`rep` must stay on repair.txt, not jump to report.txt).
 */
export const nextMatch = (
  names: string[],
  from: number,
  prefix: string,
  includeFrom = false,
): number => {
  if (names.length === 0 || prefix.length === 0) return -1;
  const needle = prefix.toLowerCase();
  const start = from < 0 ? 0 : includeFrom ? from : (from + 1) % names.length;
  for (let step = 0; step < names.length; step++) {
    const i = (start + step) % names.length;
    if (names[i].toLowerCase().startsWith(needle)) return i;
  }
  return -1;
};

/**
 * The buffer after one more key. `prev` is the live buffer ('' once the timeout cleared it).
 * `grew` is true when a character was appended to a non-empty buffer, so the search keeps the
 * focused row; a repeated single letter keeps the buffer and steps on, a fresh buffer starts
 * at the next row.
 */
export const typeAheadStep = (prev: string, key: string): { prefix: string; grew: boolean } => {
  const k = key.toLowerCase();
  if (prev.length === 1 && prev === k) return { prefix: prev, grew: false };
  return { prefix: prev + k, grew: prev.length > 0 };
};

/** Whether a key press is a printable character that belongs to the prefix. */
export const isTypeAheadKey = (e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}) => e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.altKey && !e.metaKey;

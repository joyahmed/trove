// A popup menu's keys, the Windows rules: ↓ / ↑ walk the enabled rows and wrap, Home / End jump
// to the ends, → opens a row's flyout, ← and Esc close one level, Enter / Space run the row.
// Pure helpers so the hook stays thin and the rules are testable without a DOM.
import type { KeyLike } from '$lib/data/shortcuts';

export type MenuKey =
  'next' | 'prev' | 'first' | 'last' | 'open' | 'back' | 'run' | 'close' | 'tab';

/** What a key does inside an open menu, or null for a key the menu does not use. */
export const menuKey = (e: KeyLike): MenuKey | null => {
  if (e.ctrlKey || e.altKey || (e.metaKey ?? false)) return null;
  switch (e.key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'prev';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 'ArrowRight':
      return 'open';
    case 'ArrowLeft':
      return 'back';
    case 'Enter':
    case ' ':
      return 'run';
    case 'Escape':
      return 'close';
    case 'Tab':
      return 'tab';
    default:
      return null;
  }
};

/**
 * The row a move lands on, given which rows can take focus (dividers and disabled rows cannot)
 * and where focus is now (-1: on no row, as after a mouse open). Wraps at both ends; -1 when no
 * row can take focus at all.
 */
export const stepIndex = (
  focusable: readonly boolean[],
  from: number,
  move: 'next' | 'prev' | 'first' | 'last',
): number => {
  const n = focusable.length;
  if (!focusable.some(Boolean)) return -1;
  if (move === 'first') return focusable.indexOf(true);
  if (move === 'last') return focusable.lastIndexOf(true);
  const step = move === 'next' ? 1 : -1;
  // from nowhere, ↓ starts at the top and ↑ at the bottom
  let i = from < 0 ? (step === 1 ? -1 : n) : from;
  for (let k = 0; k < n; k++) {
    i = (i + step + n) % n;
    if (focusable[i]) return i;
  }
  return -1;
};

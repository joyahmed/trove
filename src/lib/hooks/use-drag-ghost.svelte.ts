// What the drag ghost shows: where it is, the first item's icon, how many items, and the verb.
import { drag } from '$lib/state/drag.svelte';

export const useDragGhost = () => {
  const label = $derived(drag.count === 1 ? (drag.first?.name ?? '') : `${drag.count} items`);

  return {
    get x() {
      return drag.x;
    },
    get y() {
      return drag.y;
    },
    /** the first dragged item, for its icon; null when nothing is dragged */
    get first() {
      return drag.first;
    },
    get label() {
      return label;
    },
    /** "Copy to <folder>" / "Move to <folder>" / "Pin", or "" without a target or where a drop does nothing */
    get verb() {
      if (drag.target === null || drag.noOp) return '';
      if (drag.target.kind === 'pin') return 'Pin';
      return drag.effect === 'copy' ? 'Copy' : 'Move';
    },
  };
};

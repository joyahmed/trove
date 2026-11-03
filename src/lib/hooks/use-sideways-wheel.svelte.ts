// The List view scrolls only sideways, and Explorer lets the plain mouse wheel drive it; a
// browser leaves a vertical wheel with nothing to do there. This turns it into a sideways scroll.
import { wheelToScrollLeft } from '$lib/utils/wheel-scroll';

/** Wheel-to-sideways on `el` while `enabled()` (only the List view's layout is horizontal). */
export const useSidewaysWheel = (el: () => HTMLElement | null, enabled: () => boolean) => {
  $effect(() => {
    const node = el();
    if (!node || !enabled()) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.shiftKey) return; // zoom, and Shift+wheel already scrolls sideways
      const dx = wheelToScrollLeft(e, node);
      if (dx === null) return;
      node.scrollLeft += dx;
      e.preventDefault();
    };
    // non-passive: preventDefault needs it
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  });
};

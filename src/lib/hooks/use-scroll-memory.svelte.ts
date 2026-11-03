// Scroll position per tab: one list and one scroll container serve every tab, so the offset
// is kept on the tab and put back when it is activated, and again when a navigation lands
// (the top for a new folder, the saved offset for Back / Forward). A `use:` action.
import { tick, untrack } from 'svelte';
import type { Action } from 'svelte/action';
import { tabs } from '$lib/state/tabs.svelte';

// The Details column header sits above the list, not inside it, so it does not scroll with the
// rows: it is moved to the rows' horizontal offset here. The browser clamps that offset itself
// when the list widens (the preview pane opening wider), and a clamp is not always a scroll
// event, so the header is re-synced on a resize as well as on a scroll.
const followHeader = (el: HTMLElement) => {
  const max = Math.max(0, el.scrollWidth - el.clientWidth);
  if (el.scrollLeft > max) el.scrollLeft = max;
  const header = el.parentElement?.querySelector<HTMLElement>('[data-mac="colhead"]');
  if (header) header.scrollLeft = el.scrollLeft;
};

// The one saved number is the axis the list scrolls along: down for rows (Details, grid), across
// for the multi-column list that never overflows vertically. It must not be written to both
// axes, or a saved vertical offset lands in scrollLeft and hides the Name column.
const scrollsVertically = (el: HTMLElement) => el.scrollHeight > el.clientHeight;

// The parameter is whether the view lays its rows out across (the multi-column List). When that
// flips, the saved offset belongs to the other axis, so both axes go back to the start.
export const scrollMemory: Action<HTMLElement, boolean | undefined> = (el, horizontal) => {
  const onScroll = () => {
    followHeader(el);
    tabs.active.scrollOffset = scrollsVertically(el) ? el.scrollTop : el.scrollLeft;
  };
  el.addEventListener('scroll', onScroll, { passive: true });
  const resized = new ResizeObserver(() => followHeader(el));
  resized.observe(el);
  if (el.firstElementChild) resized.observe(el.firstElementChild);

  // Restore on activation or when a navigation lands (not on every listing): the index and the
  // tab's restore marker are the only dependencies — the offset itself is read untracked, since
  // scrolling writes it.
  $effect(() => {
    const index = tabs.activeIndex;
    const tab = tabs.list[index];
    void tab?.scrollRestore;
    const offset = untrack(() => tab?.scrollOffset ?? 0);
    void tick().then(() => {
      if (tabs.activeIndex !== index) return;
      if (scrollsVertically(el)) {
        el.scrollTop = offset;
        el.scrollLeft = 0;
      } else {
        el.scrollLeft = offset;
      }
      followHeader(el);
    });
  });

  return {
    update(next) {
      if (!!next === !!horizontal) return;
      horizontal = next;
      tabs.active.scrollOffset = 0;
      void tick().then(() => {
        el.scrollTop = 0;
        el.scrollLeft = 0;
        followHeader(el);
      });
    },
    destroy() {
      el.removeEventListener('scroll', onScroll);
      resized.disconnect();
    },
  };
};

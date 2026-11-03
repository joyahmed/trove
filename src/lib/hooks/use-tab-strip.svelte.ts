// The tab strip's reactivity: titles, activation, close, middle-click close, new tab, drag to
// reorder (pointer events, like the row drag — WebView2 gives no HTML5 DnD here) and drag out
// of the strip to detach the tab into its own window.
import { close as closeWindow, openWindow } from '$lib/api/window';
import { placeIconFor, type PlaceIcon } from '$lib/data/place-icons';
import type { TabState } from '$lib/state/tab.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { locationLabel, locationText } from '$lib/utils/location';
import { detachTarget } from '$lib/utils/tab-detach';

export interface TabView {
  index: number;
  title: string;
  /** the close button's own accessible name, apart from the tab's */
  closeLabel: string;
  active: boolean;
  /** the tab's folder, a drop target; '' on a place */
  path: string;
  /** the place's own icon (the sidebar's); `null` draws the yellow folder */
  icon: PlaceIcon | null;
}

const DRAG_THRESHOLD_PX = 4;

/** Close a tab; on the last one Explorer closes the window, and so do we. */
export const closeTab = (index = tabs.activeIndex) => {
  if (tabs.close(index) === 'last') void closeWindow();
};

/**
 * Detach: the tab's location opens in a new window and the tab closes here — unless it is
 * the last one, in which case this window keeps it (Explorer does the same).
 */
export const detachTab = async (index: number) => {
  const tab = tabs.list[index];
  if (!tab) return;
  await openWindow(locationText(tab.location));
  if (tabs.list.length > 1) tabs.close(index);
};

export const useTabStrip = () => {
  const views = $derived<TabView[]>(
    tabs.list.map((t, index) => ({
      index,
      // the folder name, `C:` for a root, "Home" / "This PC" for a place, "New tab" when empty
      title: locationLabel(t.location) || 'New tab',
      closeLabel: `Close ${locationLabel(t.location) || 'New tab'}`,
      active: index === tabs.activeIndex,
      path: t.path,
      icon: placeIconFor(t.location),
    })),
  );

  // Reorder: press on a tab, move past the threshold, release over another tab's slot.
  let pressed = $state<{ index: number; tab: TabState; x: number; y: number } | null>(null);
  let dragging = $state(false);
  let slot = $state<number | null>(null);
  let ghost = $state<{ x: number; y: number; title: string; icon: PlaceIcon | null } | null>(null);
  let detaching = $state(false);
  // The release of a drag is followed by a click on the pressed tab's element, which (keyed by
  // index) now shows whichever tab slid into the old place; that click is eaten, not obeyed.
  let dragEnded = false;

  const onpointerdown = (index: number, e: PointerEvent) => {
    if (e.button !== 0) return;
    // a drag released where no click follows (outside the window) must not eat this press's click
    dragEnded = false;
    const tab = tabs.list[index];
    if (tab) pressed = { index, tab, x: e.clientX, y: e.clientY };
  };
  const onpointermove = (index: number, e: PointerEvent) => {
    if (pressed === null) return;
    if (!dragging) {
      // either axis: a tab pulled straight down is a detach, not a click
      const dx = Math.abs(e.clientX - pressed.x);
      const dy = Math.abs(e.clientY - pressed.y);
      if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) return;
      dragging = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    ghost = {
      x: e.clientX,
      y: e.clientY,
      title: views[pressed.index]?.title ?? '',
      icon: views[pressed.index]?.icon ?? null,
    };
    // with the pointer captured, `index` is the pressed tab; find the slot under the pointer
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-tab]');
    slot = el ? Number(el.dataset.tab) : null;
    const strip = (e.currentTarget as HTMLElement).closest('[role=tablist]');
    const rect = strip?.getBoundingClientRect() ?? { top: 0, bottom: 0 };
    detaching = detachTarget({ x: e.clientX, y: e.clientY }, rect, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
  };
  const onpointerup = (e: PointerEvent) => {
    if (pressed !== null && dragging) {
      const strip = (e.currentTarget as HTMLElement).closest('[role=tablist]');
      const rect = strip?.getBoundingClientRect() ?? { top: 0, bottom: 0 };
      const point = { x: e.clientX, y: e.clientY };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      if (detachTarget(point, rect, viewport)) void detachTab(pressed.index);
      else {
        if (slot !== null) tabs.move(pressed.index, slot);
        // the dragged tab ends active, as in a browser — found by identity, as the move shifts indexes
        tabs.activate(tabs.list.indexOf(pressed.tab));
      }
      dragEnded = true;
    }
    pressed = null;
    dragging = false;
    slot = null;
    ghost = null;
    detaching = false;
  };

  return {
    get views() {
      return views;
    },
    /** the tab a dragged tab would land on */
    get slot() {
      return dragging && !detaching ? slot : null;
    },
    /** which edge of the slot's tab the drop line is on: dragging right lands after it, left before */
    get slotSide(): 'before' | 'after' {
      return pressed !== null && slot !== null && slot > pressed.index ? 'after' : 'before';
    },
    /** the dragged tab's label following the pointer, and whether releasing would detach */
    get ghost() {
      return ghost;
    },
    get detaching() {
      return detaching;
    },
    activate: (index: number) => {
      if (dragEnded) dragEnded = false;
      else tabs.activate(index);
    },
    close: (index: number, e: MouseEvent) => {
      e.stopPropagation();
      closeTab(index);
    },
    /** middle mouse button closes, as in every tabbed app */
    onauxclick: (index: number, e: MouseEvent) => {
      if (e.button === 1) closeTab(index);
    },
    onpointerdown,
    onpointermove,
    onpointerup,
    open: () => tabs.open(),
  };
};

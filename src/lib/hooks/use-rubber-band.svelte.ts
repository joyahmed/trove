// The rubber band's pointer side: a press on the list background, 4 px of travel, a rectangle
// in the scroll container's content coordinates, and auto-scroll at the edges. Which items
// the rectangle touches is `itemsInRect` over the virtualizer's layout; the selection is
// applied on every move so the rows light up as the band grows.
import { itemsInRect, rectFrom, rubberBand, type BandLayout } from '$lib/state/rubber-band.svelte';
import { selection } from '$lib/state/selection.svelte';
import { logError } from '$lib/api/log';
import { onMac } from '$lib/utils/platform';

const THRESHOLD_PX = 4;
const EDGE_PX = 24;
const SCROLL_STEP_PX = 10;
const SCROLL_TICK_MS = 30;

interface Press {
  /** content coordinates of the press */
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  pointerId: number;
  /** the selection at the press, kept when Ctrl adds to it */
  base: string[];
  /** the selection at the press, put back when Escape cancels the band */
  before: string[];
}

export interface BandGeometry {
  layout: BandLayout;
  /** the path at each rendered position; empty where a group heading sits, or past the end */
  order: (string | undefined)[];
  element: HTMLElement | null;
}

export const useRubberBand = (geometry: () => BandGeometry) => {
  let press: Press | null = null;
  // Escape ended the band while the button is still down: the release that follows is part of
  // the cancelled drag, not a click on the background (which would clear the pick).
  let cancelled = false;
  let last: { clientX: number; clientY: number } | null = null;
  let scrollTimer: ReturnType<typeof setInterval> | null = null;

  // content coordinates: the box's padding is not part of the rows' geometry
  const contentPoint = (el: HTMLElement, clientX: number, clientY: number) => {
    const r = el.getBoundingClientRect();
    // Rows sit inside the padding, so both paddings come off: without the top one (pt-2) the band
    // ran 8 px low and a drag ending near a row's bottom also took the row below.
    const style = getComputedStyle(el);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    return {
      x: clientX - r.left - padLeft + el.scrollLeft,
      y: clientY - r.top - padTop + el.scrollTop,
    };
  };

  const apply = () => {
    const { layout, order } = geometry();
    const rect = rubberBand.rect;
    if (!rect) return;
    const hits = itemsInRect(rect, layout)
      .map((i) => order[i])
      .filter((p) => p !== undefined);
    if (rubberBand.additive && press) selection.replaceAll([...press.base, ...hits]);
    else selection.replaceAll(hits);
  };

  const stopScrolling = () => {
    if (scrollTimer !== null) clearInterval(scrollTimer);
    scrollTimer = null;
  };

  /** Nudge the container while the pointer sits beyond an edge, re-applying as it scrolls. */
  const autoScroll = (el: HTMLElement, clientX: number, clientY: number) => {
    const r = el.getBoundingClientRect();
    const { horizontal } = geometry().layout;
    const before = horizontal ? clientX - r.left : clientY - r.top;
    const after = horizontal ? r.right - clientX : r.bottom - clientY;
    const step = before < EDGE_PX ? -SCROLL_STEP_PX : after < EDGE_PX ? SCROLL_STEP_PX : 0;
    if (step === 0) {
      stopScrolling();
      return;
    }
    if (scrollTimer !== null) return;
    scrollTimer = setInterval(() => {
      if (horizontal) el.scrollLeft += step;
      else el.scrollTop += step;
      if (last) update(el, last.clientX, last.clientY);
    }, SCROLL_TICK_MS);
  };

  const update = (el: HTMLElement, clientX: number, clientY: number) => {
    if (!press) return;
    const p = contentPoint(el, clientX, clientY);
    rubberBand.update(rectFrom(press.x, press.y, p.x, p.y));
    apply();
  };

  const finish = () => {
    stopScrolling();
    press = null;
    last = null;
    rubberBand.end();
  };

  /** On the scroll container. Rows stop propagation of their own pointerdown, so this is the background. */
  const onpointerdown = (e: PointerEvent) => {
    if (e.button !== 0 || e.target instanceof HTMLInputElement) return;
    const el = geometry().element;
    if (!el) return;
    const p = contentPoint(el, e.clientX, e.clientY);
    // the add-to-selection key: ⌘ on a Mac, Ctrl elsewhere
    const add = onMac() ? e.metaKey : e.ctrlKey;
    press = {
      x: p.x,
      y: p.y,
      clientX: e.clientX,
      clientY: e.clientY,
      pointerId: e.pointerId,
      base: add ? [...selection.paths] : [],
      before: [...selection.paths],
    };
    cancelled = false; // a release lost since the last cancel must not eat this press
    rubberBand.begin(add);
  };

  const onpointermove = (e: PointerEvent) => {
    if (!press) return;
    const el = geometry().element;
    if (!el) return;
    if (!(e.buttons & 1)) {
      finish();
      return;
    }
    if (
      !rubberBand.active &&
      Math.hypot(e.clientX - press.clientX, e.clientY - press.clientY) < THRESHOLD_PX
    )
      return;
    if (!rubberBand.active) {
      try {
        el.setPointerCapture(press.pointerId);
      } catch (e) {
        logError('rubberBand.setPointerCapture', e);
        // capture is a nicety; the window listeners still see the pointer
      }
    }
    last = { clientX: e.clientX, clientY: e.clientY };
    update(el, e.clientX, e.clientY);
    autoScroll(el, e.clientX, e.clientY);
  };

  /** Returns true when a band was in progress — the click that follows is not a background click. */
  const onpointerup = (): boolean => {
    const was = rubberBand.active || cancelled;
    cancelled = false;
    finish();
    return was;
  };

  /** Escape cancels and restores the earlier pick; returns true when it consumed the key. */
  const onkeydown = (e: KeyboardEvent): boolean => {
    if (e.key !== 'Escape' || !rubberBand.active) return false;
    // like Explorer: the pick from before the drag comes back
    if (press) selection.replaceAll(press.before);
    finish();
    cancelled = true;
    e.preventDefault();
    return true;
  };

  return {
    get rect() {
      return rubberBand.rect;
    },
    get active() {
      return rubberBand.active;
    },
    onpointerdown,
    onpointermove,
    onpointerup,
    onkeydown,
  };
};

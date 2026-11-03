/** px a "lines" wheel step moves (DOM_DELTA_LINE), the usual browser line height */
const LINE_PX = 16;

export interface WheelScrollInput {
  deltaX: number;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (WheelEvent.deltaMode) */
  deltaMode: number;
}

export interface ScrollBox {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * How far a plain vertical wheel should move a sideways-scrolling list (Explorer's List view),
 * in px along the scroll axis; `null` = leave the event alone. Only a wheel that has deltaY and
 * no deltaX counts (a trackpad's own sideways swipe passes through), and only a list that
 * overflows sideways and not vertically — a list that also scrolls vertically keeps its wheel.
 */
export const wheelToScrollLeft = (e: WheelScrollInput, box: ScrollBox): number | null => {
  if (e.deltaY === 0 || e.deltaX !== 0) return null;
  if (box.scrollWidth <= box.clientWidth || box.scrollHeight > box.clientHeight) return null;
  if (e.deltaMode === 1) return e.deltaY * LINE_PX;
  if (e.deltaMode === 2) return e.deltaY * box.clientWidth;
  return e.deltaY;
};

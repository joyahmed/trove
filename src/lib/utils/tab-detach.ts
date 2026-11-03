// When a tab drag ends far enough from the strip to mean "make this its own window", as
// Explorer does: below the strip by more than a tab's height, or outside the window.

/** How far below the strip's bottom edge a release counts as a detach, in CSS px. */
export const DETACH_BELOW_PX = 48;

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  top: number;
  bottom: number;
}
export interface Size {
  width: number;
  height: number;
}

/** `true` when a tab released at `pointer` (client coordinates) should open a new window. */
export const detachTarget = (pointer: Point, strip: Rect, viewport: Size): boolean => {
  const outside =
    pointer.x < 0 || pointer.x > viewport.width || pointer.y < 0 || pointer.y > viewport.height;
  const below = pointer.y > strip.bottom + DETACH_BELOW_PX;
  return outside || below;
};

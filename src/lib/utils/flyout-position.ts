// Where a submenu flyout goes, in viewport coordinates — the rule Windows and macOS follow:
// open to the right of the row that owns it, first row level with that row; if it would run off
// the bottom, slide it up until it fits; if it is taller than the window, pin it to the top margin
// and let it scroll; if it would run off the right, open it to the LEFT of the parent instead.

export interface FlyoutAnchor {
  /** the owning row's box, viewport px */
  top: number;
  left: number;
  right: number;
}

export interface FlyoutInput {
  anchor: FlyoutAnchor;
  /** the flyout's own rendered size */
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  /** gap kept to every window edge */
  margin?: number;
  /** added to `anchor.top` so the flyout's first ROW lines up with the anchor, past its padding */
  alignY?: number;
}

export interface FlyoutPlacement {
  left: number;
  top: number;
  /** set only when the flyout is taller than the window: cap it and let it scroll */
  maxHeight?: number;
  /** true when it opened to the left of its parent */
  flipped: boolean;
}

export const FLYOUT_MARGIN = 8;

export const placeFlyout = ({
  anchor,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = FLYOUT_MARGIN,
  alignY = 0,
}: FlyoutInput): FlyoutPlacement => {
  // Horizontal: right of the parent, else left of it, else whichever edge keeps it on screen.
  let left = anchor.right;
  let flipped = false;
  if (left + width > viewportWidth - margin) {
    flipped = true;
    left = anchor.left - width;
    if (left < margin) left = Math.max(margin, viewportWidth - margin - width);
  }

  // Vertical: level with the row, slid up just enough to fit, or capped and scrollable.
  const room = viewportHeight - 2 * margin;
  if (height > room) return { left, top: margin, maxHeight: Math.max(0, room), flipped };
  let top = anchor.top + alignY;
  if (top + height > viewportHeight - margin) top = viewportHeight - margin - height;
  if (top < margin) top = margin;
  return { left, top, flipped };
};

export interface MenuPlaceInput {
  /** where the menu was asked to open (the click point), viewport px */
  x: number;
  y: number;
  /** the menu's own rendered size, measured unconstrained */
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  /** set only when the menu is taller than the window: cap it and let it scroll */
  maxHeight?: number;
}

/**
 * Where a TOP-LEVEL popup (a right-click menu) goes: at the point, shifted left / up just enough
 * to keep `margin` to every window edge; taller than the window, pinned to the top margin and
 * capped so it scrolls. The sibling of `placeFlyout` for a menu with no parent row to flip around.
 */
export const placeMenu = ({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = FLYOUT_MARGIN,
}: MenuPlaceInput): MenuPlacement => {
  let left = x;
  if (left + width > viewportWidth - margin) left = viewportWidth - margin - width;
  if (left < margin) left = margin;

  const room = viewportHeight - 2 * margin;
  if (height > room) return { left, top: margin, maxHeight: Math.max(0, room) };
  let top = y;
  if (top + height > viewportHeight - margin) top = viewportHeight - margin - height;
  if (top < margin) top = margin;
  return { left, top };
};

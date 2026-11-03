import { describe, expect, it } from 'vitest';
import { placeFlyout, placeMenu } from './flyout-position';

// The real bug window: 1200x760, a context menu from y≈147 to y≈750 with x 300..600.
const vw = 1200;
const vh = 760;
const row = (top: number, left = 300, right = 600) => ({ top, left, right });

describe('placeFlyout', () => {
  it('fits: opens right of the row, level with it', () => {
    const p = placeFlyout({
      anchor: row(200),
      width: 300,
      height: 120,
      viewportWidth: vw,
      viewportHeight: vh,
    });
    expect(p).toEqual({ left: 600, top: 200, flipped: false });
  });

  it('applies alignY so the first row lines up past the padding', () => {
    const p = placeFlyout({
      anchor: row(200),
      width: 300,
      height: 120,
      viewportWidth: vw,
      viewportHeight: vh,
      alignY: -6,
    });
    expect(p.top).toBe(194);
  });

  it('overflows bottom: slides up so its bottom sits 8px above the window edge', () => {
    // "Sort by" near the foot of the menu: its flyout would run past the bottom edge.
    const p = placeFlyout({
      anchor: row(670),
      width: 300,
      height: 400,
      viewportWidth: vw,
      viewportHeight: vh,
    });
    expect(p.top).toBe(vh - 8 - 400);
    expect(p.top + 400).toBe(752);
    expect(p.maxHeight).toBeUndefined();
  });

  it('taller than the window: top at the margin, capped and scrollable', () => {
    // "More": ~27 rows ≈ 1000px in a 760px window.
    const p = placeFlyout({
      anchor: row(714),
      width: 320,
      height: 1000,
      viewportWidth: vw,
      viewportHeight: vh,
    });
    expect(p.top).toBe(8);
    expect(p.maxHeight).toBe(vh - 16);
  });

  it('exactly the room left counts as fitting, no cap', () => {
    const p = placeFlyout({
      anchor: row(500),
      width: 300,
      height: vh - 16,
      viewportWidth: vw,
      viewportHeight: vh,
    });
    expect(p).toEqual({ left: 600, top: 8, flipped: false });
  });

  it('overflows right: opens to the left of the parent', () => {
    const p = placeFlyout({
      anchor: row(200, 850, 1150),
      width: 300,
      height: 120,
      viewportWidth: vw,
      viewportHeight: vh,
    });
    expect(p).toEqual({ left: 550, top: 200, flipped: true });
  });

  it('no room on either side: keeps it inside the window', () => {
    const p = placeFlyout({
      anchor: row(100, 100, 400),
      width: 300,
      height: 120,
      viewportWidth: 500,
      viewportHeight: vh,
    });
    expect(p.flipped).toBe(true);
    expect(p.left).toBe(500 - 8 - 300);
  });

  it('a row above the top margin still opens at the margin', () => {
    const p = placeFlyout({
      anchor: row(2),
      width: 300,
      height: 100,
      viewportWidth: vw,
      viewportHeight: vh,
    });
    expect(p.top).toBe(8);
  });
});

describe('placeMenu', () => {
  const base = { width: 300, viewportWidth: 1200 };
  it('fits: stays at the click point', () => {
    expect(placeMenu({ ...base, x: 100, y: 100, height: 200, viewportHeight: 500 })).toEqual({
      left: 100,
      top: 100,
    });
  });
  it('slides up to keep an 8 px bottom margin', () => {
    const p = placeMenu({ ...base, x: 100, y: 400, height: 300, viewportHeight: 500 });
    expect(p).toEqual({ left: 100, top: 192 });
  });
  it('shifts left off the right edge', () => {
    const p = placeMenu({ ...base, x: 1100, y: 10, height: 100, viewportHeight: 500 });
    expect(p.left).toBe(892);
  });
  it('taller than the window: pinned to the top margin, capped, scrolls', () => {
    const p = placeMenu({ ...base, x: 100, y: 300, height: 600, viewportHeight: 500 });
    expect(p).toEqual({ left: 100, top: 8, maxHeight: 484 });
  });
  it('exactly as tall as the room fits without a cap', () => {
    const p = placeMenu({ ...base, x: 100, y: 300, height: 484, viewportHeight: 500 });
    expect(p).toEqual({ left: 100, top: 8 });
  });
  it('wider than the window: pinned to the left margin', () => {
    const p = placeMenu({
      x: 50,
      y: 10,
      width: 400,
      height: 100,
      viewportWidth: 300,
      viewportHeight: 500,
    });
    expect(p.left).toBe(8);
  });
});

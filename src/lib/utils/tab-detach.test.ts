import { describe, expect, it } from 'vitest';
import { DETACH_BELOW_PX, detachTarget } from './tab-detach';

const strip = { top: 0, bottom: 40 };
const viewport = { width: 1200, height: 760 };

describe('detachTarget', () => {
  it('a release near the strip is a reorder, not a detach', () => {
    expect(detachTarget({ x: 300, y: 20 }, strip, viewport)).toBe(false);
    expect(detachTarget({ x: 300, y: strip.bottom + DETACH_BELOW_PX }, strip, viewport)).toBe(
      false,
    );
  });

  it('a release well below the strip detaches', () => {
    expect(detachTarget({ x: 300, y: strip.bottom + DETACH_BELOW_PX + 1 }, strip, viewport)).toBe(
      true,
    );
    expect(detachTarget({ x: 300, y: 500 }, strip, viewport)).toBe(true);
  });

  it('a release outside the window detaches whatever the height', () => {
    expect(detachTarget({ x: -10, y: 20 }, strip, viewport)).toBe(true);
    expect(detachTarget({ x: 1300, y: 20 }, strip, viewport)).toBe(true);
    expect(detachTarget({ x: 300, y: -5 }, strip, viewport)).toBe(true);
  });
});

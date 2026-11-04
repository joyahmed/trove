import { describe, expect, it } from 'vitest';
import { previewFits } from './panes';

describe('previewFits', () => {
  it('shows when the list keeps 360px and the pane gets 240px', () => {
    expect(previewFits(248 + 360 + 240, 248)).toBe(true);
  });
  it('hides one pixel short', () => {
    expect(previewFits(248 + 360 + 240 - 1, 248)).toBe(false);
  });
  it('hides at the 800px minimum window with a 248px sidebar', () => {
    expect(previewFits(800, 248)).toBe(false);
  });
  it('fits at 800px once the navigation pane is hidden (PaneHost passes width 0)', () => {
    expect(previewFits(800, 0)).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/window', async (real) => ({
  ...(await real<typeof import('$lib/api/window')>()),
  arrangeWindows: vi.fn(async () => {}),
}));

const win = await import('$lib/api/window');
const { paletteActions } = await import('./palette-actions');
const { paletteActionRunners } = await import('./palette-action-runners');

describe('paletteActionRunners', () => {
  it('has a runner for every palette action (a key without one is silently ignored)', () => {
    const missing = paletteActions.map((a) => a.key).filter((k) => !(k in paletteActionRunners));
    expect(missing).toEqual([]);
  });
  it('has no runner without a row', () => {
    const keys = new Set(paletteActions.map((a) => a.key));
    expect(Object.keys(paletteActionRunners).filter((k) => !keys.has(k))).toEqual([]);
  });
  it('the three arrange rows arrange every window (plan 20)', async () => {
    await paletteActionRunners['cascade-windows']();
    await paletteActionRunners['stack-windows']();
    await paletteActionRunners['windows-side-by-side']();
    expect(vi.mocked(win.arrangeWindows).mock.calls).toEqual([
      ['cascade'],
      ['stacked'],
      ['side-by-side'],
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstWholeCrumb, fitCrumbRow, watchCrumbFit, type FontEvents } from './crumb-fit';

describe('firstWholeCrumb', () => {
  it('shows every crumb when the path fits', () => {
    expect(firstWholeCrumb([40, 60, 50], 150, 20)).toBe(0);
    expect(firstWholeCrumb([40, 60, 50], 400, 20)).toBe(0);
  });
  it('hides leading crumbs whole, leaving room for the "…"', () => {
    // 150 > 140: drop 40 → 110 + 20 = 130 fits
    expect(firstWholeCrumb([40, 60, 50], 140, 20)).toBe(1);
    // 110 + 20 = 130 > 125: drop 60 too → 50 + 20 fits
    expect(firstWholeCrumb([40, 60, 50], 125, 20)).toBe(2);
  });
  it('counts the "…" itself: a path one "…" too wide drops one more crumb', () => {
    // 100 + 30 = 130 > 120 after dropping the first, so the second goes too
    expect(firstWholeCrumb([30, 50, 50], 120, 30)).toBe(2);
  });
  it('never hides the last crumb, even when it alone is too wide', () => {
    expect(firstWholeCrumb([40, 60, 500], 100, 20)).toBe(2);
    expect(firstWholeCrumb([500], 100, 20)).toBe(0);
  });
  it('no crumbs: nothing to hide', () => expect(firstWholeCrumb([], 0, 20)).toBe(0));
});

/** A fake element: a width and a style, enough for `fitCrumbRow` (vitest runs without a DOM). */
type Fake = { w: number; squeezed?: number; style: { display: string; flexShrink: string } };
const el = (w: number, squeezed?: number): Fake => ({
  w,
  squeezed,
  style: { display: '', flexShrink: '' },
});
const rect = (e: Fake) => ({
  // hidden measures 0; a shrinkable crumb measures squeezed unless held at flex-shrink 0
  width:
    e.style.display === 'none'
      ? 0
      : e.squeezed !== undefined && e.style.flexShrink !== '0'
        ? e.squeezed
        : e.w,
});
const fakeRow = (rowW: number, crumbs: Fake[]) => {
  const more = el(16);
  const tail = el(15);
  const self = el(rowW);
  const row = {
    getBoundingClientRect: () => rect(self),
    querySelector: (s: string) =>
      s === '[data-crumb-more]'
        ? withRect(more)
        : s === '[data-crumb-tail]'
          ? withRect(tail)
          : null,
    querySelectorAll: () => crumbs.map(withRect),
  };
  return { row: row as unknown as HTMLElement, more, crumbs };
};
const withRect = (e: Fake) => Object.assign(e, { getBoundingClientRect: () => rect(e) });
const shown = (crumbs: Fake[]) => crumbs.map((c) => c.style.display !== 'none');

describe('fitCrumbRow', () => {
  it('hides leading crumbs whole and shows the "…"', () => {
    const { row, more, crumbs } = fakeRow(215, [el(80), el(80), el(80)]);
    fitCrumbRow(row); // room 200: 240 > 200, drop one → 160 + 16 fits
    expect(shown(crumbs)).toEqual([false, true, true]);
    expect(more.style.display).toBe('');
  });
  it('a path that fits shows every crumb and no "…"', () => {
    const { row, more, crumbs } = fakeRow(400, [el(80), el(80)]);
    fitCrumbRow(row);
    expect(shown(crumbs)).toEqual([true, true]);
    expect(more.style.display).toBe('none');
  });
  it('measures the shrinkable last crumb at its full width, then lets it shrink again', () => {
    // squeezed, the last crumb would measure 20 and everything would seem to fit
    const { row, crumbs } = fakeRow(215, [el(80), el(80), el(300, 20)]);
    fitCrumbRow(row);
    expect(shown(crumbs)).toEqual([false, false, true]);
    expect(crumbs.map((c) => c.style.flexShrink)).toEqual(['', '', '']);
  });
});

describe('fitCrumbRow, shrink then grow (E.6.9)', () => {
  it('widening the row brings every folded crumb back, the last one whole', () => {
    const self = el(215);
    const crumbs = [el(80), el(80), el(80, 30)];
    const { row, more } = fakeRow(0, crumbs);
    (row as unknown as { getBoundingClientRect: () => { width: number } }).getBoundingClientRect =
      () => rect(self);
    fitCrumbRow(row); // room 200 < 240: the first folds
    expect(shown(crumbs)).toEqual([false, true, true]);
    self.w = 400;
    fitCrumbRow(row);
    expect(shown(crumbs)).toEqual([true, true, true]);
    expect(more.style.display).toBe('none');
    expect(crumbs.map((c) => c.style.flexShrink)).toEqual(['', '', '']);
  });
  it('never drops the last crumb while it fits, at any width', () => {
    const self = el(0);
    const crumbs = [el(80), el(80), el(120, 30)];
    const { row } = fakeRow(0, crumbs);
    (row as unknown as { getBoundingClientRect: () => { width: number } }).getBoundingClientRect =
      () => rect(self);
    for (const w of [500, 215, 150, 800, 140, 1200]) {
      self.w = w;
      fitCrumbRow(row);
      expect(crumbs[2].style.display).not.toBe('none');
      if (w - 15 >= 120 + 16) expect(crumbs[2].style.flexShrink).toBe('');
    }
  });
});

describe('watchCrumbFit', () => {
  const observers = () => {
    class Obs {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', Obs);
    vi.stubGlobal('MutationObserver', Obs);
  };
  afterEach(() => vi.unstubAllGlobals());

  it('a resize fits now and again on the next frame, and cleanup cancels it', () => {
    let onResize!: () => void;
    class RO {
      constructor(cb: () => void) {
        onResize = cb;
      }
      observe() {}
      disconnect() {}
    }
    class MO {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', RO);
    vi.stubGlobal('MutationObserver', MO);
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => frames.push(f));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const self = el(215);
    const crumbs = [el(80), el(80), el(80)];
    const { row } = fakeRow(0, crumbs);
    (row as unknown as { getBoundingClientRect: () => { width: number } }).getBoundingClientRect =
      () => rect(self);
    const stop = watchCrumbFit(row, undefined);
    expect(shown(crumbs)).toEqual([false, true, true]);
    self.w = 400;
    onResize();
    expect(shown(crumbs)).toEqual([true, true, true]);
    self.w = 215; // the row was still settling at the first fit
    frames.at(-1)!();
    expect(shown(crumbs)).toEqual([false, true, true]);
    stop();
  });

  it('re-fits when a web font lands, and stops listening on cleanup', async () => {
    observers();
    const listeners = new Set<() => void>();
    let ready!: () => void;
    const fonts = {
      ready: new Promise<void>((r) => (ready = r)),
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
    } as unknown as FontEvents;
    const { row, crumbs } = fakeRow(215, [el(60), el(60), el(60)]);
    const stop = watchCrumbFit(row, fonts);
    expect(shown(crumbs)).toEqual([true, true, true]); // 180 fits in 200

    // the swap face is wider: every crumb grows, the row does not
    for (const c of crumbs) c.w = 80;
    ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(shown(crumbs)).toEqual([false, true, true]);

    for (const c of crumbs) c.w = 120;
    for (const f of listeners) f(); // a later subset: `loadingdone`
    expect(shown(crumbs)).toEqual([false, false, true]);

    stop();
    expect(listeners.size).toBe(0);
  });
});

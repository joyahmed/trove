// Escape during a rubber band (plan 15 E.2.5): the band goes, the pick from before the press
// comes back, and the mouse release that follows is not a background click.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { selection } from '$lib/state/selection.svelte';
import { rubberBand } from '$lib/state/rubber-band.svelte';
import { useRubberBand } from './use-rubber-band.svelte';

const paths = Array.from({ length: 10 }, (_, i) => `/r${i}`);

const el = {
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 200 }),
  scrollLeft: 0,
  scrollTop: 0,
  setPointerCapture: () => {},
} as unknown as HTMLElement;

const make = () =>
  useRubberBand(() => ({
    layout: {
      horizontal: false,
      chunkSize: 20,
      perChunk: 1,
      itemSpan: 0,
      paddingStart: 0,
      total: 10,
      plan: null,
    },
    order: paths,
    element: el,
  }));

const ptr = (y: number, extra: Partial<PointerEvent> = {}) =>
  ({
    button: 0,
    buttons: 1,
    clientX: y > 5 ? 90 : 50,
    clientY: y,
    pointerId: 1,
    ...extra,
  }) as PointerEvent;
const esc = () => ({ key: 'Escape', preventDefault: () => {} }) as KeyboardEvent;

beforeEach(() => {
  vi.stubGlobal('HTMLInputElement', class {});
  vi.stubGlobal('getComputedStyle', () => ({ paddingLeft: '0', paddingTop: '0' }));
  rubberBand.end();
  selection.replaceAll([]);
});

describe('Escape during a rubber band', () => {
  it('puts the old pick back and swallows the release', () => {
    selection.replaceAll(['/r9']);
    const band = make();
    band.onpointerdown(ptr(5));
    band.onpointermove(ptr(65));
    expect(band.active).toBe(true);
    expect(selection.paths.has('/r0')).toBe(true);

    expect(band.onkeydown(esc())).toBe(true);
    expect(band.active).toBe(false);
    expect([...selection.paths]).toEqual(['/r9']);

    expect(band.onpointerup()).toBe(true); // the release is not a background click
    expect(band.onpointerup()).toBe(false); // and only once
  });

  it('a later press forgets a release that never came', () => {
    const band = make();
    band.onpointerdown(ptr(5));
    band.onpointermove(ptr(65));
    band.onkeydown(esc());
    band.onpointerdown(ptr(5));
    expect(band.onpointerup()).toBe(false);
  });

  it('a plain click without a band is still a background click', () => {
    const band = make();
    band.onpointerdown(ptr(5));
    expect(band.onpointerup()).toBe(false);
  });
});

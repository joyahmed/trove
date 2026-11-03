import { describe, expect, it } from 'vitest';
import { itemsInRect, rectFrom, type BandLayout } from './rubber-band.svelte';
import { planChunks } from '$lib/utils/virtual';

// the real layouts from data/view-layouts.ts, with the per-chunk counts the viewport gives
const details: BandLayout = {
  horizontal: false,
  chunkSize: 28,
  perChunk: 1,
  itemSpan: 0,
  paddingStart: 8,
  total: 100,
};
const grid: BandLayout = {
  horizontal: false,
  chunkSize: 116,
  perChunk: 4,
  itemSpan: 100,
  paddingStart: 8,
  total: 10,
};
const list: BandLayout = {
  horizontal: true,
  chunkSize: 232,
  perChunk: 5,
  itemSpan: 22,
  paddingStart: 0,
  total: 12,
};

describe('itemsInRect', () => {
  it('details: a band down the rows picks the range it crosses, whatever the x', () => {
    // rows 2..4 sit at 8+56=64 .. 8+140=148
    expect(itemsInRect({ left: 300, top: 70, width: 5, height: 60 }, details)).toEqual([2, 3, 4]);
    // touching the top edge of row 0 only
    expect(itemsInRect({ left: 0, top: 0, width: 10, height: 10 }, details)).toEqual([0]);
  });

  it('grid: a 2×2 corner of tiles', () => {
    // second tile column starts at x=100, second row at y=8+116=124, third at 240
    expect(itemsInRect({ left: 110, top: 130, width: 100, height: 100 }, grid)).toEqual([5, 6]);
    expect(itemsInRect({ left: 110, top: 130, width: 100, height: 120 }, grid)).toEqual([5, 6, 9]);
  });

  it('list: chunks are columns and items stack down them', () => {
    // second column x=232..464, items 1..2 at y=22..66
    expect(itemsInRect({ left: 240, top: 25, width: 10, height: 40 }, list)).toEqual([6, 7]);
    // a band across two columns at the top row
    expect(itemsInRect({ left: 200, top: 0, width: 100, height: 5 }, list)).toEqual([0, 5]);
  });

  it('nothing for an empty list, a zero-area rect, or a band past the end', () => {
    expect(
      itemsInRect({ left: 0, top: 0, width: 50, height: 50 }, { ...details, total: 0 }),
    ).toEqual([]);
    expect(itemsInRect({ left: 10, top: 10, width: 0, height: 0 }, details)).toEqual([]);
    expect(itemsInRect({ left: 0, top: 8 + 28 * 100 + 5, width: 50, height: 50 }, details)).toEqual(
      [],
    );
  });

  it('never returns an index at or past total in a partial last chunk', () => {
    // grid has 10 items: the third row holds 8 and 9 only
    const hits = itemsInRect({ left: 0, top: 8 + 232, width: 400, height: 116 }, grid);
    expect(hits).toEqual([8, 9]);
  });
});

describe('rectFrom', () => {
  it('normalises two corners in any order', () => {
    expect(rectFrom(10, 20, 5, 2)).toEqual({ left: 5, top: 2, width: 5, height: 18 });
  });
});

// A grouped grid: heading, three tiles, heading, four tiles — the chunks are no longer one
// size, so the band has to walk the plan the virtualizer was given rather than divide.
describe('itemsInRect over a chunk plan', () => {
  const isHeaderAt = (i: number) => i === 0 || i === 4;
  const plan = planChunks(9, 4, isHeaderAt, { chunkSize: 116, headerSize: 34, paddingStart: 8 });
  // [0] heading at 8..42, [1] tiles 1-3 at 42..158, [2] heading at 158..192, [3] tiles 5-8 at 192..308
  const grouped: BandLayout = {
    horizontal: false,
    chunkSize: 116,
    perChunk: 4,
    itemSpan: 100,
    paddingStart: 8,
    total: 9,
    plan,
  };

  it('takes the tiles of the row it covers and never the heading above them', () => {
    expect(itemsInRect({ left: 0, top: 42, width: 400, height: 116 }, grouped)).toEqual([1, 2, 3]);
  });

  it('stops at the bucket’s width instead of running into the next bucket’s slots', () => {
    // the first bucket holds three tiles; the fourth slot of that row belongs to nobody
    expect(itemsInRect({ left: 0, top: 50, width: 400, height: 10 }, grouped)).toEqual([1, 2, 3]);
  });

  it('crosses a heading to take the buckets on both sides of it', () => {
    expect(itemsInRect({ left: 0, top: 100, width: 400, height: 150 }, grouped)).toEqual([
      1, 2, 3, 5, 6, 7, 8,
    ]);
  });

  it('takes nothing while the rectangle sits inside a heading’s band', () => {
    expect(itemsInRect({ left: 0, top: 160, width: 400, height: 20 }, grouped)).toEqual([]);
  });

  it('narrows to the columns the rectangle reaches across', () => {
    expect(itemsInRect({ left: 110, top: 200, width: 120, height: 40 }, grouped)).toEqual([6, 7]);
  });

  it('takes nothing past the end of the plan', () => {
    expect(itemsInRect({ left: 0, top: 400, width: 400, height: 100 }, grouped)).toEqual([]);
  });
});

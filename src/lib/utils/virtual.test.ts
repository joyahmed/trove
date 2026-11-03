import { describe, expect, it } from 'vitest';
import { viewLayouts } from '$lib/data/view-layouts';
import {
  chunkAtItem,
  chunkAtOffset,
  chunkCount,
  chunkOf,
  chunkRange,
  itemsPerChunk,
  planChunks,
} from './virtual';

describe('itemsPerChunk', () => {
  it('details is always one row per chunk', () => {
    expect(itemsPerChunk(viewLayouts.details, 1200, 800)).toBe(1);
    expect(itemsPerChunk(viewLayouts.details, 0, 0)).toBe(1);
  });

  it('grid counts 124 px tiles (120 wide + 4 gap, Medium) across the width', () => {
    expect(itemsPerChunk(viewLayouts.grid, 992, 600)).toBe(8);
    expect(itemsPerChunk(viewLayouts.grid, 991, 600)).toBe(7);
  });

  it('list counts 22 px items down the height', () => {
    expect(itemsPerChunk(viewLayouts.list, 1000, 660)).toBe(30);
    expect(itemsPerChunk(viewLayouts.list, 1000, 659)).toBe(29);
  });

  it('never goes below one item, however small the viewport', () => {
    expect(itemsPerChunk(viewLayouts.grid, 50, 50)).toBe(1);
    expect(itemsPerChunk(viewLayouts.list, 50, 10)).toBe(1);
  });
});

describe('chunk math', () => {
  it('rounds the chunk count up and handles zero', () => {
    expect(chunkCount(100_000, 1)).toBe(100_000);
    expect(chunkCount(100_000, 7)).toBe(14_286);
    expect(chunkCount(0, 7)).toBe(0);
  });

  it('maps an item to its chunk', () => {
    expect(chunkOf(0, 7)).toBe(0);
    expect(chunkOf(6, 7)).toBe(0);
    expect(chunkOf(7, 7)).toBe(1);
    expect(chunkOf(99_999, 1)).toBe(99_999);
  });

  it('clips the last chunk to the item count', () => {
    expect(chunkRange(0, 7, 20)).toEqual([0, 7]);
    expect(chunkRange(2, 7, 20)).toEqual([14, 20]);
    expect(chunkRange(3, 7, 20)).toEqual([21, 20]); // past the end: empty
  });
});

// A grouped list: the rendered items are headings and rows mixed, and `planChunks` cuts them
// into the boxes the virtualizer measures. `H` marks a heading.
const at = (pattern: string) => (i: number) => pattern[i] === 'H';

describe('planChunks', () => {
  const DETAILS = { chunkSize: 28, headerSize: 28, paddingStart: 8 };
  // the grid at Medium: 116 px per row of tiles, a 34 px heading, four tiles across
  const GRID = { chunkSize: 116, headerSize: 34, paddingStart: 8 };

  it('gives a heading a chunk of its own and packs the rows under it', () => {
    // H r r r H r r  →  [H][r][r][r][H][r][r] in details, one row per chunk
    const plan = planChunks(7, 1, at('HrrrHrr'), DETAILS);
    expect(plan.map((c) => c.header)).toEqual([true, false, false, false, true, false, false]);
    expect(plan.map((c) => c.first)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(plan.every((c) => c.count === 1)).toBe(true);
  });

  it('never lets two buckets share a row of tiles', () => {
    // four across, but the first bucket has three tiles: the second bucket starts a new chunk
    const plan = planChunks(9, 4, at('HrrrHrrrr'), GRID);
    expect(plan.map((c) => [c.first, c.count, c.header])).toEqual([
      [0, 1, true],
      [1, 3, false],
      [4, 1, true],
      [5, 4, false],
    ]);
  });

  it('wraps a bucket longer than one row across several chunks', () => {
    const plan = planChunks(8, 3, at('Hrrrrrrr'), GRID);
    expect(plan.map((c) => [c.first, c.count])).toEqual([
      [0, 1],
      [1, 3],
      [4, 3],
      [7, 1],
    ]);
  });

  it('accumulates the offsets from paddingStart, a heading costing its own height', () => {
    const plan = planChunks(6, 4, at('HrrHrr'), GRID);
    expect(plan.map((c) => c.offset)).toEqual([8, 42, 158, 192]);
    expect(plan.map((c) => c.size)).toEqual([34, 116, 34, 116]);
  });

  it('plans an empty list as no chunks at all', () => {
    expect(planChunks(0, 4, at(''), GRID)).toEqual([]);
  });

  it('never packs fewer than one item, however narrow the viewport', () => {
    const plan = planChunks(3, 0, at('Hrr'), GRID);
    expect(plan.map((c) => c.count)).toEqual([1, 1, 1]);
  });
});

describe('chunkAtItem and chunkAtOffset', () => {
  const GRID = { chunkSize: 116, headerSize: 34, paddingStart: 8 };
  // [H][r r r][H][r r r r]
  const plan = planChunks(9, 4, at('HrrrHrrrr'), GRID);

  it('finds the chunk an item sits in', () => {
    expect(chunkAtItem(plan, 0)).toBe(0);
    expect(chunkAtItem(plan, 1)).toBe(1);
    expect(chunkAtItem(plan, 3)).toBe(1);
    expect(chunkAtItem(plan, 4)).toBe(2);
    expect(chunkAtItem(plan, 8)).toBe(3);
  });

  it('answers -1 past the end and on an empty plan', () => {
    expect(chunkAtItem(plan, 9)).toBe(-1);
    expect(chunkAtItem([], 0)).toBe(-1);
  });

  it('finds the first chunk a scroll offset reaches', () => {
    expect(chunkAtOffset(plan, 0)).toBe(0);
    expect(chunkAtOffset(plan, 41)).toBe(0);
    expect(chunkAtOffset(plan, 42)).toBe(1);
    expect(chunkAtOffset(plan, 157)).toBe(1);
    expect(chunkAtOffset(plan, 158)).toBe(2);
    // past everything: one off the end, so the band's walk stops immediately
    expect(chunkAtOffset(plan, 10_000)).toBe(plan.length);
  });
});

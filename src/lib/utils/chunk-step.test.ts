import { describe, expect, it } from 'vitest';
import { viewLayouts } from '$lib/data/view-layouts';
import { stepAcrossChunks } from './chunk-step';
import { planChunks } from './virtual';

// Three tiles across. Group A has 4 items (a1..a4: a row of 3, then a row of 1), group B has 5.
const rendered = [
  undefined, // heading A
  'a1',
  'a2',
  'a3',
  'a4',
  undefined, // heading B
  'b1',
  'b2',
  'b3',
  'b4',
  'b5',
];
const order = rendered.filter((p): p is string => p !== undefined);
const plan = planChunks(rendered.length, 3, (i) => rendered[i] === undefined, viewLayouts.grid);
const step = (from: string, dir: 1 | -1) => {
  const i = stepAcrossChunks(plan, rendered, order, from, dir);
  return i === null ? null : order[i];
};

describe('stepAcrossChunks', () => {
  it('goes to the same slot of the next row inside a group', () => {
    expect(step('a2', 1)).toBe('a4'); // slot 1 of a one-tile row clamps to its last tile
    expect(step('a1', 1)).toBe('a4');
  });

  it('crosses a heading to the same slot of the next group', () => {
    expect(step('a4', 1)).toBe('b1');
    expect(step('b2', -1)).toBe('a4'); // up over the heading, slot 1 clamps to the short row
  });

  it('clamps to the last tile when the next row is shorter', () => {
    expect(step('b3', 1)).toBe('b5'); // slot 2 of the last row [b4 b5] -> b5
  });

  it('goes up the same way, over the heading, and not past the first row', () => {
    expect(step('b1', -1)).toBe('a4');
    expect(step('b4', -1)).toBe('b1');
    expect(step('a2', -1)).toBeNull();
  });

  it('has nothing further past the last row, and nothing for a row that is not on screen', () => {
    expect(step('b5', 1)).toBeNull();
    expect(stepAcrossChunks(plan, rendered, order, 'folded', 1)).toBeNull();
    expect(stepAcrossChunks(plan, rendered, order, null, 1)).toBeNull();
  });
});

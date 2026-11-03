import { describe, expect, it } from 'vitest';
import type { SortKey } from '$lib/data/file-columns';
import { cleanColumnOrder, dropSlot, insertColumn, moveColumn, shiftColumn } from './column-order';

const FOUR: SortKey[] = ['name', 'modifiedMs', 'ext', 'size'];

describe('moveColumn (G.59)', () => {
  it('moves a column into a gap, left or right', () => {
    expect(moveColumn(FOUR, 'size', 1)).toEqual(['name', 'size', 'modifiedMs', 'ext']);
    expect(moveColumn(FOUR, 'modifiedMs', 4)).toEqual(['name', 'ext', 'size', 'modifiedMs']);
    expect(moveColumn(FOUR, 'modifiedMs', 3)).toEqual(['name', 'ext', 'modifiedMs', 'size']);
  });

  it('a gap beside the column itself is no move, and returns the same array', () => {
    expect(moveColumn(FOUR, 'ext', 2)).toBe(FOUR);
    expect(moveColumn(FOUR, 'ext', 3)).toBe(FOUR);
  });

  it('Name never moves, and nothing goes before it', () => {
    expect(moveColumn(FOUR, 'name', 3)).toBe(FOUR);
    expect(moveColumn(FOUR, 'size', 0)).toEqual(['name', 'size', 'modifiedMs', 'ext']);
    expect(moveColumn(FOUR, 'size', -5)).toEqual(['name', 'size', 'modifiedMs', 'ext']);
  });

  it('a column not shown, or a gap past the end, is handled', () => {
    expect(moveColumn(FOUR, 'dims', 1)).toBe(FOUR);
    expect(moveColumn(FOUR, 'modifiedMs', 99)).toEqual(['name', 'ext', 'size', 'modifiedMs']);
  });

  it('never loses or repeats a column', () => {
    for (const key of FOUR)
      for (let gap = -1; gap <= 5; gap++) {
        const out = moveColumn(FOUR, key, gap);
        expect([...out].sort()).toEqual([...FOUR].sort());
        expect(out[0]).toBe('name');
      }
  });
});

describe('shiftColumn: Alt+← / Alt+→', () => {
  it('moves one place, and stops at the ends and at Name', () => {
    expect(shiftColumn(FOUR, 'ext', 1)).toEqual(['name', 'modifiedMs', 'size', 'ext']);
    expect(shiftColumn(FOUR, 'ext', -1)).toEqual(['name', 'ext', 'modifiedMs', 'size']);
    expect(shiftColumn(FOUR, 'size', 1)).toBe(FOUR);
    expect(shiftColumn(FOUR, 'modifiedMs', -1)).toBe(FOUR);
    expect(shiftColumn(FOUR, 'name', 1)).toBe(FOUR);
  });
});

describe('dropSlot', () => {
  it('counts the header middles left of the pointer', () => {
    const middles = [100, 300, 450, 560];
    expect(dropSlot(middles, 50)).toBe(0);
    expect(dropSlot(middles, 301)).toBe(2);
    expect(dropSlot(middles, 1000)).toBe(4);
  });
});

describe('insertColumn: turning a column on keeps the person’s order', () => {
  it('a never-reordered list stays in Explorer’s order', () => {
    expect(insertColumn(FOUR, 'createdMs')).toEqual([
      'name',
      'modifiedMs',
      'createdMs',
      'ext',
      'size',
    ]);
    expect(insertColumn(FOUR, 'dims')).toEqual([...FOUR, 'dims']);
  });

  it('a reordered list keeps its order; the new one follows its Explorer neighbour', () => {
    const mine: SortKey[] = ['name', 'size', 'modifiedMs', 'ext'];
    expect(insertColumn(mine, 'createdMs')).toEqual([
      'name',
      'size',
      'modifiedMs',
      'createdMs',
      'ext',
    ]);
    expect(insertColumn(mine, 'size')).toBe(mine);
  });
});

describe('cleanColumnOrder: a stored list', () => {
  it('keeps the order, drops junk, repeats and Folder, puts Name first', () => {
    expect(cleanColumnOrder(['size', 'nope', 'ext', 'size', 'path', 3])).toEqual([
      'name',
      'size',
      'ext',
    ]);
    expect(cleanColumnOrder(['ext', 'name', 'size'])).toEqual(['name', 'ext', 'size']);
    expect(cleanColumnOrder([])).toEqual(['name']);
  });
});

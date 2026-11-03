import { describe, expect, it } from 'vitest';
import { rowId } from './row-id';

describe('rowId', () => {
  it('is stable and a valid id', () => {
    expect(rowId('C:\\a\\b.txt')).toBe(rowId('C:\\a\\b.txt'));
    expect(rowId('C:\\a\\b.txt')).toMatch(/^row-[0-9a-z]+$/);
  });
  it('differs between paths', () => {
    const ids = new Set(['/a/1', '/a/2', '/a/12', '/b/1', 'x', 'X'].map(rowId));
    expect(ids.size).toBe(6);
  });
});

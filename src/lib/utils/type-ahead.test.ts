import { describe, expect, it } from 'vitest';
import { isTypeAheadKey, nextMatch, typeAheadStep } from './type-ahead';

const names = ['Desktop', 'Documents', 'Downloads', 'Music', 'notes.txt', 'Pictures'];

describe('nextMatch', () => {
  it('finds the first name with the prefix, case-insensitively, from the start', () => {
    expect(nextMatch(names, -1, 'd')).toBe(0);
    expect(nextMatch(names, -1, 'MU')).toBe(3);
    expect(nextMatch(names, -1, 'doc')).toBe(1);
  });

  it('searches after the focused row first and wraps round', () => {
    expect(nextMatch(names, 0, 'd')).toBe(1);
    expect(nextMatch(names, 2, 'd')).toBe(0);
    expect(nextMatch(names, 5, 'n')).toBe(4);
  });

  it('returns -1 when nothing matches or there is nothing to match', () => {
    expect(nextMatch(names, 0, 'zz')).toBe(-1);
    expect(nextMatch([], 0, 'a')).toBe(-1);
    expect(nextMatch(names, 0, '')).toBe(-1);
  });

  it('a longer prefix narrows to the one name', () => {
    expect(nextMatch(names, 0, 'dow')).toBe(2);
    expect(nextMatch(names, 2, 'dow')).toBe(2);
  });
});

// replays keys through the same step the hook takes; a gap longer than the timeout clears the buffer
const type = (list: string[], keys: string, from: number) => {
  let prefix = '';
  let focus = from;
  for (const key of keys) {
    if (key === '|') {
      prefix = '';
      continue;
    }
    const step = typeAheadStep(prefix, key);
    prefix = step.prefix;
    const i = nextMatch(list, focus, prefix, step.grew);
    if (i >= 0) focus = i;
  }
  return focus;
};

describe('typing a growing prefix', () => {
  it('keeps the focused row when it still matches', () => {
    expect(type(['repair.txt', 'report.txt'], 'rep', -1)).toBe(0);
    expect(type(['doc.pdf', 'dog.txt'], 'do', -1)).toBe(0);
  });

  it('moves on when the focused row stops matching', () => {
    expect(type(['repair.txt', 'report.txt'], 'repo', -1)).toBe(1);
  });

  it('a repeated letter steps through the matches', () => {
    expect(type(['dog', 'doc', 'dig'], 'dd', -1)).toBe(1);
    expect(type(['dog', 'doc', 'dig'], 'ddd', -1)).toBe(2);
  });

  it('after the timeout a new buffer starts at the next row', () => {
    expect(type(['dog', 'doc', 'dig'], 'd|d', -1)).toBe(1);
  });
});

describe('isTypeAheadKey', () => {
  it('accepts printable characters and refuses chords, space and named keys', () => {
    const k = (
      key: string,
      mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {},
    ) => isTypeAheadKey({ key, ctrlKey: false, altKey: false, metaKey: false, ...mods });
    expect(k('a')).toBe(true);
    expect(k('É')).toBe(true);
    expect(k(' ')).toBe(false);
    expect(k('Enter')).toBe(false);
    expect(k('a', { ctrlKey: true })).toBe(false);
    expect(k('a', { altKey: true })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { menuKey, stepIndex } from './menu-keys';

const key = (k: string, mods: Partial<{ ctrl: boolean; alt: boolean; meta: boolean }> = {}) => ({
  key: k,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: false,
  metaKey: mods.meta ?? false,
});

describe('menuKey', () => {
  it('maps the menu keys', () => {
    expect(menuKey(key('ArrowDown'))).toBe('next');
    expect(menuKey(key('ArrowUp'))).toBe('prev');
    expect(menuKey(key('Home'))).toBe('first');
    expect(menuKey(key('End'))).toBe('last');
    expect(menuKey(key('ArrowRight'))).toBe('open');
    expect(menuKey(key('ArrowLeft'))).toBe('back');
    expect(menuKey(key('Enter'))).toBe('run');
    expect(menuKey(key(' '))).toBe('run');
    expect(menuKey(key('Escape'))).toBe('close');
    expect(menuKey(key('Tab'))).toBe('tab');
  });

  it('leaves other keys and every chord alone', () => {
    expect(menuKey(key('a'))).toBeNull();
    expect(menuKey(key('Delete'))).toBeNull();
    expect(menuKey(key('ArrowDown', { ctrl: true }))).toBeNull();
    expect(menuKey(key('Enter', { alt: true }))).toBeNull();
    expect(menuKey(key('Escape', { meta: true }))).toBeNull();
  });
});

describe('stepIndex', () => {
  // row 1 is a divider, row 3 is disabled
  const rows = [true, false, true, false, true];

  it('moves down and up, skipping rows that cannot take focus', () => {
    expect(stepIndex(rows, 0, 'next')).toBe(2);
    expect(stepIndex(rows, 2, 'next')).toBe(4);
    expect(stepIndex(rows, 4, 'prev')).toBe(2);
    expect(stepIndex(rows, 2, 'prev')).toBe(0);
  });

  it('wraps around at both ends', () => {
    expect(stepIndex(rows, 4, 'next')).toBe(0);
    expect(stepIndex(rows, 0, 'prev')).toBe(4);
  });

  it('from no row, ↓ lands on the first row and ↑ on the last', () => {
    expect(stepIndex(rows, -1, 'next')).toBe(0);
    expect(stepIndex(rows, -1, 'prev')).toBe(4);
    expect(stepIndex([false, true, true, false], -1, 'next')).toBe(1);
    expect(stepIndex([false, true, true, false], -1, 'prev')).toBe(2);
  });

  it('Home and End go to the first and last focusable row', () => {
    expect(stepIndex([false, true, true, false], 2, 'first')).toBe(1);
    expect(stepIndex([false, true, true, false], 1, 'last')).toBe(2);
  });

  it('stays put on the only focusable row, and finds nothing in a menu of none', () => {
    expect(stepIndex([false, true, false], 1, 'next')).toBe(1);
    expect(stepIndex([false, true, false], 1, 'prev')).toBe(1);
    expect(stepIndex([false, false], -1, 'next')).toBe(-1);
    expect(stepIndex([], -1, 'first')).toBe(-1);
  });
});

import { describe, expect, it } from 'vitest';
import { isMenuKey, menuAnchor, menuTarget } from './key-menu';

const key = (
  k: string,
  mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {},
) => ({
  key: k,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
  metaKey: mods.meta ?? false,
});

describe('isMenuKey', () => {
  it('takes the Menu key and Shift+F10', () => {
    expect(isMenuKey(key('ContextMenu'))).toBe(true);
    expect(isMenuKey(key('F10', { shift: true }))).toBe(true);
  });

  it('leaves plain F10 and any chord with Ctrl, Alt or ⌘ alone', () => {
    expect(isMenuKey(key('F10'))).toBe(false);
    expect(isMenuKey(key('F10', { shift: true, ctrl: true }))).toBe(false);
    expect(isMenuKey(key('F10', { shift: true, alt: true }))).toBe(false);
    expect(isMenuKey(key('ContextMenu', { meta: true }))).toBe(false);
    expect(isMenuKey(key('ContextMenu', { shift: true }))).toBe(false);
    expect(isMenuKey(key('Enter', { shift: true }))).toBe(false);
  });
});

describe('menuTarget', () => {
  const order = ['a', 'b', 'c'];
  it('is the focused item when it is selected', () => {
    expect(menuTarget('b', (p) => p === 'b' || p === 'c', order)).toBe('b');
  });
  it('is the first selected item in view order when focus is elsewhere', () => {
    expect(menuTarget('a', (p) => p === 'c' || p === 'b', order)).toBe('b');
    expect(menuTarget(null, (p) => p === 'c', order)).toBe('c');
  });
  it('is the background (null) when nothing is selected, even with a focused row', () => {
    expect(menuTarget('a', () => false, order)).toBeNull();
    expect(menuTarget(null, () => false, [])).toBeNull();
  });
});

describe('menuAnchor', () => {
  it('opens inside the item, on its name line', () => {
    expect(menuAnchor({ left: 100, top: 40, width: 300, height: 28 }, true)).toEqual({
      x: 124,
      y: 54,
    });
    // a narrow tile: half its width, never past it
    expect(menuAnchor({ left: 0, top: 0, width: 20, height: 20 }, true)).toEqual({ x: 10, y: 10 });
  });
  it('opens at the view corner for the background', () => {
    expect(menuAnchor({ left: 200, top: 90, width: 800, height: 600 }, false)).toEqual({
      x: 208,
      y: 98,
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { blockBrowserKeys, isBrowserKey } from './browser-keys';

const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {},
) => ({
  key: k,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('isBrowserKey', () => {
  it('catches the reload chords', () => {
    expect(isBrowserKey(key('F5'), false)).toBe(true);
    expect(isBrowserKey(key('r', { ctrlKey: true }), false)).toBe(true);
    expect(isBrowserKey(key('R', { ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isBrowserKey(key('F5', { ctrlKey: true }), false)).toBe(true);
  });
  it('catches find, print and view-source', () => {
    for (const k of ['f', 'g', 'p', 'u']) {
      expect(isBrowserKey(key(k, { ctrlKey: true }), false)).toBe(true);
    }
    expect(isBrowserKey(key('G', { ctrlKey: true, shiftKey: true }), false)).toBe(true);
  });
  it('leaves typing and editing chords alone', () => {
    expect(isBrowserKey(key('a'), false)).toBe(false);
    expect(isBrowserKey(key('r'), false)).toBe(false);
    for (const k of ['c', 'v', 'x', 'z', 'a', 'y']) {
      expect(isBrowserKey(key(k, { ctrlKey: true }), false)).toBe(false);
    }
  });
  it('leaves Alt and Meta chords alone', () => {
    expect(isBrowserKey(key('F5', { altKey: true }), false)).toBe(false);
    expect(isBrowserKey(key('r', { metaKey: true }), false)).toBe(false);
  });
  it('blocks dev tools in a release build only', () => {
    const f12 = key('F12');
    expect(isBrowserKey(f12, false)).toBe(true);
    expect(isBrowserKey(f12, true)).toBe(false);
    const i = key('I', { ctrlKey: true, shiftKey: true });
    expect(isBrowserKey(i, false)).toBe(true);
    expect(isBrowserKey(i, true)).toBe(false);
  });
});

describe('layouts and odd events', () => {
  it('ignores a keydown with no key', () => {
    expect(isBrowserKey({ ...key('x'), key: undefined as unknown as string }, false)).toBe(false);
  });
  it('uses the physical letter on a non-Latin layout', () => {
    expect(isBrowserKey({ ...key('к', { ctrlKey: true }), code: 'KeyR' }, false)).toBe(true);
  });
  it('keeps the typed letter on AZERTY and Dvorak', () => {
    expect(isBrowserKey({ ...key('a', { ctrlKey: true }), code: 'KeyQ' }, false)).toBe(false);
    expect(isBrowserKey({ ...key('r', { ctrlKey: true }), code: 'KeyP' }, false)).toBe(true);
  });
  it('blocks history keys, but not other Alt chords', () => {
    expect(isBrowserKey(key('ArrowLeft', { altKey: true }), false)).toBe(true);
    expect(isBrowserKey(key('ArrowRight', { altKey: true }), false)).toBe(true);
    expect(isBrowserKey(key('BrowserBack'), false)).toBe(true);
    expect(isBrowserKey(key('BrowserRefresh'), false)).toBe(true);
    expect(isBrowserKey(key('d', { altKey: true }), false)).toBe(false);
    expect(isBrowserKey(key('ArrowLeft'), false)).toBe(false);
  });
});

describe('blockBrowserKeys', () => {
  it('prevents the default but lets the event reach other handlers', () => {
    const target = new EventTarget();
    const remove = blockBrowserKeys(target as unknown as Window);
    const seen = vi.fn();
    target.addEventListener('keydown', seen);
    const fire = (k: string, mods: object = {}) => {
      const e = Object.assign(new Event('keydown', { cancelable: true }), { key: k, ...mods });
      target.dispatchEvent(e);
      return e;
    };
    expect(fire('F5').defaultPrevented).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(fire('c', { ctrlKey: true }).defaultPrevented).toBe(false);
    const mouse = (button: number) => {
      const e = Object.assign(new Event('mouseup', { cancelable: true }), { button });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(mouse(3)).toBe(true);
    expect(mouse(4)).toBe(true);
    expect(mouse(0)).toBe(false);
    remove();
    expect(fire('F5').defaultPrevented).toBe(false);
  });
});

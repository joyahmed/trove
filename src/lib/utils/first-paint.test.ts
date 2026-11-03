import { describe, expect, it } from 'vitest';
import { firstPaintReady, type PaintTab } from './first-paint';

const tab = (over: Partial<PaintTab>): PaintTab => ({
  location: { kind: 'path', path: 'C:/a' },
  loading: false,
  error: null,
  entries: [],
  ...over,
});

describe('firstPaintReady', () => {
  it('counts a listed folder with its rows', () => {
    expect(firstPaintReady(tab({ entries: [1, 2, 3] }), false)).toEqual({
      what: 'folder',
      rows: 3,
    });
  });

  it('waits while the folder is still loading or failed', () => {
    expect(firstPaintReady(tab({ loading: true }), true)).toBeNull();
    expect(firstPaintReady(tab({ error: 'Access is denied.' }), true)).toBeNull();
  });

  it('never counts the empty tab before the first navigate', () => {
    expect(firstPaintReady(tab({ location: { kind: 'path', path: '' } }), true)).toBeNull();
  });

  it('counts Home and This PC only once places answered', () => {
    expect(firstPaintReady(tab({ location: { kind: 'home' } }), false)).toBeNull();
    expect(firstPaintReady(tab({ location: { kind: 'home' } }), true)).toEqual({
      what: 'home',
      rows: 0,
    });
    expect(firstPaintReady(tab({ location: { kind: 'this-pc' } }), true)?.what).toBe('this-pc');
  });

  it('counts an archive listing', () => {
    const at = { kind: 'archive', archive: 'C:/a.zip', inner: '' } as const;
    expect(firstPaintReady(tab({ location: at, entries: [1] }), false)).toEqual({
      what: 'archive',
      rows: 1,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { thumbUrl } from '$lib/api/icons';
import { FRESH_MS, isFresh, thumbKey, thumbStamp } from './thumb-stamp';

describe('thumbStamp', () => {
  it('moves when the file grows or is touched, stays when unchanged', () => {
    const a = thumbStamp({ size: 100, modifiedMs: 5000 });
    expect(thumbStamp({ size: 100, modifiedMs: 5000 })).toBe(a);
    expect(thumbStamp({ size: 200, modifiedMs: 5000 })).not.toBe(a);
    expect(thumbStamp({ size: 100, modifiedMs: 6000 })).not.toBe(a);
    expect(thumbStamp({ size: 100, modifiedMs: null })).toBe('100-0');
  });

  it('a failure memory keyed by it forgets a file that changed', () => {
    const before = thumbKey('/p/a.jpg', thumbStamp({ size: 10, modifiedMs: 1 }));
    const after = thumbKey('/p/a.jpg', thumbStamp({ size: 9000, modifiedMs: 2 }));
    expect(after).not.toBe(before);
    expect(thumbKey('/p/b.jpg', '10-1')).not.toBe(before);
  });
});

describe('isFresh', () => {
  it('is true under 10 s, false at or past it, false without an mtime', () => {
    expect(isFresh(100_000 - (FRESH_MS - 1), 100_000)).toBe(true);
    expect(isFresh(100_000 - FRESH_MS, 100_000)).toBe(false);
    expect(isFresh(null, 100_000)).toBe(false);
    expect(isFresh(0, 100_000)).toBe(false);
  });
});

describe('thumbUrl stamp', () => {
  it('without a stamp the URL is unchanged', () => {
    expect(thumbUrl('/a.jpg', 96)).toBe('http://icon.localhost/thumb/%2Fa.jpg?size=96');
  });
  it('a different stamp is a different URL; the same stamp is the same (HTTP cache holds)', () => {
    const u1 = thumbUrl('/a.jpg', 96, '10-1');
    expect(thumbUrl('/a.jpg', 96, '10-1')).toBe(u1);
    expect(thumbUrl('/a.jpg', 96, '9000-2')).not.toBe(u1);
    expect(u1).toBe('http://icon.localhost/thumb/%2Fa.jpg?size=96&v=10-1');
  });
});

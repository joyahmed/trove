import { describe, expect, it } from 'vitest';
import { dateAfter, emptyChips } from '$lib/data/search-filters';
import { parseQuery } from './search-query';

const now = new Date(2026, 8, 21, 23, 30); // Monday 21 Sep 2026

describe('parseQuery', () => {
  it('plain words are the name text, joined', () => {
    expect(parseQuery('  quarterly   report ', emptyChips())).toMatchObject({
      text: 'quarterly report',
      ext: null,
      kind: 'any',
      modifiedAfterMs: null,
      minBytes: null,
      maxBytes: null,
    });
  });

  it('*.ext and ext: set the extension, lower-cased, and leave the rest as text', () => {
    expect(parseQuery('*.PNG holiday', emptyChips())).toMatchObject({
      ext: 'png',
      text: 'holiday',
    });
    expect(parseQuery('ext:.Rs', emptyChips())).toMatchObject({ ext: 'rs', text: '' });
  });

  it('name: and kind: are understood', () => {
    expect(parseQuery('name:foo kind:folder', emptyChips())).toMatchObject({
      text: 'foo',
      kind: 'folder',
    });
    expect(parseQuery('kind:whatever', emptyChips())).toMatchObject({ text: 'kind:whatever' });
  });

  it('size: takes > / < with units, empty, and a band name', () => {
    expect(parseQuery('size:>10mb', emptyChips())).toMatchObject({
      minBytes: 10 * 1024 * 1024,
      maxBytes: null,
    });
    expect(parseQuery('size:<1kb', emptyChips())).toMatchObject({ minBytes: null, maxBytes: 1024 });
    expect(parseQuery('size:empty', emptyChips())).toMatchObject({ minBytes: 0, maxBytes: 0 });
    expect(parseQuery('size:huge', emptyChips())).toMatchObject({
      minBytes: 1024 ** 3,
      maxBytes: 4 * 1024 ** 3,
    });
  });

  it('modified: is relative to now', () => {
    expect(parseQuery('modified:today', emptyChips(), now).modifiedAfterMs).toBe(
      new Date(2026, 8, 21).getTime(),
    );
    expect(parseQuery('modified:thisweek', emptyChips(), now).modifiedAfterMs).toBe(
      new Date(2026, 8, 21).getTime(), // a Monday: the week starts today
    );
    expect(parseQuery('modified:thismonth', emptyChips(), now).modifiedAfterMs).toBe(
      new Date(2026, 8, 1).getTime(),
    );
    expect(parseQuery('modified:thisyear', emptyChips(), now).modifiedAfterMs).toBe(
      new Date(2026, 0, 1).getTime(),
    );
  });

  it('chips override the typed words on their axis', () => {
    const q = parseQuery(
      'kind:file size:>10mb modified:today',
      {
        kind: 'folder',
        modified: 'thisyear',
        size: 'tiny',
      },
      now,
    );
    expect(q).toMatchObject({
      kind: 'folder',
      modifiedAfterMs: dateAfter('thisyear', now),
      minBytes: 0,
      maxBytes: 16 * 1024,
    });
  });

  it('the week starts on Monday', () => {
    const sunday = new Date(2026, 8, 27, 12);
    expect(dateAfter('thisweek', sunday)).toBe(new Date(2026, 8, 21).getTime());
  });
});

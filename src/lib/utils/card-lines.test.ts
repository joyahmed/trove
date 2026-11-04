import { describe, expect, it } from 'vitest';
import { contentFacts, tileLines } from './card-lines';
import { fmtDate } from './format';

const file = { name: 'q3.xlsx', isDir: false, ext: 'xlsx', size: 12 * 1024, modifiedMs: 0 };
const folder = { name: 'Reports', isDir: true, ext: null, size: 0, modifiedMs: 0 };

describe('Tiles lines', () => {
  it('a file says its type and its size', () => {
    expect(tileLines(file)).toEqual(['Spreadsheet', '12 KB']);
  });
  it('an image the platform cannot draw says "HEIC · no preview", not its size (as the Icons tile)', () => {
    const heic = { name: 'x.heic', isDir: false, ext: 'heic', size: 2, modifiedMs: 0 };
    expect(tileLines(heic, 'drawn', false)).toEqual(['Image', 'HEIC · no preview']);
    expect(tileLines(heic, 'drawn', true)).toEqual(['Image', '2 B']);
    expect(tileLines({ ...heic, name: 'x.png', ext: 'png' }, 'drawn', false)[1]).toBe('2 B');
    expect(tileLines(heic)[1]).toBe('2 B');
  });
  it('a folder says Folder and no size', () => {
    expect(tileLines(folder)).toEqual(['Folder']);
  });
});

describe('Content facts', () => {
  it('a file gets the date modified and the size', () => {
    expect(contentFacts(file)).toEqual([
      { label: 'Date modified', value: fmtDate(0) },
      { label: 'Size', value: '12 KB' },
    ]);
  });
  it('a folder gets no size, and an unknown date is left out rather than blank', () => {
    expect(contentFacts(folder).map((f) => f.label)).toEqual(['Date modified']);
    expect(contentFacts({ ...folder, modifiedMs: null })).toEqual([]);
  });
});

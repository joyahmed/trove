import { describe, expect, it } from 'vitest';
import { tileMetaLine } from './tile-meta';

describe('tileMetaLine', () => {
  it('says "no preview" for a drawn image or video Rust cannot decode', () => {
    expect(tileMetaLine('a.heic', '1.2 MB', 'drawn', false)).toBe('1.2 MB · no preview');
    expect(tileMetaLine('a.webm', '3 MB', 'drawn', false)).toBe('3 MB · no preview');
  });
  it('stays plain for thumbs, shell icons and other kinds', () => {
    expect(tileMetaLine('a.png', '1 KB', 'thumb', false)).toBe('1 KB');
    expect(tileMetaLine('a.heic', '1 KB', 'shell', false)).toBe('1 KB');
    expect(tileMetaLine('a.csv', '1 KB', 'drawn', false)).toBe('1 KB');
  });
});

import { describe, expect, it } from 'vitest';
import { tileLabel } from './tile-label';
import { tileMetaLine } from './tile-meta';

describe('tileMetaLine', () => {
  it('says "HEIC · no preview" for a drawn image or video Rust cannot decode', () => {
    expect(tileMetaLine('a.heic', '1.2 MB', 'drawn', false)).toBe('HEIC · no preview');
    expect(tileMetaLine('a.webm', '3 MB', 'drawn', false)).toBe('WEBM · no preview');
  });
  it('uses the very words the Gallery uses', () => {
    expect(tileMetaLine('a.heic', '1 MB', 'drawn', false)).toBe(tileLabel('a.heic', true, false));
  });
  it('stays plain for thumbs, shell icons and other kinds', () => {
    expect(tileMetaLine('a.png', '1 KB', 'thumb', false)).toBe('1 KB');
    expect(tileMetaLine('a.heic', '1 KB', 'shell', false)).toBe('1 KB');
    expect(tileMetaLine('a.csv', '1 KB', 'drawn', false)).toBe('1 KB');
  });
});

describe('HEIC only when undecodable', () => {
  it('keeps the size where the platform decodes or draws it (a Mac with QuickLook)', () => {
    expect(tileMetaLine('a.heic', '1 MB', 'drawn', true)).toBe('1 MB');
    expect(tileMetaLine('a.jpg', '1 MB', 'thumb', false)).toBe('1 MB');
  });
});

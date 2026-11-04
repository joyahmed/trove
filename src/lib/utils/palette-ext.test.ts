import { describe, expect, it } from 'vitest';
import { extensionQuery } from './palette-ext';
import { parseQuery } from './search-query';
import { emptyChips } from '$lib/data/search-filters';

describe('extensionQuery', () => {
  it('reads `*.ext` and `.ext`', () => {
    expect(extensionQuery('*.pdf')).toBe('pdf');
    expect(extensionQuery('.pdf')).toBe('pdf');
    expect(extensionQuery('  .mp3  ')).toBe('mp3');
    expect(extensionQuery('.7z')).toBe('7z');
  });

  it('ignores case', () => {
    expect(extensionQuery('*.PDF')).toBe('pdf');
    expect(extensionQuery('.JpG')).toBe('jpg');
  });

  it('is not fooled by things that only look close', () => {
    expect(extensionQuery('pdf')).toBeNull();
    expect(extensionQuery('report.pdf')).toBeNull();
    expect(extensionQuery('*.')).toBeNull();
    expect(extensionQuery('.')).toBeNull();
    expect(extensionQuery('')).toBeNull();
    expect(extensionQuery('.2024')).toBeNull();
    expect(extensionQuery('.5')).toBeNull();
    expect(extensionQuery('*.pdf *.doc')).toBeNull();
    expect(extensionQuery('.tar.gz')).toBeNull();
    expect(extensionQuery('..pdf')).toBeNull();
    expect(extensionQuery('.abcdefghijk')).toBeNull();
    expect(extensionQuery('*.p-df')).toBeNull();
  });

  it('hands the explorer text its own parser reads as that extension', () => {
    const q = parseQuery(`*.${extensionQuery('.PDF')}`, emptyChips());
    expect(q.ext).toBe('pdf');
    expect(q.text).toBe('');
  });
});

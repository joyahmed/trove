import { describe, expect, it } from 'vitest';
import { buildSearchUrl } from './palette-search-url';

const GOOGLE = 'https://www.google.com/search?q=%s';

describe('buildSearchUrl', () => {
  it('puts the query where the %s is', () => {
    expect(buildSearchUrl(GOOGLE, 'rust')).toBe('https://www.google.com/search?q=rust');
  });

  it('encodes spaces, so a multi-word query stays one parameter', () => {
    expect(buildSearchUrl(GOOGLE, 'rust ownership')).toBe(
      'https://www.google.com/search?q=rust%20ownership',
    );
  });

  it('keeps an empty query from breaking the URL', () => {
    expect(buildSearchUrl(GOOGLE, '')).toBe('https://www.google.com/search?q=');
  });

  it('encodes the characters that would otherwise become URL structure', () => {
    // & would start a second parameter, # would start a fragment, + would read as a space,
    // and / ? = would all be taken literally by the server
    expect(buildSearchUrl(GOOGLE, 'a&b')).toBe('https://www.google.com/search?q=a%26b');
    expect(buildSearchUrl(GOOGLE, 'c#d')).toBe('https://www.google.com/search?q=c%23d');
    expect(buildSearchUrl(GOOGLE, '1+1')).toBe('https://www.google.com/search?q=1%2B1');
    expect(buildSearchUrl(GOOGLE, 'a/b?c=d')).toBe('https://www.google.com/search?q=a%2Fb%3Fc%3Dd');
  });

  it('encodes non-ASCII as UTF-8 percent escapes', () => {
    expect(buildSearchUrl(GOOGLE, 'café')).toBe('https://www.google.com/search?q=caf%C3%A9');
    expect(buildSearchUrl(GOOGLE, '日本語')).toBe(
      'https://www.google.com/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E',
    );
    expect(buildSearchUrl(GOOGLE, '🙂')).toBe('https://www.google.com/search?q=%F0%9F%99%82');
  });

  it('never lets a $ in the query act as a replacement pattern', () => {
    // encodeURIComponent turns $ into %24 — it leaves ' alone, being unreserved — so `$&`
    // (the whole match), `$'` and `` $` `` can never reach String.replace as live patterns.
    // The query lands as text, not as an instruction.
    expect(buildSearchUrl(GOOGLE, "$& $' $`")).toBe(
      "https://www.google.com/search?q=%24%26%20%24'%20%24%60",
    );
  });

  it('leaves a template with no %s alone rather than inventing a place for the query', () => {
    expect(buildSearchUrl('https://example.com/', 'rust')).toBe('https://example.com/');
  });

  it('fills only the first %s — a second one is a typo, not a second slot', () => {
    expect(buildSearchUrl('https://e.com/%s?q=%s', 'x')).toBe('https://e.com/x?q=%s');
  });

  it('works with a template whose %s is not at the end', () => {
    expect(buildSearchUrl('https://duckduckgo.com/?q=%s&ia=web', 'trove')).toBe(
      'https://duckduckgo.com/?q=trove&ia=web',
    );
  });
});

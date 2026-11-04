import { describe, expect, it } from 'vitest';
import { hitFolder } from './hit-folder';

// paths are Windows-shaped: that is the platform the pure helpers assume when none is injected
describe('hitFolder', () => {
  it('is null for a plain folder listing', () => {
    expect(hitFolder('C:\\h\\a\\b.txt', false, 'C:\\h')).toBeNull();
  });
  it('is the path relative to the search root', () => {
    expect(hitFolder('C:\\h\\a\\b\\c.txt', true, 'C:\\h')).toEqual({
      text: 'a/b',
      title: 'C:\\h\\a\\b',
    });
  });
  it('names the root for a hit directly inside it', () => {
    expect(hitFolder('C:\\h\\c.txt', true, 'C:\\h')).toEqual({ text: 'h', title: 'C:\\h' });
  });
  it('ellipsizes a deep relative path, keeping first and last', () => {
    expect(hitFolder('C:\\h\\a\\b\\c\\d\\e.txt', true, 'C:\\h')?.text).toBe('a/…/d');
  });
  it('shows the whole parent when the search began at a place or elsewhere', () => {
    expect(hitFolder('D:\\y\\z.txt', true, null)).toEqual({ text: 'D:\\y', title: 'D:\\y' });
    expect(hitFolder('D:\\y\\z.txt', true, 'C:\\h')?.text).toBe('D:\\y');
  });
  it('does not mistake a sibling with the same prefix for a child', () => {
    expect(hitFolder('C:\\hh\\a\\z.txt', true, 'C:\\h')?.text).toBe('C:\\hh\\a');
  });
});

describe('hitFolder with the home folder known', () => {
  it('a whole parent inside home starts at ~; the tooltip keeps it full', () => {
    expect(hitFolder('C:\\Users\\alex\\docs\\a.txt', true, null, 'C:\\Users\\alex')).toEqual({
      text: '~\\docs',
      title: 'C:\\Users\\alex\\docs',
    });
  });

  it('a root-relative line and a look-alike sibling are untouched', () => {
    expect(
      hitFolder('C:\\Users\\alex\\a\\b\\x.txt', true, 'C:\\Users\\alex', 'C:\\Users\\alex')?.text,
    ).toBe('a/b');
    expect(hitFolder('C:\\Users\\alexa\\x.txt', true, null, 'C:\\Users\\alex')?.text).toBe(
      'C:\\Users\\alexa',
    );
  });
});

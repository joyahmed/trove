import { describe, expect, it } from 'vitest';
import { guardedName, guardedNames, notSearchedTitle } from './guarded-folders';

describe('guarded folder names', () => {
  it('names a home folder by its own name and a Library one by what a person calls it', () => {
    expect(guardedName('/Users/sam/Desktop')).toBe('Desktop');
    expect(guardedName('/Users/sam/Library/Mobile Documents')).toBe('iCloud Drive');
    expect(guardedName('/Users/sam/Library/Unknown')).toBe('Unknown');
  });

  it('lists three names, then an ellipsis', () => {
    const four = ['Desktop', 'Documents', 'Downloads', 'Pictures'].map((n) => `/Users/sam/${n}`);
    expect(guardedNames(four)).toBe('Desktop, Documents, Downloads…');
    expect(guardedNames(four.slice(0, 2))).toBe('Desktop, Documents');
    expect(notSearchedTitle(four.slice(0, 1))).toBe('Not searched: Desktop');
  });
});

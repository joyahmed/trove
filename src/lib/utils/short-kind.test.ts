import { describe, expect, it } from 'vitest';
import { shortKindOf } from './short-kind';

const k = (name: string, ext: string | null = null, isDir = false) =>
  shortKindOf({ name, ext, isDir } as Parameters<typeof shortKindOf>[0]);

describe('shortKindOf', () => {
  it('names a folder', () => expect(k('src', null, true)).toBe('Folder'));
  it('shortens known categories', () => {
    expect(k('a.csv', 'csv')).toBe('Spreadsheet');
    expect(k('a.pdf', 'pdf')).toBe('PDF');
    expect(k('a.tar.gz', 'gz')).toBe('Archive');
    expect(k('.gitignore')).toBe('Config');
    expect(k('app.exe', 'exe')).toBe('App');
  });
  it('falls back to the upper-cased extension', () => expect(k('x.bin', 'bin')).toBe('BIN file'));
  it('falls back to File with no extension', () => expect(k('mystery')).toBe('File'));
});

describe('shortKindOf on a Mac alias (Mac, 2026-10-06)', () => {
  it('names a Finder alias "Alias", whatever its name looks like', () => {
    const alias = { isDir: false, isLink: true, typeName: 'Alias' };
    expect(shortKindOf({ ...alias, name: 'Folder X alias', ext: null })).toBe('Alias');
    expect(shortKindOf({ ...alias, name: 'photo.jpg alias', ext: 'jpg alias' })).toBe('Alias');
  });

  it('an "extension" with a space is no extension', () => {
    expect(shortKindOf({ isDir: false, name: 'photo.jpg alias', ext: 'jpg alias' })).toBe('File');
  });
});

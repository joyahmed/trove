import { describe, expect, it } from 'vitest';
import { stripExtension } from './file-name';

describe('stripExtension', () => {
  it('takes the last extension off a plain file name', () => {
    expect(stripExtension('report.pdf')).toBe('report');
    expect(stripExtension('Photo.JPG')).toBe('Photo');
  });

  it('takes only the LAST extension off a name with several dots', () => {
    expect(stripExtension('archive.tar.gz')).toBe('archive.tar');
    expect(stripExtension('v1.2.3-notes.md')).toBe('v1.2.3-notes');
  });

  it('leaves a dotfile whole: its dot leads the name, it is not an extension', () => {
    expect(stripExtension('.bashrc')).toBe('.bashrc');
    expect(stripExtension('.env')).toBe('.env');
  });

  it('strips the extension of a dotfile that has one', () => {
    expect(stripExtension('.eslintrc.json')).toBe('.eslintrc');
  });

  it('leaves names with no extension, or a trailing dot, whole', () => {
    expect(stripExtension('Makefile')).toBe('Makefile');
    expect(stripExtension('notes.')).toBe('notes.');
    expect(stripExtension('')).toBe('');
  });
});

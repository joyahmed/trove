import { describe, expect, it } from 'vitest';
import { pathCompletion } from './palette-path';

describe('pathCompletion', () => {
  it('splits a Windows path at the last separator, keeping a drive root whole', () => {
    expect(pathCompletion('C:\\Us', null)).toEqual({ parent: 'C:\\', prefix: 'us' });
    expect(pathCompletion('C:\\Users\\', null)).toEqual({ parent: 'C:\\Users', prefix: '' });
    expect(pathCompletion('C:/Users/Jo', null)).toEqual({ parent: 'C:/Users', prefix: 'jo' });
    expect(pathCompletion('\\\\server\\sha', null)).toEqual({
      parent: '\\\\server',
      prefix: 'sha',
    });
  });

  it('resolves ~ against the profile and the WSL form against the share', () => {
    expect(pathCompletion('~\\Doc', 'C:\\Users\\alex')).toEqual({
      parent: 'C:\\Users\\alex',
      prefix: 'doc',
    });
    expect(pathCompletion('~', null)).toBeNull();
    expect(pathCompletion('Ubuntu:/ho', null)).toEqual({
      parent: '\\\\wsl.localhost\\Ubuntu\\',
      prefix: 'ho',
    });
    expect(pathCompletion('Ubuntu:/home/', null)).toEqual({
      parent: '\\\\wsl.localhost\\Ubuntu\\home',
      prefix: '',
    });
  });

  it('is null for plain words', () => {
    expect(pathCompletion('notepad', null)).toBeNull();
    expect(pathCompletion('', 'C:\\Users\\alex')).toBeNull();
    expect(pathCompletion('C:', null)).toBeNull();
  });

  it('on a Mac or Linux host joins ~ with / and lists plain absolute paths', () => {
    // the old code joined `~/Documents/` as `/home/alex\Documents/` and listed nothing
    expect(pathCompletion('~/Documents/', '/home/alex', true)).toEqual({
      parent: '/home/alex/Documents',
      prefix: '',
    });
    expect(pathCompletion('~/Documents/re', '/home/alex/', true)).toEqual({
      parent: '/home/alex/Documents',
      prefix: 're',
    });
    expect(pathCompletion('~/Doc', '/Users/alex', true)).toEqual({
      parent: '/Users/alex',
      prefix: 'doc',
    });
    expect(pathCompletion('/home/', null, true)).toEqual({ parent: '/home', prefix: '' });
    expect(pathCompletion('/ho', null, true)).toEqual({ parent: '/', prefix: 'ho' });
    expect(pathCompletion('/home/alex/My\\Fi', null, true)).toEqual({
      parent: '/home/alex',
      prefix: 'my\\fi',
    });
  });

  it('keeps Windows unchanged: a leading / is not a path there', () => {
    expect(pathCompletion('/home/', null, false)).toBeNull();
    expect(pathCompletion('~/Documents/', 'C:\\Users\\alex', false)).toEqual({
      parent: 'C:\\Users\\alex\\Documents',
      prefix: '',
    });
  });
});

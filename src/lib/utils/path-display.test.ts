import { describe, expect, it } from 'vitest';
import { tildeHome } from './path-display';

const MAC = { os: 'macos', thisPcLabel: 'This Mac' } as const;
const LINUX = { os: 'linux', thisPcLabel: 'This Computer' } as const;
const WIN = { os: 'windows', thisPcLabel: 'This PC' } as const;

describe('tildeHome', () => {
  it('macOS: home and below start at ~', () => {
    expect(tildeHome('/Users/alex', '/Users/alex', MAC)).toBe('~');
    expect(tildeHome('/Users/alex/trove-demo', '/Users/alex', MAC)).toBe('~/trove-demo');
    expect(tildeHome('/Users/alex/a/b', '/Users/alex/', MAC)).toBe('~/a/b');
    expect(tildeHome('/Users/alex/', '/Users/alex', MAC)).toBe('~');
  });

  it('Linux: /home/<name>, case kept (a different case is a different folder)', () => {
    expect(tildeHome('/home/alex/src', '/home/alex', LINUX)).toBe('~/src');
    expect(tildeHome('/home/Alex/src', '/home/alex', LINUX)).toBe('/home/Alex/src');
  });

  it('Windows: case-insensitive, either separator, the path keeps its own separator', () => {
    expect(tildeHome('C:\\Users\\alex', 'C:\\Users\\alex', WIN)).toBe('~');
    expect(tildeHome('C:\\Users\\alex\\Docs\\x', 'C:\\Users\\alex', WIN)).toBe('~\\Docs\\x');
    expect(tildeHome('c:\\users\\ALEX\\Docs', 'C:\\Users\\alex', WIN)).toBe('~\\Docs');
    expect(tildeHome('C:/Users/alex/Docs', 'C:\\Users\\alex', WIN)).toBe('~/Docs');
    expect(tildeHome('C:\\Users\\alex\\Docs', 'c:/users/alex/', WIN)).toBe('~\\Docs');
  });

  it('a look-alike prefix is not home', () => {
    expect(tildeHome('/Users/alexa', '/Users/alex', MAC)).toBe('/Users/alexa');
    expect(tildeHome('/Users/alexa/x', '/Users/alex', MAC)).toBe('/Users/alexa/x');
    expect(tildeHome('C:\\Users\\alexa\\x', 'C:\\Users\\alex', WIN)).toBe('C:\\Users\\alexa\\x');
  });

  it('WSL paths stay as they are', () => {
    const home = 'C:\\Users\\alex';
    for (const p of [
      '\\\\wsl$\\Ubuntu\\home\\alex',
      '\\\\wsl.localhost\\Ubuntu\\home\\alex\\src',
      'Ubuntu:/home/alex',
      '/mnt/c/Users/alex',
    ])
      expect(tildeHome(p, home, WIN)).toBe(p);
    expect(tildeHome('/mnt/c/Users/alex', '/home/alex', LINUX)).toBe('/mnt/c/Users/alex');
  });

  it('a path outside home, no home known, or a root home: unchanged', () => {
    expect(tildeHome('/Applications', '/Users/alex', MAC)).toBe('/Applications');
    expect(tildeHome('D:\\Users\\alex\\x', 'C:\\Users\\alex', WIN)).toBe('D:\\Users\\alex\\x');
    expect(tildeHome('/Users/alex/x', null, MAC)).toBe('/Users/alex/x');
    expect(tildeHome('/etc', '/', LINUX)).toBe('/etc');
    expect(tildeHome('C:\\x', 'C:\\', WIN)).toBe('C:\\x');
    expect(tildeHome('', '/Users/alex', MAC)).toBe('');
  });
});

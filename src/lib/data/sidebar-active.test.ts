import { describe, expect, it } from 'vitest';
import { isActiveLocation } from '$lib/data/sidebar-active';
import { GALLERY, HOME, THIS_PC, pathLocation } from '$lib/utils/location';

const WIN = { os: 'windows', thisPcLabel: 'This PC' };
const MAC = { os: 'macos', thisPcLabel: 'This Mac' };
const LINUX = { os: 'linux', thisPcLabel: 'This Computer' };

describe('isActiveLocation', () => {
  it('lights Home only while on Home, not after typing a folder path', () => {
    expect(isActiveLocation(HOME, HOME)).toBe(true);
    expect(isActiveLocation(pathLocation('/Users/alex/Documents'), HOME, MAC)).toBe(false);
  });
  it('follows the folder: the row whose path equals the current one', () => {
    const docs = pathLocation('/Users/alex/Documents');
    expect(isActiveLocation(docs, pathLocation('/Users/alex/Documents'), MAC)).toBe(true);
    expect(isActiveLocation(docs, pathLocation('/Users/alex/Downloads'), MAC)).toBe(false);
  });
  it('ignores trailing slashes', () => {
    const row = pathLocation('/Users/alex/Documents');
    expect(isActiveLocation(pathLocation('/Users/alex/Documents/'), row, MAC)).toBe(true);
    const alex = pathLocation('C:\\Users\\alex');
    expect(isActiveLocation(pathLocation('C:\\Users\\alex\\'), alex, WIN)).toBe(true);
  });
  it('is case-insensitive on Windows, exact on Mac and Linux', () => {
    const a = pathLocation('C:\\Users\\alex\\Documents');
    const b = pathLocation('c:/users/alex/documents/');
    expect(isActiveLocation(a, b, WIN)).toBe(true);
    expect(isActiveLocation(pathLocation('/Users/alex'), pathLocation('/users/alex'), MAC)).toBe(
      false,
    );
    expect(isActiveLocation(pathLocation('/home/a'), pathLocation('/home/A'), LINUX)).toBe(false);
  });
  it('places match by kind; no row location or an empty path never lights', () => {
    expect(isActiveLocation(THIS_PC, THIS_PC)).toBe(true);
    expect(isActiveLocation(THIS_PC, GALLERY)).toBe(false);
    expect(isActiveLocation(HOME, undefined)).toBe(false);
    expect(isActiveLocation(pathLocation(''), pathLocation(''))).toBe(false);
  });
});

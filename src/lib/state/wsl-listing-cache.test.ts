import { beforeEach, describe, expect, it } from 'vitest';
import { WSL_CACHE_SIZE, sameListing, wslListings } from './wsl-listing-cache';
import type { FileEntry } from '$lib/types/fs';

const HOME = String.raw`\\wsl.localhost\Ubuntu\home`;
const at = (i: number | string) => String.raw`\\wsl.localhost\Ubuntu\d` + i;

const entry = (name: string, size = 1): FileEntry => ({
  name,
  path: `${HOME}\\${name}`,
  isDir: false,
  size,
  modifiedMs: 1,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: 'ext/',
  typeName: 'File',
});

beforeEach(() => wslListings.clear());

describe('wslListings', () => {
  it('gives back what it was told, with or without a trailing separator', () => {
    const rows = [entry('a')];
    wslListings.remember(`${HOME}\\`, rows);
    expect(wslListings.get(HOME)).toBe(rows);
    wslListings.remember('//wsl.localhost/Ubuntu/tmp/', rows);
    expect(wslListings.get('//wsl.localhost/Ubuntu/tmp')).toBe(rows);
  });

  it('keeps case apart: WSL paths are case-sensitive', () => {
    wslListings.remember(String.raw`\\wsl.localhost\Ubuntu\Home`, [entry('a')]);
    expect(wslListings.get(HOME)).toBeUndefined();
  });

  it(`drops the folder visited longest ago past ${WSL_CACHE_SIZE}`, () => {
    for (let i = 0; i <= WSL_CACHE_SIZE; i++) wslListings.remember(at(i), []);
    expect(wslListings.get(at(0))).toBeUndefined();
    expect(wslListings.get(at(WSL_CACHE_SIZE))).toEqual([]);
  });

  it('a read keeps a folder young', () => {
    for (let i = 0; i < WSL_CACHE_SIZE; i++) wslListings.remember(at(i), []);
    wslListings.get(at(0));
    wslListings.remember(at('new'), []);
    expect(wslListings.get(at(0))).toEqual([]);
    expect(wslListings.get(at(1))).toBeUndefined();
  });

  it('forget drops one folder', () => {
    wslListings.remember(HOME, []);
    wslListings.forget(`${HOME}\\`);
    expect(wslListings.get(HOME)).toBeUndefined();
  });
});

describe('sameListing', () => {
  it('equal rows are the same listing', () => {
    expect(sameListing([entry('a'), entry('b')], [entry('a'), entry('b')])).toBe(true);
  });

  it('a size change, a new row or a new order is a change', () => {
    expect(sameListing([entry('a')], [entry('a', 2)])).toBe(false);
    expect(sameListing([entry('a')], [entry('a'), entry('b')])).toBe(false);
    expect(sameListing([entry('a'), entry('b')], [entry('b'), entry('a')])).toBe(false);
  });
});

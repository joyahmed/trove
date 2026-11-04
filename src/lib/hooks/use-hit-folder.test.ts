import { beforeEach, describe, expect, it, vi } from 'vitest';
import { search } from '$lib/state/search.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { useHitFolder } from './use-hit-folder.svelte';
import type { FileEntry } from '$lib/types/fs';
import { pathLocation } from '$lib/utils/location';

vi.mock('$lib/api/search', () => ({
  startSearch: vi.fn(async () => 1),
  cancelSearch: vi.fn(async () => {}),
  onSearchResults: vi.fn(async () => () => {}),
}));
vi.mock('$lib/api/fs', () => ({ readDir: vi.fn(async (path: string) => ({ path, entries: [] })) }));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
}));
vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => null),
  writeSettings: vi.fn(async () => {}),
}));

const entry = (path: string): FileEntry => ({
  name: path.slice(path.lastIndexOf('\\') + 1),
  path,
  isDir: false,
  size: 1,
  modifiedMs: null,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: 'ext/',
  typeName: 'File',
});

const hit = (): string | undefined =>
  useHitFolder(() => entry('C:\\scratch\\a\\b\\x.txt')).hit?.text;

describe('useHitFolder', () => {
  beforeEach(() => {
    search.clear();
    tabs.active.location = pathLocation('C:\\scratch');
  });

  it('gives no second line for a plain folder listing', () => {
    expect(hit()).toBeUndefined();
  });

  it('gives the folder, relative to the search root, while a search shows results', async () => {
    await search.start('x');
    search.apply({
      searchId: 1,
      entries: [entry('C:\\scratch\\a\\b\\x.txt')],
      done: true,
      cancelled: false,
      error: null,
      scanned: 1,
    });
    expect(hit()).toBe('a/b');
    search.clear();
    expect(hit()).toBeUndefined();
  });
});

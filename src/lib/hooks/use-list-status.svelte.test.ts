import { beforeEach, describe, expect, it, vi } from 'vitest';

// State is read straight off the singletons; no network or OS call is made by what these tests touch.
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  oneDriveRoot: vi.fn(async () => null),
}));
vi.mock('$lib/api/fs', () => ({ readDir: vi.fn(), pathKind: vi.fn(async () => 'dir') }));
vi.mock('$lib/api/archive', () => ({ readArchiveDir: vi.fn() }));

import { search } from '$lib/state/search.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { wsl } from '$lib/state/wsl.svelte';
import { pathLocation } from '$lib/utils/location';
import type { FileEntry } from '$lib/types/fs';
import { useListStatus } from './use-list-status.svelte';

const file = (name: string): FileEntry => ({
  name,
  path: `C:\\scratch\\${name}`,
  isDir: false,
  size: 1,
  modifiedMs: null,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: 'ext/',
  typeName: 'File',
});

beforeEach(() => {
  const tab = tabs.active;
  tab.location = pathLocation('C:\\scratch');
  tab.entries = [];
  tab.filter = '';
  tab.loading = false;
  tab.error = null;
  search.active = false;
  search.running = false;
  search.scanned = 0;
  wsl.starting = null;
  settings.showHidden = false;
});

describe('list status: empty', () => {
  it('is empty for a folder with no rows, with the folder wording', () => {
    const s = useListStatus();
    expect(s.empty).toBe(true);
    expect(s.emptyText).toBe('This folder is empty.');
  });

  it('is not empty when there are rows', () => {
    tabs.active.entries = [file('a')];
    expect(useListStatus().empty).toBe(false);
  });

  it('is not "empty" while the folder is still loading', () => {
    tabs.active.loading = true;
    expect(useListStatus().empty).toBe(false);
  });

  it('is not "empty" while a search is running', () => {
    search.running = true;
    expect(useListStatus().empty).toBe(false);
  });

  it('says the filter matched nothing when a filter hides every row', () => {
    tabs.active.entries = [file('a')];
    tabs.active.filter = 'zzz';
    const s = useListStatus();
    expect(s.empty).toBe(true);
    expect(s.emptyText).toBe('No items match the filter.');
  });

  it('says the search matched nothing when a search is on (search wins over filter)', () => {
    tabs.active.filter = 'zzz';
    search.active = true;
    expect(useListStatus().emptyText).toBe('No items match your search.');
  });
});

describe('list status: error', () => {
  it('is null with no error and passes the tab error through', () => {
    const s = useListStatus();
    expect(s.error).toBeNull();
    tabs.active.error = 'Access is denied';
    expect(s.error).toBe('Access is denied');
  });
});

describe('list status: starting a WSL distro', () => {
  it('is null for a normal folder, loaded or loading', () => {
    const s = useListStatus();
    expect(s.starting).toBeNull();
    tabs.active.loading = true;
    expect(s.starting).toBeNull();
  });

  it('names the distro while its folder loads', () => {
    tabs.active.location = pathLocation('\\\\wsl.localhost\\Ubuntu\\home\\alex');
    const s = useListStatus();
    expect(s.starting).toBeNull();
    tabs.active.loading = true;
    expect(s.starting).toBe('Ubuntu');
  });

  it('prefers the distro the WSL state is starting', () => {
    wsl.starting = 'Debian';
    expect(useListStatus().starting).toBe('Debian');
  });
});

describe('list status: searching', () => {
  it('is null when no search runs', () => {
    expect(useListStatus().searching).toBeNull();
  });

  it('shows the scanned count with thousands separators while a search runs', () => {
    search.active = true;
    search.running = true;
    search.scanned = 12340;
    expect(useListStatus().searching).toBe(`Searching… ${(12340).toLocaleString()} items`);
  });

  it('is null once the search has finished', () => {
    search.active = true;
    search.running = false;
    search.scanned = 5;
    expect(useListStatus().searching).toBeNull();
  });
});

describe('list status: a slow or silent network share', () => {
  it('reports the server being reached and no error', () => {
    tabs.active.slowServer = 'nas';
    const s = useListStatus();
    expect(s.reaching).toBe('nas');
    expect(s.error).toBeNull();
    tabs.active.slowServer = null;
    expect(s.reaching).toBeNull();
  });

  it('offers Try again only for the did-not-answer error', () => {
    const s = useListStatus();
    tabs.active.error = 'Access is denied.';
    expect(s.unreachable).toBe(false);
    tabs.active.error = 'Z:' + String.fromCharCode(92) + ' did not answer in 10 s';
    expect(s.unreachable).toBe(true);
  });
});

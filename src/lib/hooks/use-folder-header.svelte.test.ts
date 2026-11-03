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

import type { FileEntry } from '$lib/types/fs';
import { pathLocation, HOME } from '$lib/utils/location';
import { search } from '$lib/state/search.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { useFolderHeader } from './use-folder-header.svelte';

const file = (name: string, size: number, over: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `C:\\scratch\\${name}`,
  isDir: false,
  size,
  modifiedMs: null,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: 'ext/',
  typeName: 'File',
  ...over,
});
const dir = (name: string) => file(name, 0, { isDir: true });

beforeEach(() => {
  const tab = tabs.active;
  tab.location = pathLocation('C:\\scratch');
  tab.entries = [];
  tab.filter = '';
  search.active = false;
  settings.showHidden = false;
});

describe('folder header texts', () => {
  it('names the folder by its last segment and shows its path', () => {
    const h = useFolderHeader();
    expect(h.title).toBe('scratch');
    expect(h.path).toBe('C:\\scratch');
  });

  it('counts an empty folder as 0 items with no size', () => {
    const h = useFolderHeader();
    expect(h.counts).toBe('0 items');
    expect(h.meta).toBe('C:\\scratch · 0 items');
  });

  it('says "1 item" for one file, with its size', () => {
    tabs.active.entries = [file('a', 10)];
    const h = useFolderHeader();
    expect(h.counts).toBe('1 item · 10 B');
  });

  it('sums the sizes of a files-only folder', () => {
    tabs.active.entries = [file('a', 1024 * 1024), file('b', 1024 * 1024)];
    const h = useFolderHeader();
    expect(h.counts).toBe('2 items · 2.0 MB');
    expect(h.meta).toBe('C:\\scratch · 2 items · 2.0 MB');
  });

  it('drops the size once a subfolder is among the rows (folders carry 0 bytes)', () => {
    tabs.active.entries = [dir('sub'), file('a', 500)];
    expect(useFolderHeader().counts).toBe('2 items');
  });

  it('G.42, TODAY: counts only the rows that survive the filter and hidden-files setting, not the whole folder', () => {
    // Joy's open decision (G.42): the header and status count the filtered rows. This pins that.
    tabs.active.entries = [file('apple', 100), file('banana', 200), file('avocado', 300)];
    const h = useFolderHeader();
    expect(h.counts).toBe('3 items · 600 B');
    tabs.active.filter = 'a';
    expect(h.counts).toBe('3 items · 600 B'); // all three contain "a"
    tabs.active.filter = 'av';
    expect(h.counts).toBe('1 item · 300 B');
    tabs.active.filter = 'zzz';
    expect(h.counts).toBe('0 items');
  });

  it('G.42, TODAY: hidden files are not counted while showHidden is off', () => {
    tabs.active.entries = [file('a', 100), file('.h', 50, { isHidden: true })];
    const h = useFolderHeader();
    expect(h.counts).toBe('1 item · 100 B');
    settings.showHidden = true;
    expect(h.counts).toBe('2 items · 150 B');
  });
});

describe('folder header visibility', () => {
  it('is visible on a real folder', () => {
    expect(useFolderHeader().visible).toBe(true);
  });

  it('is hidden on a place such as Home', () => {
    tabs.active.location = HOME;
    expect(useFolderHeader().visible).toBe(false);
  });

  it('is hidden while a search has taken over the list', () => {
    search.active = true;
    expect(useFolderHeader().visible).toBe(false);
  });
});

describe('folder header Group / Sort pills', () => {
  const click = () =>
    ({
      currentTarget: { getBoundingClientRect: () => ({ left: 1, bottom: 2 }), focus: vi.fn() },
    }) as unknown as MouseEvent;

  it('starts with no menu showing', () => {
    const h = useFolderHeader();
    expect(h.menu.open).toBe(false);
    expect(h.groupExpanded).toBe(false);
    expect(h.sortExpanded).toBe(false);
    expect(h.items).toEqual([]);
  });

  it('openGroup expands only the Group pill, openSort only the Sort pill', () => {
    const h = useFolderHeader();
    h.openGroup(click());
    expect(h.groupExpanded).toBe(true);
    expect(h.sortExpanded).toBe(false);
    expect(h.items.length).toBeGreaterThan(0);
    h.menu.close();
    h.openSort(click());
    expect(h.sortExpanded).toBe(true);
    expect(h.groupExpanded).toBe(false);
  });

  it('collapses both pills when the menu closes', () => {
    const h = useFolderHeader();
    h.openSort(click());
    h.menu.close();
    expect(h.sortExpanded).toBe(false);
    expect(h.groupExpanded).toBe(false);
  });
});

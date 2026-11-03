// useDetailsPane on Svelte's CLIENT runtime: the effects that attach, re-sync and tear down, and
// the getters the markup reads (rows, summary, toggles, the place shown for a non-path location).
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileProps, onFolderTotals } from '$lib/api/props';
import { attributeToggles } from '$lib/data/details-rows';
import { details } from '$lib/state/details.svelte';
import { listing } from '$lib/state/listing.svelte';
import { recycle } from '$lib/state/recycle.svelte';
import { selection } from '$lib/state/selection.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { FileEntry } from '$lib/types/fs';
import type { Props } from '$lib/types/props';
import { useDetailsPane } from './use-details-pane.svelte';

const unlisten = vi.fn();
vi.mock('$lib/api/props', () => ({
  fileProps: vi.fn(),
  startFolderTotals: vi.fn(async () => 1),
  cancelFolderTotals: vi.fn(async () => {}),
  setFileAttributes: vi.fn(async () => {}),
  onFolderTotals: vi.fn(() => Promise.resolve(unlisten)),
}));
// the listing is derived from the tab's directory read; the pane only reads `rows`
vi.mock('$lib/state/listing.svelte', () => ({ listing: { rows: [] as unknown[] } }));

const entry = (path: string): FileEntry =>
  ({
    name: path.split('/').pop()!,
    path,
    isDir: false,
    size: 10,
    iconKey: 'file',
    typeName: 'File',
  }) as FileEntry;

const props = (over: Partial<Props> = {}): Props => ({
  path: '/a/f.txt',
  name: 'f.txt',
  isDir: false,
  typeName: 'Text Document',
  size: 2048,
  sizeOnDisk: 4096,
  createdMs: null,
  modifiedMs: null,
  accessedMs: null,
  readOnly: true,
  hidden: false,
  system: false,
  archive: false,
  ...over,
});

const mount = () => {
  let pane!: ReturnType<typeof useDetailsPane>;
  const stop = $effect.root(() => {
    pane = useDetailsPane();
  });
  flushSync();
  return { pane, stop };
};

beforeEach(() => {
  vi.mocked(fileProps).mockReturnValue(new Promise(() => {})); // never lands: the tests set props by hand
  tabs.active.location = { kind: 'path', path: '/a' };
  selection.clear();
  (listing as { rows: unknown[] }).rows = [];
});

afterEach(() => {
  selection.clear();
  details.reset();
  recycle.items = [];
  recycle.loaded = false;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('useDetailsPane lifecycle', () => {
  it('listens for folder totals while mounted and drops everything on unmount', async () => {
    const { stop } = mount();
    expect(onFolderTotals).toHaveBeenCalledTimes(1);
    details.count = 3;
    stop();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(details.count).toBe(0);
    expect(details.target).toBe('none');
  });

  it('syncs once on mount, then again for a new selection or a new folder', () => {
    const sync = vi.spyOn(details, 'sync');
    const { stop } = mount();
    expect(sync).toHaveBeenCalledTimes(1);

    selection.replaceAll(['/a/f.txt']);
    flushSync();
    expect(sync).toHaveBeenCalledTimes(2);

    tabs.active.location = { kind: 'path', path: '/b' };
    flushSync();
    expect(sync).toHaveBeenCalledTimes(3);
    stop();
  });

  it('does not sync again when only the shown props change', () => {
    const sync = vi.spyOn(details, 'sync');
    const { stop } = mount();
    details.props = props({ name: 'g.txt' });
    flushSync();
    expect(sync).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('useDetailsPane getters', () => {
  it('has no rows and no icon until props arrive', () => {
    const { pane, stop } = mount();
    expect(pane.rows).toEqual([]);
    expect(pane.icon).toBeNull();
    expect(pane.iconEntry).toBeNull();
    stop();
  });

  it('lists a file as rows, dropping the ones with no value', () => {
    const { pane, stop } = mount();
    details.props = props();
    flushSync();
    // Location is left out of the keys: its value needs a platform path
    expect(pane.rows.map((r) => r.key)).toEqual(['type', 'size', 'sizeOnDisk']);
    expect(pane.rows.find((r) => r.key === 'type')?.value).toBe('Text Document');
    stop();
  });

  it('adds Contains for a folder once its totals are known', () => {
    const { pane, stop } = mount();
    details.props = props({ path: '/a/d', name: 'd', isDir: true, typeName: 'File folder' });
    details.totals = { files: 3, folders: 1, bytes: 10, sizeOnDisk: 0, notCounted: 0, done: false };
    flushSync();
    expect(pane.rows.find((r) => r.key === 'contains')?.value).toBe('3 files, 1 folder…');
    expect(pane.rows.some((r) => r.key === 'sizeOnDisk')).toBe(false); // only once done
    stop();
  });

  it('summarises a many-item selection, with an ellipsis while counting', () => {
    const { pane, stop } = mount();
    expect(pane.manySummary).toBe('');
    details.totals = { files: 2, folders: 1, bytes: 0, sizeOnDisk: 0, notCounted: 0, done: false };
    flushSync();
    expect(pane.manySummary).toMatch(/^2 files, 1 folder… · .+…$/);
    details.totals = { files: 2, folders: 1, bytes: 0, sizeOnDisk: 0, notCounted: 2, done: true };
    flushSync();
    expect(pane.manySummary).toMatch(/^2 files, 1 folder · .+ · size not counted for 2 folders$/);
    stop();
  });

  it('ticks the attribute boxes from the props', () => {
    const { pane, stop } = mount();
    expect(pane.toggles.every((t) => t.checked === false)).toBe(true);
    details.props = props({ readOnly: true, hidden: false });
    flushSync();
    expect(pane.toggles.map((t) => t.key)).toEqual(attributeToggles().map((t) => t.key));
    expect(pane.toggles.find((t) => t.key === 'readOnly')?.checked).toBe(true);
    stop();
  });

  it('builds an icon entry from props, and uses the listing row when it is the shown item', () => {
    const { pane, stop } = mount();
    details.props = props({ path: '/a', name: 'a', isDir: true });
    flushSync();
    expect(pane.iconEntry).toMatchObject({ path: '/a', iconKey: 'folder', isDir: true });

    details.props = props({ path: '/a/Pic.JPG', name: 'Pic.JPG' });
    flushSync();
    expect(pane.iconEntry?.iconKey).toBe('ext/jpg');

    details.props = props({ path: '/a/Makefile', name: 'Makefile' });
    flushSync();
    expect(pane.iconEntry?.iconKey).toBe('file//a/Makefile'); // no extension

    const row = entry('/a/f.txt');
    details.entry = row;
    details.props = props();
    flushSync();
    expect(pane.iconEntry).toEqual(row);
    stop();
  });

  it('routes setAttribute to the matching writer', () => {
    const ro = vi.spyOn(details, 'setReadOnly').mockResolvedValue();
    const hid = vi.spyOn(details, 'setHidden').mockResolvedValue();
    const { pane, stop } = mount();
    pane.setAttribute('readOnly', true);
    pane.setAttribute('hidden', false);
    expect(ro).toHaveBeenCalledWith(true);
    expect(hid).toHaveBeenCalledWith(false);
    stop();
  });
});

describe('useDetailsPane place', () => {
  it('is null for a folder path', () => {
    const { pane, stop } = mount();
    expect(pane.place).toBeNull();
    stop();
  });

  it('names a place that has no path, with no summary outside the bin', () => {
    tabs.active.location = { kind: 'home' };
    const { pane, stop } = mount();
    expect(pane.place?.label).toBeTruthy();
    expect(pane.place?.summary).toBeNull();
    expect(pane.place?.item).toBeNull();
    stop();
  });

  it('summarises the bin once it is loaded, and shows the one item picked', () => {
    tabs.active.location = { kind: 'recycle-bin' };
    recycle.items = [
      { id: 'bin1', name: 'old.txt', isDir: false, size: 5, deletedMs: 0, originalParent: '/x' },
    ] as never;
    const { pane, stop } = mount();
    expect(pane.place?.summary).toBeNull(); // not loaded yet

    recycle.loaded = true;
    flushSync();
    expect(pane.place?.summary).toMatch(/^1 item · /);
    expect(pane.place?.item).toBeNull(); // nothing selected

    recycle.selected.add('bin1');
    flushSync();
    expect(pane.place?.item?.name).toBe('old.txt');
    expect(pane.place?.item?.entry).toMatchObject({ path: 'bin1', iconKey: 'ext/txt' });
    recycle.selected.clear();
    stop();
  });
});

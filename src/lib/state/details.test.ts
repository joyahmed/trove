import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelFolderTotals,
  fileProps,
  setFileAttributes,
  startFolderTotals,
} from '$lib/api/props';
import { details } from './details.svelte';
import { selection } from './selection.svelte';
import { tabs } from './tabs.svelte';
import type { FileEntry } from '$lib/types/fs';
import type { Props } from '$lib/types/props';
import { pathLocation } from '$lib/utils/location';
import { archiveLocation } from '$lib/utils/archive-location';
import { detailsRows } from '$lib/data/details-rows';

vi.mock('$lib/api/props', () => ({
  fileProps: vi.fn(),
  setFileAttributes: vi.fn(async () => {}),
  startFolderTotals: vi.fn(),
  cancelFolderTotals: vi.fn(async () => {}),
  onFolderTotals: vi.fn(async () => () => {}),
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

const entry = (name: string, isDir = false): FileEntry => ({
  name,
  path: `C:\\scratch\\${name}`,
  isDir,
  size: isDir ? 0 : 10,
  modifiedMs: null,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: isDir ? 'folder' : 'ext/',
  typeName: isDir ? 'File folder' : 'File',
});

const propsOf = (path: string, isDir = false): Props => ({
  path,
  name: path.slice(path.lastIndexOf('\\') + 1),
  isDir,
  typeName: isDir ? 'File folder' : 'File',
  size: isDir ? 0 : 10,
  sizeOnDisk: isDir ? 0 : 4096,
  createdMs: 1,
  modifiedMs: 2,
  accessedMs: 3,
  readOnly: false,
  hidden: false,
  system: false,
  archive: true,
});

describe('details', () => {
  let nextJob = 1;
  beforeEach(() => {
    details.reset();
    selection.clear();
    nextJob = 1;
    vi.mocked(fileProps).mockImplementation(async (path) => propsOf(path, path.endsWith('dir')));
    vi.mocked(startFolderTotals).mockImplementation(async () => nextJob++);
    vi.mocked(cancelFolderTotals).mockClear();
    vi.mocked(setFileAttributes).mockClear();
    tabs.active.location = pathLocation('C:\\scratch');
    tabs.active.entries = [entry('a.txt'), entry('b.txt'), entry('dir', true)];
  });

  it('one selected file fetches its props', async () => {
    selection.click('C:\\scratch\\a.txt', { ctrl: false, shift: false }, []);
    await details.sync();
    expect(details.target).toBe('one');
    expect(fileProps).toHaveBeenCalledWith('C:\\scratch\\a.txt');
    expect(details.props?.name).toBe('a.txt');
    expect(details.totals).toBeNull();
  });

  it('a small folder counted before its job id is known still fills the totals', async () => {
    // the count finishes and emits `done` before startFolderTotals has resolved its id
    vi.mocked(startFolderTotals).mockImplementationOnce(async () => {
      details.applyTotals({
        jobId: 1,
        files: 3,
        folders: 1,
        bytes: 9,
        sizeOnDisk: 12,
        notCounted: 0,
        done: true,
      });
      return nextJob++;
    });
    selection.click('C:\\scratch\\dir', { ctrl: false, shift: false }, []);
    await details.sync();
    expect(details.totals).toEqual({
      files: 3,
      folders: 1,
      bytes: 9,
      sizeOnDisk: 12,
      notCounted: 0,
      done: true,
    });
  });

  it('a selected folder starts a count and a done event fills the totals', async () => {
    selection.click('C:\\scratch\\dir', { ctrl: false, shift: false }, []);
    await details.sync();
    expect(startFolderTotals).toHaveBeenCalledWith('C:\\scratch\\dir');
    expect(details.totals?.done).toBe(false);
    details.applyTotals({
      jobId: 1,
      files: 3,
      folders: 2,
      bytes: 99,
      sizeOnDisk: 120,
      notCounted: 0,
      done: true,
    });
    expect(details.totals).toEqual({
      files: 3,
      folders: 2,
      bytes: 99,
      sizeOnDisk: 120,
      notCounted: 0,
      done: true,
    });
    // a stale job's batch is ignored
    details.applyTotals({
      jobId: 7,
      files: 1,
      folders: 1,
      bytes: 1,
      sizeOnDisk: 1,
      notCounted: 0,
      done: true,
    });
    expect(details.totals?.files).toBe(3);
  });

  it('a new selection cancels the running count', async () => {
    selection.click('C:\\scratch\\dir', { ctrl: false, shift: false }, []);
    await details.sync();
    selection.click('C:\\scratch\\a.txt', { ctrl: false, shift: false }, []);
    await details.sync();
    expect(cancelFolderTotals).toHaveBeenCalledWith(1);
    expect(details.props?.name).toBe('a.txt');
  });

  it('nothing selected shows the current folder', async () => {
    await details.sync();
    expect(details.target).toBe('none');
    expect(fileProps).toHaveBeenCalledWith('C:\\scratch');
  });

  it('several selected sums the files and counts the folders', async () => {
    const order = ['C:\\scratch\\a.txt', 'C:\\scratch\\b.txt', 'C:\\scratch\\dir'];
    selection.click(order[0], { ctrl: false, shift: false }, order);
    selection.click(order[2], { ctrl: false, shift: true }, order);
    await details.sync();
    expect(details.target).toBe('many');
    expect(details.count).toBe(3);
    expect(details.totals).toMatchObject({ files: 2, folders: 1, bytes: 20, done: false });
    expect(fileProps).not.toHaveBeenCalled();
  });

  it('a folder in a multi-selection adds its contents to the selected files and itself', async () => {
    const order = ['C:\\scratch\\a.txt', 'C:\\scratch\\b.txt', 'C:\\scratch\\dir'];
    selection.click(order[0], { ctrl: false, shift: false }, order);
    selection.click(order[2], { ctrl: false, shift: true }, order);
    await details.sync();
    const batch = (files: number, done: boolean) => ({
      jobId: 1,
      files,
      folders: 2,
      bytes: files * 10,
      sizeOnDisk: 0,
      notCounted: 0,
      done,
    });
    details.applyTotals(batch(1, false));
    details.applyTotals(batch(4, true));
    // 2 selected files + the folder's 4, the folder itself + its 2 inside
    expect(details.totals).toMatchObject({ files: 6, folders: 3, bytes: 60, done: true });
  });

  it('setReadOnly writes the bit then re-reads', async () => {
    selection.click('C:\\scratch\\a.txt', { ctrl: false, shift: false }, []);
    await details.sync();
    vi.mocked(fileProps).mockClear();
    await details.setReadOnly(true);
    expect(setFileAttributes).toHaveBeenCalledWith('C:\\scratch\\a.txt', { readOnly: true });
    expect(fileProps).toHaveBeenCalledTimes(1);
  });

  describe('inside an archive', () => {
    const zip = 'C:\\scratch\\a.zip';
    const row = (inner: string, isDir = false): FileEntry => ({
      ...entry(inner.split('/').at(-1) ?? inner, isDir),
      path: `${zip}\u0000${inner}`,
      size: isDir ? 0 : 42,
      modifiedMs: 5,
      typeName: isDir ? 'File folder' : 'Text Document',
    });

    beforeEach(() => {
      tabs.active.location = archiveLocation(zip, 'docs');
      tabs.active.entries = [row('docs/notes.txt'), row('docs/sub', true), row('docs/b.txt')];
    });

    it('a selected file shows what the listing read, never asks Rust with the NUL path', async () => {
      selection.click(`${zip}\u0000docs/notes.txt`, { ctrl: false, shift: false }, []);
      await details.sync();
      expect(fileProps).not.toHaveBeenCalled();
      expect(details.error).toBeNull();
      expect(details.inArchive).toBe(true);
      expect(details.props).toMatchObject({ name: 'notes.txt', size: 42, readOnly: true });
      const rows = Object.fromEntries(
        detailsRows.map((r) => [r.key, r.value(details.props!, details.totals)]),
      );
      // the address bar's form, not the folder holding the zip
      expect(rows.location).toBe('a.zip › docs');
      expect(rows.sizeOnDisk).toBeNull();
    });

    it('a selected folder starts no count and its attributes cannot be written', async () => {
      selection.click(`${zip}\u0000docs/sub`, { ctrl: false, shift: false }, []);
      await details.sync();
      expect(startFolderTotals).not.toHaveBeenCalled();
      expect(details.props?.isDir).toBe(true);
      await details.setReadOnly(false);
      expect(setFileAttributes).not.toHaveBeenCalled();
    });

    it('several selected: folders inside the archive are not walked', async () => {
      const order = [`${zip}\u0000docs/notes.txt`, `${zip}\u0000docs/sub`];
      selection.click(order[0], { ctrl: false, shift: false }, order);
      selection.click(order[1], { ctrl: false, shift: true }, order);
      await details.sync();
      expect(startFolderTotals).not.toHaveBeenCalled();
      expect(details.totals).toMatchObject({ files: 1, folders: 1, bytes: 42, done: true });
    });
  });
});

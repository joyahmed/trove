import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkWorld, entryFor } from './undo-executor';
import { UndoBarrier, UndoRefused } from './undo.svelte';
import type { UndoRecord } from '$lib/types/undo';
import { readRecord } from '$lib/utils/undo-records';

/** What is on the fake disk: a path, and what it is. Anything else is missing. */
const disk = new Map<string, 'file' | 'dir'>();
const renameEntry = vi.fn(async (path: string, name: string) => {
  const kind = disk.get(path);
  disk.delete(path);
  const to = `${path.slice(0, path.lastIndexOf('/') + 1)}${name}`;
  if (kind) disk.set(to, kind);
  return to;
});
const trashEntries = vi.fn(async (paths: string[]) => {
  for (const p of paths) disk.delete(p);
});
const restoreFromTrash = vi.fn(async (paths: string[]) => {
  for (const p of paths) disk.set(p, 'file');
});
const start = vi.fn(async () => 1);

vi.mock('$lib/api/fs', () => ({
  pathKind: vi.fn(async (p: string) => disk.get(p) ?? 'missing'),
  renameEntry: (p: string, n: string) => renameEntry(p, n),
  trashEntries: (p: string[]) => trashEntries(p),
  deleteEntries: vi.fn(async () => {}),
  createFolder: vi.fn(async (dir: string) => `${dir}\\New folder (2)`),
  createFile: vi.fn(async () => ''),
}));
vi.mock('$lib/api/transfer', () => ({
  restoreFromTrash: (p: string[]) => restoreFromTrash(p),
}));
vi.mock('$lib/state/transfers.svelte', () => ({
  transfers: { start: (...a: unknown[]) => start(...(a as [])) },
}));
vi.mock('$lib/state/confirm.svelte', () => ({ confirm: { ask: vi.fn(async () => true) } }));

const refusal = async (record: UndoRecord, step: 'undo' | 'redo') => {
  try {
    await checkWorld(record, step);
  } catch (e) {
    return e;
  }
  return null;
};

beforeEach(() => {
  disk.clear();
  for (const m of [renameEntry, trashEntries, restoreFromTrash, start]) m.mockClear();
});

describe('checkWorld refuses when the disk no longer matches', () => {
  it('rename: the renamed file is gone', async () => {
    const e = await refusal({ kind: 'rename', from: '/d/a.txt', to: '/d/b.txt' }, 'undo');
    expect(e).toBeInstanceOf(UndoRefused);
    expect((e as Error).message).toBe('Can\'t undo the rename — "b.txt" is no longer there');
  });

  it('rename: something new took the old name', async () => {
    disk.set('/d/b.txt', 'file');
    disk.set('/d/a.txt', 'file');
    const e = await refusal({ kind: 'rename', from: '/d/a.txt', to: '/d/b.txt' }, 'undo');
    expect((e as Error).message).toBe(
      'Can\'t undo the rename — something named "a.txt" is already there',
    );
  });

  it('rename: passes when the file is there and its old name is free', async () => {
    disk.set('/d/b.txt', 'file');
    expect(await refusal({ kind: 'rename', from: '/d/a.txt', to: '/d/b.txt' }, 'undo')).toBeNull();
  });

  it('new folder: the folder is gone', async () => {
    const e = await refusal({ kind: 'newFolder', path: '/d/New folder' }, 'undo');
    expect((e as Error).message).toBe('Can\'t undo the new item — "New folder" is no longer there');
  });

  it('new file: a redo has nothing to find', async () => {
    const record: UndoRecord = { kind: 'newFile', path: '/d/x.txt', baseName: 'x', ext: 'txt' };
    expect(await refusal(record, 'redo')).toBeNull();
  });

  it('trash: an item is back at its path, so a restore would clobber it', async () => {
    disk.set('/d/a.txt', 'file');
    const e = await refusal({ kind: 'trash', paths: ['/d/a.txt', '/d/b.txt'] }, 'undo');
    expect((e as Error).message).toBe(
      'Can\'t undo the trash — something named "a.txt" is already there',
    );
  });

  it('move: two of the moved items are gone', async () => {
    const record: UndoRecord = {
      kind: 'move',
      pairs: [
        { from: '/a/1', to: '/b/1' },
        { from: '/a/2', to: '/b/2' },
      ],
    };
    const e = await refusal(record, 'undo');
    expect((e as Error).message).toBe("Can't undo the move — 2 items are no longer there");
  });

  it('move: several names at home are taken', async () => {
    for (const p of ['/b/1', '/b/2', '/a/1', '/a/2']) disk.set(p, 'file');
    const record: UndoRecord = {
      kind: 'move',
      pairs: [
        { from: '/a/1', to: '/b/1' },
        { from: '/a/2', to: '/b/2' },
      ],
    };
    const e = await refusal(record, 'undo');
    expect((e as Error).message).toBe(
      "Can't undo the move — 2 of the names are taken by something new",
    );
  });

  it('copy: the copy was already removed', async () => {
    const e = await refusal({ kind: 'copy', created: ['/b/a.txt'] }, 'undo');
    expect((e as Error).message).toBe('Can\'t undo the copy — "a.txt" is no longer there');
  });

  it('copy: a redo needs its sources', async () => {
    const record: UndoRecord = {
      kind: 'copy',
      created: ['/b/a.txt'],
      sources: ['/a/a.txt'],
      destination: '/b',
    };
    expect(await refusal(record, 'redo')).toBeInstanceOf(UndoRefused);
  });

  it('a permanent delete is a barrier, never a refusal', async () => {
    const e = await refusal({ kind: 'deleteForever', paths: ['/d/a'] }, 'undo');
    expect(e).toBeInstanceOf(UndoBarrier);
  });

  it('other: refuses with its reason', async () => {
    const e = await refusal({ kind: 'other', reason: 'the copy was cancelled' }, 'undo');
    expect((e as Error).message).toBe("Can't undo this — the copy was cancelled");
  });
});

describe('entryFor', () => {
  it('a record survives the file form and back unchanged', () => {
    const records: UndoRecord[] = [
      { kind: 'rename', from: '/d/a', to: '/d/b' },
      { kind: 'newFolder', path: '/d/New folder' },
      { kind: 'newFile', path: '/d/x.txt', baseName: 'x', ext: 'txt' },
      { kind: 'trash', paths: ['/d/a'] },
      { kind: 'move', pairs: [{ from: '/a/1', to: '/b/1' }] },
      { kind: 'copy', created: ['/b/1'], sources: ['/a/1'], destination: '/b' },
      { kind: 'deleteForever', paths: ['/d/a'] },
      { kind: 'other', reason: 'why' },
    ];
    for (const record of records) {
      const entry = entryFor({ label: 'X' }, record);
      const back = readRecord(JSON.parse(JSON.stringify(entry.toRecord?.())));
      expect(back).toEqual(record);
    }
  });

  it('a permanent delete becomes a barrier entry', () => {
    expect(
      entryFor({ label: 'Permanent delete' }, { kind: 'deleteForever', paths: ['/a'] }),
    ).toMatchObject({ barrier: true });
  });

  it('rename: check, undo, redo run against the disk', async () => {
    disk.set('/d/b.txt', 'file');
    const entry = entryFor(
      { label: 'Rename', at: 5 },
      {
        kind: 'rename',
        from: '/d/a.txt',
        to: '/d/b.txt',
      },
    );
    expect(entry.at).toBe(5);
    await entry.check?.('undo');
    await entry.undo();
    expect(disk.has('/d/a.txt')).toBe(true);
    await entry.check?.('redo');
    await entry.redo();
    expect(disk.has('/d/b.txt')).toBe(true);
  });

  it('a redone new folder records the name it got this time', async () => {
    const entry = entryFor(
      { label: 'New folder' },
      { kind: 'newFolder', path: 'C:\\d\\New folder' },
    );
    await entry.redo();
    expect(entry.toRecord?.()).toEqual({ kind: 'newFolder', path: 'C:\\d\\New folder (2)' });
  });

  it('a move undo is sent as a Skip job per folder, never recorded', async () => {
    const entry = entryFor(
      { label: 'Move' },
      {
        kind: 'move',
        pairs: [
          { from: 'C:\\a\\1', to: 'C:\\b\\1' },
          { from: 'C:\\c\\2', to: 'C:\\b\\2' },
        ],
      },
    );
    await entry.undo();
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledWith(['C:\\b\\1'], 'C:\\a', 'move', 'skip', {
      record: false,
      sent: 1,
      purpose: 'undo',
    });
  });
});

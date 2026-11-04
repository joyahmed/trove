// The undo history across a restart, per kind of action, against a real disk: do the action,
// save the history, start "a new run" (fresh modules: nothing of the old window survives but
// the file), load it, press Undo, and look at the disk.
import { mkdtempSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { writeFileSync, cpSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UndoRecord } from '$lib/types/undo';

/** The play folder, the fake Recycle Bin (original path -> where it sits in the bin), the file. */
let root = '';
const bin = new Map<string, string>();
let undoJson: string | null = null;
/** The real host: the files are on this disk, so path rules must be this OS's. */
const realOs = process.platform === 'win32' ? 'windows' : 'linux';
let hostOs = realOs;

vi.mock('$lib/utils/platform-facts', () => ({
  injected: () => ({ os: hostOs, thisPcLabel: 'This Computer' }),
}));
vi.mock('$lib/api/undo-log', () => ({
  readUndoLog: vi.fn(async () => (undoJson === null ? null : JSON.parse(undoJson))),
  writeUndoLog: vi.fn(async (value: unknown) => {
    undoJson = JSON.stringify(value);
  }),
}));
vi.mock('$lib/api/log', () => ({ logError: vi.fn(), logInfo: vi.fn() }));
vi.mock('$lib/state/tabs.svelte', () => ({ tabs: { active: { reload: async () => {} } } }));
vi.mock('$lib/state/confirm.svelte', () => ({ confirm: { ask: vi.fn(async () => true) } }));

const freeName = (dir: string, name: string) => {
  let path = join(dir, name);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${name} (${n})`);
  return path;
};

vi.mock('$lib/api/fs', () => ({
  pathKind: vi.fn(async (p: string) => {
    try {
      return statSync(p).isDirectory() ? 'dir' : 'file';
    } catch {
      return 'missing';
    }
  }),
  renameEntry: vi.fn(async (p: string, name: string) => {
    const to = join(dirname(p), name);
    renameSync(p, to);
    return to;
  }),
  createFolder: vi.fn(async (dir: string) => {
    const path = freeName(dir, 'New folder');
    mkdirSync(path);
    return path;
  }),
  createFile: vi.fn(async (dir: string, baseName: string, ext: string) => {
    const path = freeName(dir, `${baseName}.${ext}`);
    writeFileSync(path, '');
    return path;
  }),
  trashEntries: vi.fn(async (paths: string[]) => {
    for (const p of paths) {
      const at = join(root, '.bin', `${bin.size}-${basename(p)}`);
      renameSync(p, at);
      bin.set(p, at);
    }
  }),
  deleteEntries: vi.fn(async (paths: string[]) => {
    for (const p of paths) rmSync(p, { recursive: true });
  }),
}));
/** The fake bin as the backend lists it: the folder each item came from, and its name. */
vi.mock('$lib/api/recycle', () => ({
  recycleList: vi.fn(async () =>
    [...bin.keys()].map((p) => ({
      id: bin.get(p),
      name: basename(p),
      originalParent: dirname(p),
      deletedMs: 0,
      isDir: false,
      size: null,
    })),
  ),
}));
vi.mock('$lib/api/transfer', () => ({
  restoreFromTrash: vi.fn(async (paths: string[]) => {
    for (const p of paths) {
      renameSync(bin.get(p)!, p);
      bin.delete(p);
    }
  }),
}));
/** A move job with Skip: each item into `folder` under its name, never over anything there. */
vi.mock('$lib/state/transfers.svelte', () => ({
  transfers: {
    start: vi.fn(
      async (
        paths: string[],
        folder: string,
        mode: string,
        _r: string,
        o: { names?: string[] },
      ) => {
        paths.forEach((p, i) => {
          const to = join(folder, o.names?.[i] ?? basename(p));
          if (existsSync(to)) return;
          if (mode === 'move') renameSync(p, to);
          else cpSync(p, to, { recursive: true });
        });
        return 1;
      },
    ),
  },
}));

const file = (rel: string, body = rel) => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const body = (path: string) => readFileSync(path, 'utf8');

/** This run's modules, fresh: a restart keeps nothing in memory. */
const run = async () => {
  vi.resetModules();
  const { undo } = await import('./undo.svelte');
  const { undoLog } = await import('./undo-log.svelte');
  const { entryFor } = await import('./undo-executor');
  await undoLog.load(true);
  return { undo, undoLog, entryFor };
};

/** Push what the action left, save it, restart, and press Undo in the new run. */
const restartThenUndo = async (label: string, record: UndoRecord) => {
  const first = await run();
  first.undo.push(first.entryFor({ label, folder: root }, record));
  await first.undoLog.save();
  const second = await run();
  expect(second.undo.undoLabel).toBe(`Undo ${label}`);
  return second.undo.undo();
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trove-undo-log-'));
  mkdirSync(join(root, '.bin'));
  bin.clear();
  undoJson = null;
  hostOs = realOs;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('an undo saved before a restart works after it', () => {
  it('rename: the old name is back', async () => {
    const from = file('a.txt');
    const to = join(root, 'b.txt');
    renameSync(from, to);
    await restartThenUndo('Rename', { kind: 'rename', from, to });
    expect(body(from)).toBe('a.txt');
    expect(existsSync(to)).toBe(false);
  });

  it('move: the items are back where they were, under their own names', async () => {
    const a = file('src/a.txt');
    const b = file('src/b.txt');
    mkdirSync(join(root, 'dst'));
    const pairs = [a, b].map((from) => ({ from, to: join(root, 'dst', basename(from)) }));
    for (const p of pairs) renameSync(p.from, p.to);
    await restartThenUndo('Move', { kind: 'move', pairs });
    expect(body(a)).toBe('src/a.txt');
    expect(body(b)).toBe('src/b.txt');
    expect(existsSync(join(root, 'dst', 'a.txt'))).toBe(false);
  });

  it('copy: the copy goes to the bin, the original stays', async () => {
    const src = file('src/a.txt');
    const made = join(root, 'dst', 'a.txt');
    mkdirSync(dirname(made));
    cpSync(src, made);
    await restartThenUndo('Copy', {
      kind: 'copy',
      created: [made],
      sources: [src],
      destination: dirname(made),
    });
    expect(existsSync(made)).toBe(false);
    expect(bin.has(made)).toBe(true);
    expect(body(src)).toBe('src/a.txt');
  });

  it('trash: the item comes back out of the bin', async () => {
    const a = file('a.txt');
    const { trashEntries } = await import('$lib/api/fs');
    await trashEntries([a]);
    expect(existsSync(a)).toBe(false);
    await restartThenUndo('Delete', { kind: 'trash', paths: [a] });
    expect(body(a)).toBe('a.txt');
  });

  it('new folder: the folder goes to the bin', async () => {
    const path = join(root, 'New folder');
    mkdirSync(path);
    await restartThenUndo('New folder', { kind: 'newFolder', path });
    expect(existsSync(path)).toBe(false);
    expect(bin.has(path)).toBe(true);
  });

  it('new file: the file goes to the bin', async () => {
    const path = file('New Text Document.txt', '');
    await restartThenUndo('New Text Document', {
      kind: 'newFile',
      path,
      baseName: 'New Text Document',
      ext: 'txt',
    });
    expect(existsSync(path)).toBe(false);
  });

  it('a rename whose old name was taken while Trove was closed is refused, nothing changed', async () => {
    const from = file('a.txt');
    const to = join(root, 'b.txt');
    renameSync(from, to);
    const first = await run();
    first.undo.push(first.entryFor({ label: 'Rename' }, { kind: 'rename', from, to }));
    await first.undoLog.save();
    file('a.txt', 'someone else');
    const second = await run();
    await expect(second.undo.undo()).rejects.toThrow(
      'Can\'t undo Rename — something named "a.txt" is already there',
    );
    expect(body(from)).toBe('someone else');
    expect(body(to)).toBe('a.txt');
  });
});

describe('the saved history', () => {
  it('keeps the newest action on top: one done before the file was read goes above it', async () => {
    const first = await run();
    first.undo.push(
      first.entryFor({ label: 'Rename' }, { kind: 'rename', from: '/x/a', to: '/x/b' }),
    );
    await first.undoLog.save();
    vi.resetModules();
    const { undo } = await import('./undo.svelte');
    const { entryFor } = await import('./undo-executor');
    const { undoLog } = await import('./undo-log.svelte');
    undo.push(entryFor({ label: 'New folder' }, { kind: 'newFolder', path: '/x/New folder' }));
    await undoLog.load(true);
    expect(undo.undoLabel).toBe('Undo New folder');
    expect(undo.saved().map((s) => s.label)).toEqual(['Rename', 'New folder']);
    // and it was saved at once, not at the next change
    expect(JSON.parse(undoJson!).entries).toHaveLength(2);
  });

  it('a window other than main neither reads nor writes the file', async () => {
    vi.resetModules();
    const { undo } = await import('./undo.svelte');
    const { undoLog } = await import('./undo-log.svelte');
    const { entryFor } = await import('./undo-executor');
    await undoLog.load(false);
    undo.push(entryFor({ label: 'Rename' }, { kind: 'rename', from: '/x/a', to: '/x/b' }));
    expect(undoJson).toBeNull();
  });

  it('an entry without a record is not saved; a permanent delete is, as a barrier', async () => {
    const first = await run();
    first.undo.push({ label: 'Replace', undo: async () => {}, redo: async () => {} });
    first.undo.pushBarrier(root, ['/x/gone']);
    await new Promise((r) => setTimeout(r, 0)); // the save each change starts
    expect(JSON.parse(undoJson!).entries).toEqual([
      expect.objectContaining({ record: { kind: 'deleteForever', paths: ['/x/gone'] } }),
    ]);
    const second = await run();
    await expect(second.undo.undo()).rejects.toThrow("Can't undo a permanent delete");
  });
});

describe('what can no longer be undone after a restart says so', () => {
  /** Leave `record` in the file, change the world with `meanwhile`, start again. */
  const restarted = async (label: string, record: UndoRecord, meanwhile = () => {}) => {
    const first = await run();
    first.undo.push(first.entryFor({ label }, record));
    await first.undoLog.save();
    meanwhile();
    return (await run()).undo;
  };

  it('a renamed file deleted while Trove was closed', async () => {
    const from = join(root, 'a.txt');
    const to = file('b.txt');
    const undo = await restarted('Rename', { kind: 'rename', from, to }, () => rmSync(to));
    expect(undo.undoLabel).toBe('Can\'t undo Rename — "b.txt" is no longer there');
    await expect(undo.undo()).rejects.toThrow('Can\'t undo Rename — "b.txt" is no longer there');
    // dropped, not kept to fail again
    expect(undo.canUndo).toBe(false);
  });

  it('a delete whose item was emptied from the bin', async () => {
    const a = file('a.txt');
    const { trashEntries } = await import('$lib/api/fs');
    await trashEntries([a]);
    const undo = await restarted('Delete', { kind: 'trash', paths: [a] }, () => bin.clear());
    const { comingFrom } = await import('./coming-from.svelte');
    comingFrom.choice = 'windows';
    expect(undo.undoLabel).toBe("Can't undo Delete — it is no longer in the Recycle Bin");
    comingFrom.choice = 'linux';
    expect(undo.undoLabel).toBe("Can't undo Delete — it is no longer in the Trash");
    comingFrom.choice = 'native';
  });

  it('a delete still in the bin is undoable', async () => {
    const a = file('a.txt');
    const { trashEntries } = await import('$lib/api/fs');
    await trashEntries([a]);
    const undo = await restarted('Delete', { kind: 'trash', paths: [a] });
    expect(undo.undoLabel).toBe('Undo Delete');
  });

  it('a delete on a Mac: the Trash keeps no original path', async () => {
    hostOs = 'macos';
    const undo = await restarted('Delete', { kind: 'trash', paths: [join(root, 'a.txt')] });
    expect(undo.undoLabel).toBe("Can't undo Delete — the Trash can't be read after a restart");
  });

  it('an action only the old run could undo names why', async () => {
    const undo = await restarted('Copy', { kind: 'other', reason: 'it was cancelled partway' });
    expect(undo.undoLabel).toBe("Can't undo Copy — it was cancelled partway");
  });

  it('a permanent delete stays a barrier, not a stale entry', async () => {
    const undo = await restarted('Permanent delete', { kind: 'deleteForever', paths: ['/x/a'] });
    expect(undo.undoLabel).toBe("Can't undo a permanent delete");
    await expect(undo.undo()).rejects.toThrow("Can't undo a permanent delete");
    expect(undo.canUndo).toBe(true);
  });

  it('a redo of a stale entry is not offered: it was dropped, not moved', async () => {
    const undo = await restarted('Copy', { kind: 'other', reason: 'it replaced older files' });
    await expect(undo.undo()).rejects.toThrow();
    expect(undo.canRedo).toBe(false);
  });
});

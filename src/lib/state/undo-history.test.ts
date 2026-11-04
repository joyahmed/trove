import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { UndoEntry } from './undo.svelte';
import type { UndoRecord } from '$lib/types/undo';

vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
}));

// a fresh stack per test: a barrier never leaves the history, so one test's would leak
let undo: typeof import('./undo.svelte').undo;
let UndoRefused: typeof import('./undo.svelte').UndoRefused;
let UndoBarrier: typeof import('./undo.svelte').UndoBarrier;
let historyRows: typeof import('./undo-history.svelte').historyRows;
let isDisabled: typeof import('./undo-history.svelte').isDisabled;
let reload: Mock<() => Promise<void>>;

beforeEach(async () => {
  vi.resetModules();
  ({ undo, UndoRefused, UndoBarrier } = await import('./undo.svelte'));
  ({ historyRows, isDisabled } = await import('./undo-history.svelte'));
  const { tabs } = await import('./tabs.svelte');
  reload = vi.fn(async () => {});
  vi.spyOn(tabs.active, 'reload').mockImplementation(reload);
});

const entry = (
  label: string,
  record: UndoRecord,
  log: string[],
  extra: Partial<UndoEntry> = {},
): UndoEntry => ({
  label,
  undo: async () => void log.push(`undo ${label}`),
  redo: async () => void log.push(`redo ${label}`),
  toRecord: () => record,
  ...extra,
});

const rename = (from: string, to: string): UndoRecord => ({ kind: 'rename', from, to });
const labels = () => undo.entries.map((e) => e.label);

describe('undo history', () => {
  it('an empty stack gives no rows', () => {
    expect(historyRows(undo.entries)).toEqual([]);
  });

  it('undoAt on a middle entry undoes only it; the others keep their order and redo is unchanged', async () => {
    const log: string[] = [];
    undo.push(entry('A', rename('/w/a', '/w/a2'), log));
    undo.push(entry('B', rename('/w/b', '/w/b2'), log));
    undo.push(entry('C', rename('/w/c', '/w/c2'), log));
    undo.push(entry('D', rename('/w/d', '/w/d2'), log));
    await undo.undo(); // D goes on redo
    expect(undo.redoLabel).toBe('Redo D');
    log.length = 0;

    const done = await undo.undoAt(1);
    expect(done?.label).toBe('B');
    expect(log).toEqual(['undo B']);
    expect(labels()).toEqual(['A', 'C']);
    expect(undo.redoLabel).toBe('Redo D');
    expect(undo.canRedo).toBe(true);
    expect(reload).toHaveBeenCalled();
    expect(undo.busy).toBe(false);
  });

  it('runs the world check before the step', async () => {
    const log: string[] = [];
    undo.push(entry('A', rename('/w/a', '/w/a2'), log));
    undo.push(entry('B', rename('/w/b', '/w/b2'), log));
    await undo.undoAt(0, async (e) => void log.push(`check ${e.label}`));
    expect(log).toEqual(['check A', 'undo A']);
  });

  it('a blocked pick throws UndoRefused naming the blocker, and keeps the entry', async () => {
    const log: string[] = [];
    undo.push(entry('Rename', rename('/w/a.txt', '/w/report.txt'), log));
    undo.push(entry('Copy', { kind: 'copy', created: ['/z/x'] }, log));
    undo.push(
      entry(
        'Move',
        {
          kind: 'move',
          pairs: [
            { from: '/w/report.txt', to: '/x/report.txt' },
            { from: '/w/b', to: '/x/b' },
            { from: '/w/c', to: '/x/c' },
          ],
        },
        log,
      ),
    );
    const refused = undo.undoAt(0);
    await expect(refused).rejects.toBeInstanceOf(UndoRefused);
    await expect(undo.undoAt(0)).rejects.toThrow('Undo Move 3 items first — it moved report.txt');
    expect(log).toEqual([]);
    expect(labels()).toEqual(['Rename', 'Copy', 'Move']);

    const rows = historyRows(undo.entries);
    expect(rows.map((r) => [r.title, r.status])).toEqual([
      ['Move 3 items', 'ready'],
      ['Copy "x"', 'ready'],
      ['Rename "a.txt"', 'blocked'],
    ]);
    expect(rows[2].note).toBe('Undo Move 3 items first — it moved report.txt');
    expect(rows.map((r) => isDisabled(r))).toEqual([false, false, false]);
    expect(rows[0].newest).toBe(true);
    expect(rows[2].index).toBe(0);
  });

  it('stale and barrier rows are disabled, with their note', async () => {
    const log: string[] = [];
    undo.push(
      entry('Delete', { kind: 'trash', paths: ['/w/gone'] }, log, {
        stale: 'it is no longer in the Recycle Bin',
      }),
    );
    undo.push(
      entry('Delete permanently', { kind: 'deleteForever', paths: ['/w/p'] }, log, {
        barrier: true,
      }),
    );
    undo.push(entry('Rename', rename('/z/a', '/z/b'), log));
    const rows = historyRows(undo.entries);
    expect(rows.map((r) => r.status)).toEqual(['ready', 'barrier', 'stale']);
    expect(rows[1].note).toBe("Can't undo a permanent delete");
    expect(rows[2].note).toBe("Can't undo Delete — it is no longer in the Recycle Bin");
    expect(rows.map((r) => isDisabled(r))).toEqual([false, true, true]);

    await expect(undo.undoAt(1)).rejects.toBeInstanceOf(UndoBarrier);
    expect(labels()).toEqual(['Delete', 'Delete permanently', 'Rename']);
    // a stale pick says why and drops the entry, as a plain undo of it does
    await expect(undo.undoAt(0)).rejects.toThrow('no longer in the Recycle Bin');
    expect(labels()).toEqual(['Delete permanently', 'Rename']);
    expect(log).toEqual([]);
  });

  it("a stale row names the bin in the chosen style's word", async () => {
    const { comingFrom } = await import('./coming-from.svelte');
    const log: string[] = [];
    undo.push(
      entry('Delete', { kind: 'trash', paths: ['/w/gone'] }, log, {
        stale: 'it is no longer in the Recycle Bin',
      }),
    );
    comingFrom.choice = 'linux';
    expect(historyRows(undo.entries)[0].note).toBe(
      "Can't undo Delete — it is no longer in the Trash",
    );
    comingFrom.choice = 'windows';
    expect(historyRows(undo.entries)[0].note).toBe(
      "Can't undo Delete — it is no longer in the Recycle Bin",
    );
  });

  it('undoing the newest via undoAt is a plain undo and goes on redo', async () => {
    const log: string[] = [];
    undo.push(entry('A', rename('/w/a', '/w/a2'), log));
    undo.push(entry('B', rename('/w/b', '/w/b2'), log));
    await undo.undoAt(1);
    expect(log).toEqual(['undo B']);
    expect(labels()).toEqual(['A']);
    expect(undo.redoLabel).toBe('Redo B');
  });
});

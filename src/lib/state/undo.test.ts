import { describe, expect, it, vi } from 'vitest';
import { undo } from './undo.svelte';
import { tabs } from './tabs.svelte';

vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
}));

const entry = (label: string, log: string[]) => ({
  label,
  undo: async () => void log.push(`undo ${label}`),
  redo: async () => void log.push(`redo ${label}`),
});

describe('undo', () => {
  it('starts empty with bare labels', () => {
    expect(undo.canUndo).toBe(false);
    expect(undo.canRedo).toBe(false);
    expect(undo.undoLabel).toBe('Undo');
    expect(undo.redoLabel).toBe('Redo');
  });

  it('undoes in reverse order and redoes forward, reloading the tab each time', async () => {
    const log: string[] = [];
    const refresh = vi.spyOn(tabs.active, 'reload').mockResolvedValue();
    undo.push(entry('Rename', log));
    undo.push(entry('Move', log));
    expect(undo.undoLabel).toBe('Undo Move');
    await undo.undo();
    expect(log).toEqual(['undo Move']);
    expect(undo.undoLabel).toBe('Undo Rename');
    expect(undo.redoLabel).toBe('Redo Move');
    await undo.redo();
    expect(log).toEqual(['undo Move', 'redo Move']);
    expect(undo.canRedo).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(2);
    refresh.mockRestore();
    await undo.undo();
    await undo.undo();
    expect(undo.canUndo).toBe(false);
  });

  it('a new action discards the redo stack', async () => {
    const log: string[] = [];
    undo.push(entry('Delete', log));
    await undo.undo();
    expect(undo.canRedo).toBe(true);
    undo.push(entry('Copy', log));
    expect(undo.canRedo).toBe(false);
    expect(undo.undoLabel).toBe('Undo Copy');
    await undo.undo();
  });

  it('a failing undo drops the entry and rethrows', async () => {
    undo.push({
      label: 'Rename',
      undo: async () => {
        throw new Error('gone');
      },
      redo: async () => {},
    });
    await expect(undo.undo()).rejects.toThrow('gone');
    expect(undo.canUndo).toBe(false);
    expect(undo.canRedo).toBe(false);
    expect(undo.busy).toBe(false);
  });
});

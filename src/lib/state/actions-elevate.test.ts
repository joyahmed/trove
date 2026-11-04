// "Retry as administrator" (plan 05 5.6): offered on access denied only, and runs the one op.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from './actions.svelte';
import { confirm } from './confirm.svelte';
import { notices } from './notices.svelte';
import { selection } from './selection.svelte';
import { tabs } from './tabs.svelte';
import { pathLocation } from '$lib/utils/location';
import type { ElevatedOp } from '$lib/api/fs';

const DENIED = 'Access is denied. (os error 5)';
const deleteEntries = vi.fn<(paths: string[]) => Promise<void>>(async () => {});
const createFolder = vi.fn<(dir: string) => Promise<string>>(async () => '');
const retryElevated = vi.fn<(op: ElevatedOp) => Promise<string>>(async () => '');
vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  deleteEntries: (paths: string[]) => deleteEntries(paths),
  createFolder: (dir: string) => createFolder(dir),
  retryElevated: (op: ElevatedOp) => retryElevated(op),
  pathKind: vi.fn(async () => 'dir' as const),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  oneDriveRoot: vi.fn(async () => null),
}));

const settle = () => new Promise((r) => setTimeout(r, 0));
const last = () => notices.list.at(-1);

describe('Retry as administrator', () => {
  beforeEach(() => {
    for (const m of [deleteEntries, createFolder, retryElevated]) m.mockReset();
    notices.clear();
    tabs.active.location = pathLocation('C:\\Program Files');
    vi.spyOn(tabs.active, 'reload').mockResolvedValue();
  });

  it('a denied new folder offers it, and the button runs createFolder elevated', async () => {
    createFolder.mockRejectedValue(DENIED);
    retryElevated.mockResolvedValue('C:\\Program Files\\New folder');
    await actions.newFolder();
    expect(last()).toMatchObject({ kind: 'error', action: { label: 'Retry as administrator' } });
    await last()?.action?.run();
    expect(retryElevated).toHaveBeenCalledWith({ kind: 'createFolder', dir: 'C:\\Program Files' });
  });

  it('a denied permanent delete offers it with the same paths', async () => {
    const paths = ['C:\\Program Files\\a.txt'];
    selection.replaceAll(paths);
    deleteEntries.mockRejectedValue(DENIED);
    const run = actions.deletePermanently();
    await settle();
    confirm.answer(true);
    await run;
    expect(last()?.action?.label).toBe('Retry as administrator');
    await last()?.action?.run();
    expect(retryElevated).toHaveBeenCalledWith({ kind: 'delete', paths });
  });

  it('an elevated run that fails again is a plain error, no second offer', async () => {
    createFolder.mockRejectedValue(DENIED);
    retryElevated.mockRejectedValue('Retry as administrator was cancelled');
    await actions.newFolder();
    await last()?.action?.run();
    expect(last()).toMatchObject({
      kind: 'error',
      message: 'Retry as administrator was cancelled',
    });
    expect(last()?.action).toBeUndefined();
  });

  it('any other failure is not offered it', async () => {
    createFolder.mockRejectedValue('The device is not ready. (os error 21)');
    await actions.newFolder();
    expect(last()?.kind).toBe('error');
    expect(last()?.action).toBeUndefined();
    expect(retryElevated).not.toHaveBeenCalled();
  });
});

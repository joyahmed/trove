import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from './actions.svelte';
import { confirm } from './confirm.svelte';
import { notices } from './notices.svelte';
import { selection } from './selection.svelte';
import { tabs } from './tabs.svelte';
import { transfers } from './transfers.svelte';
import { undo } from './undo.svelte';
import { pathLocation } from '$lib/utils/location';
import { newItemKinds } from '$lib/data/new-items';
import { NoRecycleBin } from '$lib/api/fs';
import type { ArchiveOutput } from '$lib/types/archive';
import { listing } from './listing.svelte';
import { comingFrom } from './coming-from.svelte';

const COMPRESS_JOB = 77;
const deleteEntries = vi.fn<(paths: string[]) => Promise<void>>(async () => {});
const trashEntries = vi.fn<(paths: string[]) => Promise<void>>(async () => {});
const createFolder = vi.fn<(dir: string) => Promise<string>>(async () => '');
const restoreFromTrash = vi.fn<(paths: string[]) => Promise<void>>(async () => {});
vi.mock('$lib/api/fs', async (importOriginal) => ({
  // the real class: the routing must recognise exactly what the api layer throws
  NoRecycleBin: (await importOriginal<typeof import('$lib/api/fs')>()).NoRecycleBin,
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  deleteEntries: (paths: string[]) => deleteEntries(paths),
  trashEntries: (paths: string[]) => trashEntries(paths),
  createFolder: (dir: string) => createFolder(dir),
  createFile: vi.fn(async () => ''),
  renameEntry: vi.fn(async () => ''),
  openPath: vi.fn(async () => {}),
  // what an undo checks first: the new folder it removes is there
  pathKind: vi.fn(async () => 'dir' as const),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));
vi.mock('$lib/api/transfer', () => ({
  restoreFromTrash: (paths: string[]) => restoreFromTrash(paths),
  transferConflicts: vi.fn(async () => []),
  startTransfer: vi.fn(async () => 1),
  cancelTransfer: vi.fn(async () => {}),
  onTransferProgress: vi.fn(async () => () => {}),
  onTransferDone: vi.fn(async () => () => {}),
}));
vi.mock('$lib/api/archive', () => ({
  archiveConflicts: vi.fn(async () => []),
  startExtract: vi.fn(async () => 1),
  startExtractHere: vi.fn(async () => 1),
  startCompress: vi.fn(async () => COMPRESS_JOB),
}));
vi.mock('$lib/api/clipboard', () => ({
  clipboardWritePaths: vi.fn(async () => {}),
  clipboardReadPaths: vi.fn(async () => null),
}));

const WSL_DIR = '\\\\wsl.localhost\\Ubuntu\\home\\alex';
const inWsl = (name: string) => `${WSL_DIR}\\${name}`;

/**
 * The backend's verdict, as the tests stand in for it: only it decides where the bin is. A
 * mapped drive (`N:`) or a WSL path refuses the whole batch and deletes nothing. The frontend
 * must not need the path to look like anything — `N:\` is an ordinary drive letter to it.
 */
const backendTrash = async (paths: string[]) => {
  const wsl = paths.filter((p) => p.startsWith(WSL_DIR) || p.startsWith('//wsl$'));
  const mapped = paths.filter((p) => p.startsWith('N:'));
  const stuck = paths.filter((p) => wsl.includes(p) || mapped.includes(p));
  if (wsl.length > 0)
    throw new NoRecycleBin('WSL', `WSL folders have no Recycle Bin: ${wsl[0]}`, 'noBin', stuck);
  if (mapped.length > 0)
    throw new NoRecycleBin('N:', `N: has no Recycle Bin: ${mapped[0]}`, 'noBin', stuck);
};

/** let the action reach its confirm (or finish) before the test looks */
const settle = () => new Promise((r) => setTimeout(r, 0));

const resetMocks = () => {
  for (const m of [deleteEntries, trashEntries, createFolder, restoreFromTrash]) m.mockClear();
  trashEntries.mockImplementation(backendTrash);
  confirm.answer(false);
  notices.clear();
};

describe('actions.deletePermanently', () => {
  beforeEach(() => {
    resetMocks();
    tabs.active.location = pathLocation('C:\\scratch');
    vi.spyOn(tabs.active, 'reload').mockResolvedValue();
    selection.replaceAll(['C:\\scratch\\a.txt', 'C:\\scratch\\b.txt']);
  });

  it('asks first and deletes for good on yes', async () => {
    const run = actions.deletePermanently();
    expect(confirm.pending?.message).toBe(
      'Are you sure you want to permanently delete these 2 items?',
    );
    confirm.answer(true);
    await run;
    expect(deleteEntries).toHaveBeenCalledWith(['C:\\scratch\\a.txt', 'C:\\scratch\\b.txt']);
    expect(trashEntries).not.toHaveBeenCalled();
    expect(selection.count).toBe(0);
  });

  it.each([
    [true, 'Delete Folder'],
    [false, 'Delete File'],
  ])('one selected (isDir=%s): title is %s', async (isDir, title) => {
    const path = 'C:\\scratch\\one';
    tabs.active.entries = [
      {
        name: 'one',
        path,
        isDir,
        size: 0,
        modifiedMs: null,
        createdMs: null,
        ext: '',
        isHidden: false,
        iconKey: isDir ? 'folder' : 'file',
        typeName: isDir ? 'File folder' : 'File',
      },
    ];
    selection.replaceAll([path]);
    expect(listing.rows.map((e) => e.path)).toEqual([path]);
    const run = actions.deletePermanently();
    expect(confirm.pending?.title).toBe(title);
    confirm.answer(false);
    await run;
  });

  it('several selected: title says Multiple Items', async () => {
    const run = actions.deletePermanently();
    expect(confirm.pending?.title).toBe('Delete Multiple Items');
    confirm.answer(false);
    await run;
  });

  it('does nothing on no', async () => {
    const run = actions.deletePermanently();
    confirm.answer(false);
    await run;
    expect(deleteEntries).not.toHaveBeenCalled();
    expect(selection.count).toBe(2);
  });

  // the Ubuntu run: Ctrl+Z after a Shift+Delete undid an OLDER copy in another folder, silently
  it('Ctrl+Z after it says it cannot undo, and does not reach the older action', async () => {
    const older = vi.fn(async () => {});
    undo.push({
      label: 'Copy',
      what: 'copy of "pkg" to "out2"',
      folder: 'C:\\c216\\out2',
      undo: older,
      redo: async () => {},
    });
    const run = actions.deletePermanently();
    confirm.answer(true);
    await run;
    expect(undo.undoLabel).toBe("Can't undo a permanent delete");
    await actions.undo();
    await actions.undo();
    expect(older).not.toHaveBeenCalled();
    expect(notices.list.at(-1)).toMatchObject({
      kind: 'info',
      message: "Can't undo a permanent delete",
    });
    expect(undo.undoLabel).toBe("Can't undo a permanent delete");
  });
});

describe('a stale trash entry names the bin in the chosen style (Ctrl+Z and the More menu)', () => {
  beforeEach(() => {
    resetMocks();
    tabs.active.location = pathLocation('/scratch');
  });

  const stale = () => ({
    label: 'Delete',
    stale: 'it is no longer in the Recycle Bin',
    undo: async () => {},
    redo: async () => {},
  });

  it.each([
    ['linux', "Can't undo Delete — it is no longer in the Trash"],
    ['mac', "Can't undo Delete — it is no longer in the Trash"],
    ['windows', "Can't undo Delete — it is no longer in the Recycle Bin"],
  ] as const)('coming from %s: notice and menu label say it', async (style, text) => {
    comingFrom.choice = style;
    try {
      undo.push(stale());
      expect(undo.undoLabel).toBe(text);
      await actions.undo();
      expect(notices.list.at(-1)).toMatchObject({ kind: 'warning', message: text });
    } finally {
      comingFrom.choice = 'native';
    }
  });
});

describe('the notice after an undo / redo', () => {
  beforeEach(() => {
    resetMocks();
    tabs.active.location = pathLocation('C:\\scratch');
    vi.spyOn(tabs.active, 'reload').mockResolvedValue();
  });

  const copy = (folder: string) => ({
    label: 'Copy',
    what: 'copy of "pkg" to "out2"',
    folder,
    undo: async () => {},
    redo: async () => {},
  });

  it('names what it undid and redid', async () => {
    undo.push(copy('C:\\scratch'));
    await actions.undo();
    expect(notices.list.at(-1)).toMatchObject({
      kind: 'info',
      message: 'Undid copy of "pkg" to "out2"',
    });
    await actions.redo();
    expect(notices.list.at(-1)?.message).toBe('Redid copy of "pkg" to "out2"');
  });

  it('an undo in a folder not shown says where it was', async () => {
    undo.push(copy('C:\\c216\\out2'));
    await actions.undo();
    expect(notices.list.at(-1)?.message).toBe(
      'Undid copy of "pkg" to "out2" — in C:\\c216\\out2, not this folder',
    );
  });

  it('an entry with no description falls back to its label', async () => {
    undo.push({ label: 'Extract', undo: async () => {}, redo: async () => {} });
    await actions.undo();
    expect(notices.list.at(-1)?.message).toBe('Undid extract');
  });
});

describe('Delete where the backend says there is no Recycle Bin', () => {
  beforeEach(() => {
    resetMocks();
    tabs.active.location = pathLocation('N:\\Home');
    vi.spyOn(tabs.active, 'reload').mockResolvedValue();
  });

  it('a mapped drive: tries the bin, then asks naming the drive, deletes for good, no undo', async () => {
    selection.replaceAll(['N:\\Home\\a.txt', 'N:\\Home\\b.txt']);
    const push = vi.spyOn(undo, 'push');
    const run = actions.deleteSelected();
    await settle();
    expect(trashEntries).toHaveBeenCalledWith(['N:\\Home\\a.txt', 'N:\\Home\\b.txt']);
    expect(confirm.pending?.message).toBe(
      'N: has no Recycle Bin — permanently delete these 2 items?',
    );
    expect(confirm.pending?.danger).toBe(true);
    confirm.answer(true);
    await run;
    expect(deleteEntries).toHaveBeenCalledWith(['N:\\Home\\a.txt', 'N:\\Home\\b.txt']);
    // nothing to undo: only the barrier that stops a Ctrl+Z reaching past it
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({ barrier: true });
    expect(selection.count).toBe(0);
    push.mockRestore();
  });

  it('no keeps the files, pushes no undo and shows no error', async () => {
    selection.replaceAll(['N:\\Home\\a.txt']);
    const push = vi.spyOn(undo, 'push');
    const run = actions.deleteSelected();
    await settle();
    confirm.answer(false);
    await run;
    expect(deleteEntries).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(selection.count).toBe(1);
    expect(notices.list).toHaveLength(0);
    push.mockRestore();
  });

  it('WSL keeps its own wording', async () => {
    tabs.active.location = pathLocation(WSL_DIR);
    selection.replaceAll([inWsl('a.txt'), inWsl('b.txt')]);
    const run = actions.deleteSelected();
    await settle();
    expect(confirm.pending?.message).toBe(
      'WSL has no Recycle Bin — permanently delete these 2 items?',
    );
    confirm.answer(true);
    await run;
    expect(deleteEntries).toHaveBeenCalledWith([inWsl('a.txt'), inWsl('b.txt')]);
  });

  it('a mixed batch: the bin takes C: with an undo, the question covers only the rest', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    selection.replaceAll(['C:\\scratch\\a.txt', 'N:\\Home\\b.txt', '//wsl$/Ubuntu/c.txt']);
    const push = vi.spyOn(undo, 'push');
    const run = actions.deleteSelected();
    await settle();
    expect(trashEntries).toHaveBeenLastCalledWith(['C:\\scratch\\a.txt']);
    expect(push).toHaveBeenCalledTimes(1);
    expect([...selection.paths]).toEqual(['N:\\Home\\b.txt', '//wsl$/Ubuntu/c.txt']);
    expect(confirm.pending?.message).toBe(
      'WSL has no Recycle Bin — permanently delete these 2 items?',
    );
    confirm.answer(true);
    await run;
    expect(deleteEntries).toHaveBeenCalledTimes(1);
    expect(deleteEntries).toHaveBeenCalledWith(['N:\\Home\\b.txt', '//wsl$/Ubuntu/c.txt']);
    push.mockRestore();
  });

  it('a mixed batch whose bin part is refused again: an error, nothing deleted for good', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    selection.replaceAll(['C:\\scratch\\a.txt', 'N:\\Home\\b.txt']);
    trashEntries.mockImplementationOnce(backendTrash).mockRejectedValueOnce('Access is denied');
    const push = vi.spyOn(undo, 'push');
    await actions.deleteSelected();
    expect(trashEntries).toHaveBeenLastCalledWith(['C:\\scratch\\a.txt']);
    expect(confirm.pending).toBeNull();
    expect(deleteEntries).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(notices.list.at(-1)).toMatchObject({ kind: 'error', message: 'Access is denied' });
    push.mockRestore();
  });

  it('the question names why the bin refused: turned off, or too big', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    selection.replaceAll(['C:\\scratch\\a.txt']);
    trashEntries.mockRejectedValueOnce(
      new NoRecycleBin('C:', 'off', 'off', ['C:\\scratch\\a.txt']),
    );
    const run = actions.deleteSelected();
    await settle();
    expect(confirm.pending?.message).toBe(
      'The Recycle Bin is turned off for C: — permanently delete this file?',
    );
    confirm.answer(false);
    await run;
    selection.replaceAll(['C:\\scratch\\a.txt']);
    trashEntries.mockRejectedValueOnce(new NoRecycleBin('C:', 'big', 'tooBig', []));
    const again = actions.deleteSelected();
    await settle();
    expect(confirm.pending?.message).toBe(
      'Too big for the Recycle Bin on C: — permanently delete this file?',
    );
    confirm.answer(false);
    await again;
    expect(deleteEntries).not.toHaveBeenCalled();
  });

  // macOS refused the Trash (Finder's Apple Events denied, file manager failed): the backend
  // returns `denied`, so Delete asks the plain question and Cancel deletes nothing.
  it('Delete where macOS refused the Trash asks, and Cancel deletes nothing', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    selection.replaceAll(['C:\\scratch\\a.txt']);
    trashEntries.mockRejectedValueOnce(
      new NoRecycleBin('This Mac', 'denied', 'denied', ['C:\\scratch\\a.txt']),
    );
    const run = actions.deleteSelected();
    await settle();
    expect(confirm.pending?.message).toMatch(
      /^macOS did not let Trove use the (Trash|Recycle Bin) — permanently delete this file\?$/,
    );
    confirm.answer(false);
    await run;
    expect(deleteEntries).not.toHaveBeenCalled();
    expect(trashEntries).toHaveBeenCalledTimes(1);
  });

  it('a partial `denied` keeps what already went to the Trash, asks only about the rest', async () => {
    const push = vi.spyOn(undo, 'push');
    tabs.active.location = pathLocation('C:\\scratch');
    selection.replaceAll(['C:\\scratch\\a.txt', 'C:\\scratch\\b.txt']);
    trashEntries.mockRejectedValueOnce(
      new NoRecycleBin('This Mac', 'denied', 'denied', ['C:\\scratch\\b.txt']),
    );
    const run = actions.deleteSelected();
    await settle();
    // a.txt is already in the Trash: no second try, its undo is kept
    expect(trashEntries).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledOnce();
    expect(confirm.pending?.message).toMatch(/permanently delete this file\?$/);
    confirm.answer(false);
    await run;
    expect(deleteEntries).not.toHaveBeenCalled();
    push.mockRestore();
  });

  // Plan 19, 1.4.3: only the bin's WORD follows "I'm coming from"; the question is still asked
  // and nothing is deleted until it is answered yes.
  it('the question names the bin by the style, and is still asked', async () => {
    try {
      for (const [style, bin] of [
        ['windows', 'Recycle Bin'],
        ['mac', 'Trash'],
        ['linux', 'Trash'],
      ] as const) {
        comingFrom.choice = style;
        tabs.active.location = pathLocation('C:\\scratch');
        selection.replaceAll(['C:\\scratch\\a.txt']);
        trashEntries.mockRejectedValueOnce(
          new NoRecycleBin('C:', 'off', 'off', ['C:\\scratch\\a.txt']),
        );
        const run = actions.deleteSelected();
        await settle();
        expect(confirm.pending?.message).toBe(
          `The ${bin} is turned off for C: — permanently delete this file?`,
        );
        expect(confirm.pending?.danger).toBe(true);
        confirm.answer(false);
        await run;
      }
      expect(deleteEntries).not.toHaveBeenCalled();
    } finally {
      comingFrom.choice = 'native';
    }
  });

  it('a local selection goes to the bin with a restore undo and no question', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    selection.replaceAll(['C:\\scratch\\a.txt']);
    const push = vi.spyOn(undo, 'push');
    await actions.deleteSelected();
    expect(confirm.pending).toBeNull();
    expect(trashEntries).toHaveBeenCalledWith(['C:\\scratch\\a.txt']);
    expect(deleteEntries).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].label).toBe('Delete');
    push.mockRestore();
  });

  it('any other trash failure is an error toast: no question, no permanent delete, no undo', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    selection.replaceAll(['C:\\scratch\\a.txt']);
    trashEntries.mockRejectedValueOnce('Access is denied');
    const push = vi.spyOn(undo, 'push');
    await actions.deleteSelected();
    expect(confirm.pending).toBeNull();
    expect(deleteEntries).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(notices.list.at(-1)).toMatchObject({ kind: 'error', message: 'Access is denied' });
    push.mockRestore();
  });
});

describe('undo of a creation where there is no Recycle Bin', () => {
  const folder = inWsl('New folder');
  const zip = inWsl('a.zip');

  /** compress is a job: start it, then let the backend report that it landed the zip */
  const compressed = async () => {
    await actions.compress();
    await transfers.applyDone({
      jobId: COMPRESS_JOB,
      outputs: [{ from: inWsl('a.txt'), to: zip, created: true } as ArchiveOutput],
      failed: [],
      error: null,
      cancelled: false,
    });
  };

  beforeEach(() => {
    resetMocks();
    tabs.active.location = pathLocation(WSL_DIR);
    vi.spyOn(tabs.active, 'reload').mockResolvedValue();
    createFolder.mockResolvedValue(folder);
  });

  it('New folder on WSL: the bin refuses, it asks, then deletes it for good', async () => {
    await actions.newItem(newItemKinds[0]);
    const run = actions.undo();
    await settle();
    expect(trashEntries).toHaveBeenCalledWith([folder]);
    expect(confirm.pending?.message).toBe(
      'WSL has no Recycle Bin — permanently delete the new folder?',
    );
    expect(confirm.pending?.title).toBe('Delete Folder');
    confirm.answer(true);
    await run;
    expect(deleteEntries).toHaveBeenCalledWith([folder]);
    expect(undo.redoLabel).toBe('Redo New folder');
  });

  it('New folder on a mapped drive names the drive', async () => {
    tabs.active.location = pathLocation('N:\\Home');
    createFolder.mockResolvedValue('N:\\Home\\New folder');
    await actions.newItem(newItemKinds[0]);
    const run = actions.undo();
    await settle();
    expect(confirm.pending?.message).toBe(
      'N: has no Recycle Bin — permanently delete the new folder?',
    );
    confirm.answer(true);
    await run;
    expect(deleteEntries).toHaveBeenCalledWith(['N:\\Home\\New folder']);
  });

  it('New folder: no keeps it, says so, and is not an error', async () => {
    await actions.newItem(newItemKinds[0]);
    const run = actions.undo();
    await settle();
    confirm.answer(false);
    await run;
    expect(deleteEntries).not.toHaveBeenCalled();
    expect(notices.list.at(-1)).toMatchObject({
      kind: 'info',
      message: 'Undo cancelled — the new folder was not deleted',
    });
    // the undo did not happen, so it is still there to undo
    expect(undo.redoLabel).not.toBe('Redo New folder');
  });

  it('Compress: asks, then deletes the zip for good', async () => {
    selection.replaceAll([inWsl('a.txt')]);
    await compressed();
    const run = actions.undo();
    await settle();
    expect(confirm.pending?.message).toBe(
      'WSL has no Recycle Bin — permanently delete the ZIP file?',
    );
    confirm.answer(true);
    await run;
    expect(deleteEntries).toHaveBeenCalledWith([zip]);
  });

  it('Compress: no keeps the zip', async () => {
    selection.replaceAll([inWsl('a.txt')]);
    await compressed();
    const run = actions.undo();
    await settle();
    expect(confirm.pending?.message).toBe(
      'WSL has no Recycle Bin — permanently delete the ZIP file?',
    );
    confirm.answer(false);
    await run;
    expect(deleteEntries).not.toHaveBeenCalled();
    expect(notices.list.at(-1)).toMatchObject({
      kind: 'info',
      message: 'Undo cancelled — the ZIP file was not deleted',
    });
  });

  it('on a local disk the same undo goes to the bin without asking', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    createFolder.mockResolvedValue('C:\\scratch\\New folder');
    await actions.newItem(newItemKinds[0]);
    await actions.undo();
    expect(confirm.pending).toBeNull();
    expect(trashEntries).toHaveBeenCalledWith(['C:\\scratch\\New folder']);
    expect(deleteEntries).not.toHaveBeenCalled();
  });
});

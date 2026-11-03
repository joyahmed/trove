import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from './actions.svelte';
import { clipboard } from './clipboard.svelte';
import { selection } from './selection.svelte';
import { tabs } from './tabs.svelte';
import { clipboardReadPaths } from '$lib/api/clipboard';
import { pathLocation } from '$lib/utils/location';

const writeText = vi.fn<(paths: string[]) => Promise<void>>(async () => {});
vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  deleteEntries: vi.fn(async () => {}),
  trashEntries: vi.fn(async () => {}),
  createFolder: vi.fn(async () => ''),
  createFile: vi.fn(async () => ''),
  renameEntry: vi.fn(async () => ''),
  openPath: vi.fn(async () => {}),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));
vi.mock('$lib/api/transfer', () => ({
  restoreFromTrash: vi.fn(async () => {}),
  transferConflicts: vi.fn(async () => []),
  startTransfer: vi.fn(async () => 1),
  cancelTransfer: vi.fn(async () => {}),
  onTransferProgress: vi.fn(async () => () => {}),
  onTransferDone: vi.fn(async () => () => {}),
}));
vi.mock('$lib/api/clipboard', () => ({
  clipboardWritePaths: vi.fn(async () => {}),
  clipboardWritePathsText: (paths: string[]) => writeText(paths),
  clipboardReadPaths: vi.fn(async () => null),
}));

const select = (...paths: string[]) => {
  selection.clear();
  for (const p of paths) selection.click(p, { ctrl: true, shift: false }, paths);
};

describe('actions.copyAsPath', () => {
  beforeEach(() => {
    writeText.mockClear();
  });

  it('copies Windows paths as they are', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    select('C:\\scratch\\a b.txt', 'C:\\scratch\\c');
    await actions.copyAsPath();
    expect(writeText).toHaveBeenCalledWith(['C:\\scratch\\a b.txt', 'C:\\scratch\\c']);
  });

  it('copies a WSL-only selection in its distro:/ form', async () => {
    tabs.active.location = pathLocation('\\\\wsl.localhost\\Ubuntu\\home');
    select('\\\\wsl.localhost\\Ubuntu\\home\\alex', '\\\\wsl.localhost\\Ubuntu\\home\\notes.md');
    await actions.copyAsPath();
    expect(writeText).toHaveBeenCalledWith(['Ubuntu:/home/alex', 'Ubuntu:/home/notes.md']);
  });

  it('keeps the Windows form for a mixed selection and does nothing with none', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    select('C:\\scratch\\x', '\\\\wsl.localhost\\Ubuntu\\home\\alex');
    await actions.copyAsPath();
    expect(writeText).toHaveBeenCalledWith([
      'C:\\scratch\\x',
      '\\\\wsl.localhost\\Ubuntu\\home\\alex',
    ]);
    selection.clear();
    writeText.mockClear();
    await actions.copyAsPath();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('clears a pending cut right away, since the clipboard now holds text', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    select('C:\\scratch\\a.txt');
    actions.cut();
    expect(clipboard.isCut('C:\\scratch\\a.txt')).toBe(true);
    await actions.copyAsPath();
    expect(clipboard.has).toBe(false);
    expect(clipboard.isCut('C:\\scratch\\a.txt')).toBe(false);
  });

  it('pasting a cut back into its own folder is complete: nothing moves, nothing stays dimmed', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    select('C:\\scratch\\a.txt');
    actions.cut();
    expect(clipboard.isCut('C:\\scratch\\a.txt')).toBe(true);
    // the OS clipboard still holds the cut list, as it does in the app
    vi.mocked(clipboardReadPaths).mockResolvedValue({ paths: ['C:\\scratch\\a.txt'], cut: true });
    await actions.paste();
    vi.mocked(clipboardReadPaths).mockResolvedValue(null);
    expect(clipboard.has).toBe(false);
    expect(clipboard.isCut('C:\\scratch\\a.txt')).toBe(false);
  });
});

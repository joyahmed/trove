import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from './actions.svelte';
import { selection } from './selection.svelte';
import { tabs } from './tabs.svelte';
import { terminal } from './terminal.svelte';
import { pathLocation } from '$lib/utils/location';

const pty = vi.hoisted(() => ({
  ptySpawn: vi.fn(async () => 7),
  ptyWrite: vi.fn(async () => {}),
  ptyResize: vi.fn(async () => {}),
  ptyKill: vi.fn(async () => {}),
  ptyFollow: vi.fn(async () => 'typed'),
  onPtyExit: vi.fn(async () => () => {}),
  onPtyCwd: vi.fn(async () => () => {}),
}));
vi.mock('$lib/api/pty', () => pty);
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

describe('actions.pastePathsIntoTerminal', () => {
  beforeEach(() => {
    pty.ptyWrite.mockClear();
    terminal.open = false;
    terminal.sessionId = null;
    terminal.exited = false;
    terminal.plain = false;
    terminal.error = null;
  });

  it('with a live pane, types the quoted paths with no Enter', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    terminal.open = true;
    terminal.path = 'C:\\scratch';
    terminal.sessionId = 7;
    select('C:\\scratch\\my file.txt', "C:\\scratch\\it's $x.txt");
    await actions.pastePathsIntoTerminal();
    expect(pty.ptyWrite).toHaveBeenCalledTimes(1);
    expect(pty.ptyWrite).toHaveBeenCalledWith(
      7,
      "'C:\\scratch\\my file.txt' 'C:\\scratch\\it''s $x.txt'",
    );
  });

  it('opens a closed pane first, then types once its shell is up', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    select('C:\\scratch\\a b');
    const done = actions.pastePathsIntoTerminal();
    expect(terminal.open).toBe(true);
    terminal.sessionId = 7; // the mounted pane's spawn came back
    await done;
    expect(pty.ptyWrite).toHaveBeenCalledWith(7, "'C:\\scratch\\a b'");
  });

  it('sends nothing, and leaves the pane closed, when nothing is selected', async () => {
    selection.clear();
    await actions.pastePathsIntoTerminal();
    expect(pty.ptyWrite).not.toHaveBeenCalled();
    expect(terminal.open).toBe(false);
  });

  it('never types into a plain (uninstall) shell', async () => {
    tabs.active.location = pathLocation('C:\\scratch');
    terminal.open = true;
    terminal.sessionId = 7;
    terminal.plain = true;
    select('C:\\scratch\\a');
    await actions.pastePathsIntoTerminal();
    expect(pty.ptyWrite).not.toHaveBeenCalled();
  });
});

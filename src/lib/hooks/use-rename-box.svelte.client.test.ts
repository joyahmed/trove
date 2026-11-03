// The rename box on Svelte's CLIENT runtime, where its unmount teardown really runs.
//
// The bug this guards: Escape (or Ctrl K) cancelled the rename, the box unmounted, and its
// teardown — which Svelte 5 hands the state values from BEFORE the change that destroyed it —
// still saw the rename open and committed the half-typed name to disk. On the server runtime
// the default test side uses, a teardown never runs, so the same test there passes either way.
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  renameEntry: vi.fn(async (_from: string, name: string) => `C:\\scratch\\${name}`),
  trashEntries: vi.fn(async () => {}),
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
  clipboardReadPaths: vi.fn(async () => null),
}));
vi.mock('$lib/api/window', () => ({ close: vi.fn(), openWindow: vi.fn() }));
vi.mock('$lib/api/pty', () => ({}));
vi.mock('$lib/api/log', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  attachLogConsole: vi.fn(),
}));

const { renameEntry } = await import('$lib/api/fs');
const { actions } = await import('$lib/state/actions.svelte');
const { findAnything } = await import('./use-palette.svelte');
const { listing } = await import('$lib/state/listing.svelte');
const { selection } = await import('$lib/state/selection.svelte');
const { tabs } = await import('$lib/state/tabs.svelte');
const { pathLocation } = await import('$lib/utils/location');
const { useRenameBox } = await import('./use-rename-box.svelte');

const OLD = 'C:\\scratch\\a.txt';

type Box = ReturnType<typeof useRenameBox>;

/**
 * Mount the box the way the rows do — `{#if actions.renaming === entry.path}<RenameBox />` —
 * so closing the rename destroys it, and a re-run of the block runs its teardown.
 */
const mountRow = () => {
  let box: Box | null = null;
  const unmount = $effect.root(() => {
    $effect(() => {
      if (actions.renaming !== OLD) {
        box = null;
        return;
      }
      box = useRenameBox();
    });
  });
  flushSync();
  return {
    get box() {
      if (!box) throw new Error('the rename box is not mounted');
      return box;
    },
    get mounted() {
      return box !== null;
    },
    unmount,
  };
};

const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    stopPropagation: () => {},
    preventDefault: () => {},
    ...mods,
  }) as unknown as KeyboardEvent;

/** let the awaited rename (and the reload after it) settle */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  flushSync();
};

describe('the rename box, closed by its own keys', () => {
  let row: ReturnType<typeof mountRow>;

  beforeEach(() => {
    vi.mocked(renameEntry).mockClear();
    tabs.active.location = pathLocation('C:\\scratch');
    tabs.active.entries = [
      {
        name: 'a.txt',
        path: OLD,
        isDir: false,
        size: 1,
        modifiedMs: null,
        createdMs: null,
        ext: 'txt',
        isHidden: false,
        iconKey: 'ext/txt',
        typeName: 'File',
      },
    ];
    selection.clear();
    vi.spyOn(tabs.active, 'reload').mockResolvedValue();
    expect(listing.rows.map((e) => e.path)).toEqual([OLD]);
    actions.startRename(OLD);
    row = mountRow();
    row.box.draft = 'half-typ';
  });

  afterEach(() => {
    row.unmount();
    actions.cancelRename();
    if (findAnything.open) findAnything.toggle();
  });

  it('Escape keeps the old name: the box unmounts and nothing is renamed', async () => {
    const box = row.box;
    box.onkeydown(key('Escape'));
    flushSync();
    expect(row.mounted).toBe(false);
    // an input that loses focus by being removed can still fire blur, and blur commits
    box.onblur();
    await settle();
    expect(renameEntry).not.toHaveBeenCalled();
    expect(actions.renaming).toBeNull();
  });

  it('Escape and Enter hand the keyboard back to the file list, not <body>', async () => {
    const body = {};
    const grid = { focus: vi.fn() };
    const fake = { activeElement: body, body, querySelector: () => grid };
    vi.stubGlobal('document', fake);
    try {
      row.box.onkeydown(key('Escape'));
      await settle();
      expect(grid.focus).toHaveBeenCalledTimes(1);
      actions.startRename(OLD);
      row = mountRow();
      row.box.onkeydown(key('Enter'));
      await settle();
      expect(grid.focus).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a click elsewhere that already took focus is not overridden', async () => {
    const body = {};
    const grid = { focus: vi.fn() };
    vi.stubGlobal('document', { activeElement: {}, body, querySelector: () => grid });
    try {
      row.box.onblur();
      await settle();
      expect(grid.focus).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Ctrl K keeps the old name and opens Find anything', async () => {
    const box = row.box;
    box.onkeydown(key('k', { ctrlKey: true }));
    flushSync();
    expect(row.mounted).toBe(false);
    // the palette taking the keyboard blurs the field after the key has closed the rename
    box.onblur();
    await settle();
    expect(renameEntry).not.toHaveBeenCalled();
    expect(findAnything.open).toBe(true);
  });

  it('Enter renames, once', async () => {
    const box = row.box;
    box.onkeydown(key('Enter'));
    flushSync();
    box.onblur();
    await settle();
    expect(renameEntry).toHaveBeenCalledTimes(1);
    expect(renameEntry).toHaveBeenCalledWith(OLD, 'half-typ');
  });

  it('losing focus (a click elsewhere) renames, as Explorer does', async () => {
    row.box.onblur();
    await settle();
    expect(renameEntry).toHaveBeenCalledTimes(1);
    expect(renameEntry).toHaveBeenCalledWith(OLD, 'half-typ');
  });

  it('a box unmounted while still open (its row scrolled away) commits the typed name', async () => {
    row.unmount();
    await settle();
    expect(renameEntry).toHaveBeenCalledTimes(1);
    expect(renameEntry).toHaveBeenCalledWith(OLD, 'half-typ');
  });
});

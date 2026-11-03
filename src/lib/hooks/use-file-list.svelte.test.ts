import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  trashEntries: vi.fn(async () => {}),
  deleteEntries: vi.fn(async () => {}),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
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
vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => null),
  writeSettings: vi.fn(async () => {}),
}));

const { actions } = await import('$lib/state/actions.svelte');
const { confirm } = await import('$lib/state/confirm.svelte');
const { customize } = await import('$lib/state/customize.svelte');
const { settingsDialog } = await import('$lib/state/settings-dialog.svelte');
const { transfers } = await import('$lib/state/transfers.svelte');
const { selection } = await import('$lib/state/selection.svelte');
const { tabs } = await import('$lib/state/tabs.svelte');
const { modalOpen } = await import('$lib/state/modal.svelte');
const { pathLocation } = await import('$lib/utils/location');
const { useFileList } = await import('./use-file-list.svelte');
const { comingFrom } = await import('$lib/state/coming-from.svelte');
const fs = await import('$lib/api/fs');

const A = 'C:\\scratch\\a.txt';
const B = 'C:\\scratch\\b.txt';
const entry = (path: string) => ({
  name: path.slice(path.lastIndexOf('\\') + 1),
  path,
  isDir: false,
  size: 1,
  modifiedMs: null,
  createdMs: null,
  ext: 'txt',
  isHidden: false,
  iconKey: 'ext/txt',
  typeName: 'File',
});

const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => {
  const e = {
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  return e as unknown as KeyboardEvent & { defaultPrevented: boolean };
};

/**
 * Press `k` on the file list. Tests run on Svelte's server build, where `$effect` is inert —
 * which is fine: only the key handler is under test.
 */
const press = (k: string, mods?: Partial<KeyboardEventInit>) => {
  const ev = key(k, mods);
  useFileList().onkeydown(ev);
  return ev;
};

describe('the file list while a dialog is open', () => {
  beforeEach(() => {
    tabs.active.location = pathLocation('C:\\scratch');
    tabs.active.entries = [entry(A), entry(B)];
    selection.clear();
    selection.click(A, { ctrl: false, shift: false }, [A, B]);
    vi.spyOn(actions, 'open').mockResolvedValue(undefined as never);
    vi.spyOn(actions, 'deleteSelected').mockResolvedValue(undefined as never);
    vi.spyOn(actions, 'deletePermanently').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    confirm.answer(false);
    transfers.pending = null;
    customize.open = false;
    settingsDialog.open = false;
    vi.restoreAllMocks();
  });

  it('without a dialog, Enter opens the focused file and Delete deletes', () => {
    expect(press('Enter').defaultPrevented).toBe(true);
    expect(actions.open).toHaveBeenCalledTimes(1);
    press('Delete');
    expect(actions.deleteSelected).toHaveBeenCalledTimes(1);
  });

  it('Enter on "Delete permanently?" answers the dialog only — the focused file does not open', () => {
    void confirm.ask({ title: 'Delete?', message: '', okLabel: 'Delete', danger: true });
    const ev = press('Enter');
    expect(actions.open).not.toHaveBeenCalled();
    // left for the dialog's own window listener, which answers it
    expect(ev.defaultPrevented).toBe(false);
  });

  it('Delete, Shift+Delete, letters, arrows and Escape do nothing behind a dialog', () => {
    void confirm.ask({ title: 'Delete?', message: '', okLabel: 'Delete', danger: true });
    press('Delete');
    press('Delete', { shiftKey: true });
    expect(actions.deleteSelected).not.toHaveBeenCalled();
    expect(actions.deletePermanently).not.toHaveBeenCalled();
    press('b');
    press('ArrowDown');
    expect(selection.focused).toBe(A);
    press('Escape');
    expect(selection.has(A)).toBe(true);
  });

  it('F5 behind a dialog is still prevented, so the WebView does not reload the app', () => {
    const refresh = vi.spyOn(tabs.active, 'refresh').mockResolvedValue(undefined as never);
    void confirm.ask({ title: 'Delete?', message: '', okLabel: 'Delete', danger: true });
    const ev = press('F5');
    expect(ev.defaultPrevented).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    // Ctrl+A would select the page's text; Escape is the dialog's and is left alone
    expect(press('a', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press('Escape').defaultPrevented).toBe(false);
  });

  it('every modal dialog counts: Replace or Skip, Customize, Settings', () => {
    transfers.pending = {
      sources: [A],
      destination: 'C:\\other',
      mode: 'copy',
      conflicts: [],
      fromCut: false,
    } as never;
    press('Enter');
    press('Delete');
    transfers.pending = null;
    customize.open = true;
    press('Enter');
    customize.open = false;
    settingsDialog.open = true;
    press('Delete');
    expect(actions.open).not.toHaveBeenCalled();
    expect(actions.deleteSelected).not.toHaveBeenCalled();
  });

  it('the Escape that closes Settings keeps the selection (Linux 2026-10-07, row 5a)', () => {
    // One Escape, in DOM order: the grid's handler (an element, bubble phase) hears it before
    // Settings' <svelte:window> listener closes the dialog — so the list sees Settings still
    // open and leaves the key alone.
    settingsDialog.show();
    const ev = press('Escape');
    settingsDialog.close(); // what use-settings-dialog's window listener does next
    expect(selection.has(A)).toBe(true);
    expect(ev.defaultPrevented).toBe(false);
    // Delete then reaches the list and acts on that selection
    press('Delete');
    expect(actions.deleteSelected).toHaveBeenCalledTimes(1);
    // a SECOND Escape, with Settings gone, is the list's own: it clears, as it always has
    press('Escape');
    expect(selection.count).toBe(0);
  });
});

describe('modalOpen', () => {
  it('is false with nothing open, true for each dialog', () => {
    expect(modalOpen()).toBe(false);
    settingsDialog.open = true;
    expect(modalOpen()).toBe(true);
    settingsDialog.open = false;
    customize.open = true;
    expect(modalOpen()).toBe(true);
    customize.open = false;
    void confirm.ask({ title: '', message: '', okLabel: 'OK', danger: false });
    expect(modalOpen()).toBe(true);
    confirm.answer(false);
    expect(modalOpen()).toBe(false);
  });
});

const onOs = (os: string) =>
  vi.stubGlobal('window', {
    __TROVE_PLATFORM__: { os, thisPcLabel: 'This PC' },
    addEventListener() {},
    removeEventListener() {},
  });

describe('Finder keys on a Mac (Mac)', () => {
  const C = 'C:\\scratch\\c.txt';
  beforeEach(() => {
    onOs('macos');
    tabs.active.location = pathLocation('C:\\scratch');
    tabs.active.entries = [entry(A), entry(B), entry(C)];
    selection.clear();
    selection.click(B, { ctrl: false, shift: false }, [A, B, C]);
    vi.spyOn(actions, 'open').mockResolvedValue(undefined as never);
    vi.spyOn(actions, 'deleteSelected').mockResolvedValue(undefined as never);
    vi.spyOn(actions, 'deletePermanently').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('⌘O and ⌘↓ open the focused item — ⌘↓ does not move the focus; Return renames (G.59)', () => {
    const rename = vi.spyOn(actions, 'startRename').mockImplementation(() => {});
    expect(press('o', { metaKey: true }).defaultPrevented).toBe(true);
    expect(press('ArrowDown', { metaKey: true }).defaultPrevented).toBe(true);
    press('Enter');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(actions.open).toHaveBeenCalledTimes(2);
    expect(vi.mocked(actions.open).mock.calls.every(([e]) => e.path === B)).toBe(true);
    expect(selection.focused).toBe(B);
  });

  it('⌥⌘⌫ deletes permanently (which asks first), and does NOT also move to the Trash', () => {
    press('Backspace', { metaKey: true, altKey: true });
    expect(actions.deletePermanently).toHaveBeenCalledTimes(1);
    expect(actions.deleteSelected).not.toHaveBeenCalled();
    press('Backspace', { metaKey: true });
    expect(actions.deleteSelected).toHaveBeenCalledTimes(1);
    expect(actions.deletePermanently).toHaveBeenCalledTimes(1);
  });

  it('⌃ or ⇧ added to ⌘⌫ is neither chord', () => {
    press('Backspace', { metaKey: true, shiftKey: true });
    press('Backspace', { metaKey: true, ctrlKey: true });
    press('Backspace', { metaKey: true, altKey: true, shiftKey: true });
    expect(actions.deleteSelected).not.toHaveBeenCalled();
    expect(actions.deletePermanently).not.toHaveBeenCalled();
  });

  it('Shift+Delete still deletes permanently on a Mac keyboard with a ⌦ key', () => {
    press('Delete', { shiftKey: true });
    expect(actions.deletePermanently).toHaveBeenCalledTimes(1);
  });

  it('off a Mac, Ctrl+O and Ctrl+Down do not open', () => {
    onOs('windows');
    press('o', { ctrlKey: true });
    press('ArrowDown', { ctrlKey: true });
    expect(actions.open).not.toHaveBeenCalled();
  });
});

describe('Finder keys on a PC coming from Mac (plan 19, 2.3.1)', () => {
  const C = 'C:\\scratch\\c.txt';
  /** AltGr on a German / Polish layout: ctrl+alt, and the event says AltGraph */
  const altGr = { ctrlKey: true, altKey: true, getModifierState: (k: string) => k === 'AltGraph' };
  beforeEach(() => {
    onOs('windows');
    comingFrom.choice = 'mac';
    tabs.active.location = pathLocation('C:\\scratch');
    tabs.active.entries = [entry(A), entry(B), entry(C)];
    selection.clear();
    selection.click(B, { ctrl: false, shift: false }, [A, B, C]);
    vi.spyOn(actions, 'open').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    confirm.answer(false);
    comingFrom.choice = 'native';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.mocked(fs.trashEntries).mockClear();
    vi.mocked(fs.deleteEntries).mockClear();
  });

  const spyDeletes = () => {
    vi.spyOn(actions, 'deleteSelected').mockResolvedValue(undefined as never);
    vi.spyOn(actions, 'deletePermanently').mockResolvedValue(undefined as never);
  };

  it('Ctrl+Backspace moves to the bin (deleteSelected); Ctrl+Alt+Backspace is deletePermanently', () => {
    spyDeletes();
    press('Backspace', { ctrlKey: true });
    expect(actions.deleteSelected).toHaveBeenCalledTimes(1);
    expect(actions.deletePermanently).not.toHaveBeenCalled();
    press('Backspace', { ctrlKey: true, altKey: true });
    expect(actions.deletePermanently).toHaveBeenCalledTimes(1);
    expect(actions.deleteSelected).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Alt+Backspace asks first: cancelled, nothing is deleted or binned', async () => {
    press('Backspace', { ctrlKey: true, altKey: true });
    await Promise.resolve();
    expect(confirm.pending?.danger).toBe(true);
    expect(confirm.pending?.message).toMatch(/permanently delete/);
    confirm.answer(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(fs.deleteEntries).not.toHaveBeenCalled();
    expect(fs.trashEntries).not.toHaveBeenCalled();
  });

  it('Windows style: Ctrl+Backspace and Ctrl+Alt+Backspace do neither', () => {
    spyDeletes();
    comingFrom.choice = 'native'; // the host, Windows
    press('Backspace', { ctrlKey: true });
    press('Backspace', { ctrlKey: true, altKey: true });
    expect(actions.deleteSelected).not.toHaveBeenCalled();
    expect(actions.deletePermanently).not.toHaveBeenCalled();
  });

  it('AltGr+Backspace on a PC is neither, under Mac style', () => {
    spyDeletes();
    press('Backspace', altGr);
    expect(actions.deleteSelected).not.toHaveBeenCalled();
    expect(actions.deletePermanently).not.toHaveBeenCalled();
  });

  it('with the rename box open, neither chord deletes', () => {
    spyDeletes();
    actions.renaming = B;
    press('Backspace', { ctrlKey: true });
    press('Backspace', { ctrlKey: true, altKey: true });
    actions.renaming = null;
    expect(actions.deleteSelected).not.toHaveBeenCalled();
    expect(actions.deletePermanently).not.toHaveBeenCalled();
  });

  it('a Linux host never answers Ctrl+Alt+Backspace (X11 Zap); Ctrl+Backspace still bins', () => {
    spyDeletes();
    onOs('linux');
    press('Backspace', { ctrlKey: true, altKey: true });
    expect(actions.deletePermanently).not.toHaveBeenCalled();
    press('Backspace', { ctrlKey: true });
    expect(actions.deleteSelected).toHaveBeenCalledTimes(1);
  });

  it('Delete and Shift+Delete are unchanged', () => {
    spyDeletes();
    press('Delete');
    press('Delete', { shiftKey: true });
    expect(actions.deleteSelected).toHaveBeenCalledTimes(1);
    expect(actions.deletePermanently).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+O and Ctrl+↓ open (Explorer’s focus-only Ctrl+↓ is gone under Mac style)', () => {
    expect(press('o', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press('ArrowDown', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(actions.open).toHaveBeenCalledTimes(2);
    expect(selection.focused).toBe(B);
  });

  it('a Mac keeps ⌘⌫ and ⌘O under Windows style', () => {
    spyDeletes();
    onOs('macos');
    comingFrom.choice = 'windows';
    press('Backspace', { metaKey: true });
    expect(actions.deleteSelected).toHaveBeenCalledTimes(1);
    press('o', { metaKey: true });
    expect(actions.open).toHaveBeenCalledTimes(1);
  });
});

describe('the first arrow after a paste or a delete (Mac: "sometimes ignored")', () => {
  const C = 'C:\\scratch\\c.txt';
  const D = 'C:\\scratch\\d.txt';
  beforeEach(() => {
    tabs.active.location = pathLocation('C:\\scratch');
    tabs.active.entries = [entry(A), entry(B), entry(C), entry(D)];
    selection.clear();
    vi.spyOn(actions, 'deleteSelected').mockResolvedValue(undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('after a paste (selected, nothing focused) ↓ steps on from the pasted item, not to the top', () => {
    // what transfers does when a paste lands: select the new items, focus none
    selection.selectAll([C]);
    expect(selection.focused).toBeNull();
    press('ArrowDown');
    expect(selection.focused).toBe(D);
    selection.clear();
    selection.selectAll([C]);
    press('ArrowUp');
    expect(selection.focused).toBe(B);
  });

  it('after a delete ↓ lands on the row that took its place, ↑ on the one before', () => {
    selection.click(B, { ctrl: false, shift: false }, [A, B, C, D]);
    press('Delete');
    // what deleteSelected does: clear, then reload without B
    selection.clear();
    tabs.active.entries = [entry(A), entry(C), entry(D)];
    press('ArrowDown');
    expect(selection.focused).toBe(C);
    expect(selection.has(C)).toBe(true);

    selection.click(C, { ctrl: false, shift: false }, [A, C, D]);
    press('Delete');
    selection.clear();
    tabs.active.entries = [entry(A), entry(D)];
    press('ArrowUp');
    expect(selection.focused).toBe(A);
  });

  it('deleting the last row: ↓ and ↑ land on the new last row', () => {
    selection.click(D, { ctrl: false, shift: false }, [A, B, C, D]);
    press('Delete');
    selection.clear();
    tabs.active.entries = [entry(A), entry(B), entry(C)];
    press('ArrowDown');
    expect(selection.focused).toBe(C);
    selection.click(D, { ctrl: false, shift: false }, [A, B, C, D]);
    tabs.active.entries = [entry(A), entry(B), entry(C), entry(D)];
    press('Delete');
    selection.clear();
    tabs.active.entries = [entry(A), entry(B), entry(C)];
    press('ArrowUp');
    expect(selection.focused).toBe(C);
  });

  it('in another folder the remembered place is not used: the first arrow starts at the top', () => {
    selection.click(C, { ctrl: false, shift: false }, [A, B, C, D]);
    press('Delete');
    selection.clear();
    tabs.active.location = pathLocation('C:\\other');
    tabs.active.entries = [entry(A), entry(B), entry(C), entry(D)];
    press('ArrowDown');
    expect(selection.focused).toBe(A);
  });
});

// G.59: Finder's Return renames the selected item, under Mac style only.
describe('Return per "coming from" style (G.59)', () => {
  beforeEach(() => {
    tabs.active.location = pathLocation('C:\\scratch');
    tabs.active.entries = [entry(A), entry(B)];
    selection.clear();
    selection.click(A, { ctrl: false, shift: false }, [A, B]);
    vi.spyOn(actions, 'open').mockResolvedValue(undefined as never);
    vi.spyOn(actions, 'startRename').mockImplementation(() => {});
  });

  afterEach(() => {
    comingFrom.choice = 'native';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Mac style: Return renames the selected item and opens nothing', () => {
    comingFrom.choice = 'mac';
    expect(press('Enter').defaultPrevented).toBe(true);
    expect(actions.startRename).toHaveBeenCalledTimes(1);
    expect(actions.open).not.toHaveBeenCalled();
  });

  it('Mac style: ⌘O (Ctrl+O on a PC) still opens; F2 still renames', () => {
    comingFrom.choice = 'mac';
    press('o', { ctrlKey: true });
    expect(actions.open).toHaveBeenCalledTimes(1);
    press('F2');
    expect(actions.startRename).toHaveBeenCalledTimes(1);
  });

  it('Mac style: Return with nothing selected does nothing', () => {
    comingFrom.choice = 'mac';
    selection.clear();
    press('Enter');
    expect(actions.startRename).not.toHaveBeenCalled();
    expect(actions.open).not.toHaveBeenCalled();
  });

  it('Windows and Linux style: Return opens, never renames — on a Mac host too', () => {
    for (const style of ['windows', 'linux'] as const) {
      comingFrom.choice = style;
      press('Enter');
    }
    onOs('macos');
    comingFrom.choice = 'windows';
    press('Enter');
    expect(actions.open).toHaveBeenCalledTimes(3);
    expect(actions.startRename).not.toHaveBeenCalled();
  });

  it('native on a Mac host is Mac style: Return renames', () => {
    onOs('macos');
    press('Enter');
    expect(actions.startRename).toHaveBeenCalledTimes(1);
    expect(actions.open).not.toHaveBeenCalled();
  });
});

// Joy 2026-10-23: ⌘Space is Spotlight, so on a Mac the toggle key is Ctrl+Space (plan 15 B.3.8).
describe('Space toggles the focused item (Mac: Ctrl+Space)', () => {
  beforeEach(() => {
    tabs.active.location = pathLocation('C:\\scratch');
    tabs.active.entries = [entry(A), entry(B)];
    selection.clear();
    selection.click(A, { ctrl: false, shift: false }, [A, B]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('on a Mac, Ctrl+Space unpicks and re-picks the focused row', () => {
    onOs('macos');
    expect(press(' ', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(selection.has(A)).toBe(false);
    press(' ', { ctrlKey: true });
    expect(selection.has(A)).toBe(true);
  });

  it('on a Mac, ⌘Space still toggles', () => {
    onOs('macos');
    press(' ', { metaKey: true });
    expect(selection.has(A)).toBe(false);
  });

  it('on Windows, Ctrl+Space toggles; ⌘/Win+Space does not', () => {
    onOs('windows');
    press(' ', { ctrlKey: true });
    expect(selection.has(A)).toBe(false);
    press(' ', { ctrlKey: true });
    press(' ', { metaKey: true });
    expect(selection.has(A)).toBe(true);
  });

  it('plain Space changes nothing when something is already selected', () => {
    for (const os of ['macos', 'windows'] as const) {
      onOs(os);
      press(' ');
      expect(selection.has(A)).toBe(true);
    }
  });
});

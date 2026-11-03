import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/window', () => ({ close: vi.fn(), openWindow: vi.fn() }));
vi.mock('$lib/api/fs', () => ({}));
vi.mock('$lib/api/transfer', () => ({}));
vi.mock('$lib/api/clipboard', () => ({}));
vi.mock('$lib/api/recycle', () => ({
  recycleList: vi.fn(async () => []),
  openInExplorer: vi.fn(async () => {}),
}));
vi.mock('$lib/api/pty', () => ({}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));

const { useStatusBar } = await import('./use-status-bar.svelte');
const { tabs } = await import('$lib/state/tabs.svelte');
const { recycle } = await import('$lib/state/recycle.svelte');
const { settings } = await import('$lib/state/settings.svelte');
const { pathLocation, THIS_PC, RECYCLE_BIN } = await import('$lib/utils/location');

describe('useStatusBar view buttons (plan 15 G.54)', () => {
  it('offers Details and Large icons, pressed to match the folder view', () => {
    settings.folderViews = [];
    settings.view = 'details';
    tabs.active.location = pathLocation('E:\\A');
    const bar = useStatusBar();
    expect(bar.showsViewButtons).toBe(true);
    expect(bar.viewButtons.map((b) => [b.key, b.pressed])).toEqual([
      ['details', true],
      ['grid', false],
    ]);
    settings.folderViews = [];
  });

  it('a press switches this folder only, and the pressed state follows', () => {
    settings.folderViews = [];
    settings.view = 'details';
    const bar = useStatusBar();
    tabs.active.location = pathLocation('E:\\A');
    bar.setView('grid');
    expect(bar.viewButtons.map((b) => b.pressed)).toEqual([false, true]);
    tabs.active.location = pathLocation('E:\\B');
    expect(bar.viewButtons.map((b) => b.pressed)).toEqual([true, false]);
    expect(settings.view).toBe('details');
    settings.folderViews = [];
  });

  it('hides the buttons on a place, where there is no file list', () => {
    tabs.active.location = THIS_PC;
    expect(useStatusBar().showsViewButtons).toBe(false);
  });
});

describe('useStatusBar selection line in the Bin', () => {
  it('counts the Bin selection like a folder does', () => {
    tabs.active.location = RECYCLE_BIN;
    recycle.items = ['a', 'b', 'c'].map((id) => ({
      id,
      name: id,
      originalParent: 'D:\\x',
      deletedMs: 1,
      isDir: false,
      size: null,
    }));
    recycle.selected.clear();
    const bar = useStatusBar();
    expect(bar.selectionLine).toBeNull();
    recycle.select('a');
    recycle.select('b', { ctrl: true });
    expect(bar.selectionLine).toBe('2 of 3 selected');
    recycle.selected.clear();
    recycle.items = [];
  });
});

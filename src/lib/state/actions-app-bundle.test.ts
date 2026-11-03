// A Mac's `X.app`: double-click, middle-click and Shift+Enter all LAUNCH it (Finder does);
// none of them walks into the bundle or opens it in a tab or window. Windows is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from './actions.svelte';
import { tabs } from './tabs.svelte';
import type { FileEntry } from '$lib/types/fs';

const api = vi.hoisted(() => ({
  openPath: vi.fn(async () => {}),
  openWindow: vi.fn(async () => {}),
}));
vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({ path, entries: [] })),
  openPath: api.openPath,
}));
vi.mock('$lib/api/window', () => ({ openWindow: api.openWindow }));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));

const app: FileEntry = {
  name: 'Safari.app',
  path: '/Applications/Safari.app',
  isDir: true,
  size: 0,
  modifiedMs: null,
  createdMs: null,
  ext: null,
  isHidden: false,
  iconKey: 'folder',
  typeName: 'Application',
};

const onOs = (os: string) =>
  vi.stubGlobal('window', { __TROVE_PLATFORM__: { os, thisPcLabel: 'This Mac' } });

describe('actions on an app bundle', () => {
  beforeEach(() => {
    api.openPath.mockClear();
    api.openWindow.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('on a Mac, open / new tab / new window all launch it', async () => {
    onOs('macos');
    const tabCount = tabs.list.length;
    const navigate = vi.spyOn(tabs.active, 'navigate');
    await actions.open(app);
    actions.openInNewTab(app);
    actions.openInNewWindow(app);
    await Promise.resolve();
    expect(api.openPath).toHaveBeenCalledTimes(3);
    expect(api.openPath).toHaveBeenCalledWith(app.path);
    expect(api.openWindow).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(tabs.list.length).toBe(tabCount);
    navigate.mockRestore();
  });

  it('on Windows a folder named x.app is a folder: new window opens it', () => {
    onOs('windows');
    actions.openInNewWindow(app);
    expect(api.openWindow).toHaveBeenCalledWith(app.path);
    expect(api.openPath).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';

// The Tauri side only: the functions under test are this module's own.
const invoke = vi.hoisted(() => vi.fn(async () => 'main-3'));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { openWindowWithTabs, windowOpenTabs } from './window';

describe('a restored window: its tabs through the new-window path', () => {
  it('reads every tab and the active one from the URL Rust builds', () => {
    // the exact string `window_url_tabs` is tested to produce (commands/windows.rs)
    expect(windowOpenTabs('?open=C%3A%5Ca&open=D%3A%5Cb&active=1')).toEqual({
      tabs: ['C:\\a', 'D:\\b'],
      active: 1,
    });
  });

  it('a one-folder window (Ctrl+N, a detached tab) reads as before: one tab, the first active', () => {
    expect(windowOpenTabs('?open=This%20PC')).toEqual({ tabs: ['This PC'], active: 0 });
    expect(windowOpenTabs('')).toEqual({ tabs: [], active: 0 });
    expect(windowOpenTabs('?open=x&active=junk')).toEqual({ tabs: ['x'], active: 0 });
  });

  it('opens through `open_window`, cascaded from the window before it', async () => {
    await expect(openWindowWithTabs(['C:\\a', 'D:\\b'], 1, 'main-2')).resolves.toBe('main-3');
    expect(invoke).toHaveBeenCalledWith('open_window', {
      path: 'C:\\a',
      from: 'main-2',
      tabs: ['C:\\a', 'D:\\b'],
      active: 1,
    });
    // no `from`: the calling window, as `openWindow` does
    await openWindowWithTabs([], 0);
    expect(invoke).toHaveBeenLastCalledWith('open_window', {
      path: null,
      from: 'main',
      tabs: [],
      active: 0,
    });
  });
});

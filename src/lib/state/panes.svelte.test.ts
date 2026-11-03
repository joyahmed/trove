import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { panes } from './panes.svelte';
import { settings } from './settings.svelte';
import { notices } from './notices.svelte';

// the unit tests run in node: `window` is only what a test stubs in
const setWidth = (px: number) => vi.stubGlobal('window', { innerWidth: px });

describe('panes.toggle(preview)', () => {
  beforeEach(() => {
    panes.close();
    notices.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('closes an open preview when the window is wide enough to show it', () => {
    setWidth(2000);
    panes.open = 'preview';
    panes.toggle('preview');
    expect(panes.open).toBeNull();
    expect(settings.previewOpen).toBe(false);
    expect(notices.list).toHaveLength(0);
  });

  it('opens the preview from closed even on a narrow window', () => {
    setWidth(800);
    panes.toggle('preview');
    expect(panes.open).toBe('preview');
  });

  it('keeps an open-but-hidden preview open and says why', () => {
    setWidth(800);
    panes.open = 'preview';
    panes.toggle('preview');
    expect(panes.open).toBe('preview');
    expect(settings.previewOpen).toBe(true);
    expect(notices.list.at(-1)).toMatchObject({
      kind: 'info',
      message: 'Widen the window to see the preview',
    });
  });

  it('keeps Details open and says why on the FIRST press when the preview cannot fit', () => {
    setWidth(800);
    panes.open = 'details';
    panes.toggle('preview');
    expect(panes.open).toBe('details');
    expect(settings.previewOpen).toBe(false);
    expect(notices.list).toHaveLength(1);
    expect(notices.list.at(-1)).toMatchObject({
      kind: 'info',
      message: 'Widen the window to see the preview',
    });
  });

  it('repeated presses show the widen notice once', () => {
    setWidth(800);
    panes.open = 'details';
    panes.toggle('preview');
    panes.toggle('preview');
    panes.toggle('preview');
    expect(notices.list.filter((n) => n.message.startsWith('Widen'))).toHaveLength(1);
  });

  it('swaps Details for the preview when the window is wide enough', () => {
    setWidth(2000);
    panes.open = 'details';
    panes.toggle('preview');
    expect(panes.open).toBe('preview');
    expect(notices.list).toHaveLength(0);
  });
});

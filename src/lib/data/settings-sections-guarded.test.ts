import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/default-handler', () => ({
  defaultHandlerStatus: vi.fn(async () => ({ kind: 'not-applied' })),
  defaultHandlerInfo: vi.fn(async () => ({ exePath: '', stable: true })),
  defaultHandlerApply: vi.fn(async () => {}),
  defaultHandlerRevert: vi.fn(async () => {}),
}));
vi.mock('$lib/api/shell-verbs', () => ({
  shellVerbs: vi.fn(async () => []),
  runShellVerb: vi.fn(async () => {}),
  runCustomCommand: vi.fn(async () => {}),
}));
vi.mock('$lib/api/palette', () => ({
  hidePalette: vi.fn(async () => {}),
  registerHotkey: vi.fn(async () => {}),
  onHotkeyFailed: vi.fn(),
  onSpotlightAction: vi.fn(),
  onSpotlightNavigate: vi.fn(),
  onSpotlightOpenFailed: vi.fn(),
  onSpotlightReveal: vi.fn(),
  onSpotlightSearch: vi.fn(),
}));
const unopened = vi.fn<() => Promise<string[]>>(async () => []);
const allow = vi.fn<(paths: string[]) => Promise<string[]>>(async (paths) => paths);
vi.mock('$lib/api/fs', async (orig) => ({
  ...(await orig<typeof import('$lib/api/fs')>()),
  unopenedGuardedFolders: () => unopened(),
  allowGuardedFolders: (paths: string[]) => allow(paths),
}));

import { guardedFolders } from '$lib/state/guarded-folders.svelte';
import { guardedAllowRows } from './settings-sections';

// Mac: Settings ▸ General's "Search inside my personal folders — Allow".
describe('the personal folders Allow row', () => {
  beforeEach(() => {
    unopened.mockReset();
    allow.mockClear();
    guardedFolders.unopened = null;
  });

  it('is not offered off a Mac', () => {
    expect(guardedAllowRows(false)).toEqual([]);
  });

  it('names what is still unopened and allows exactly that', async () => {
    unopened.mockResolvedValue(['/Users/sam/Desktop', '/Users/sam/Documents']);
    const [row] = guardedAllowRows(true);
    if (row.kind !== 'button') throw new Error('expected a button row');
    await vi.waitFor(() => expect(guardedFolders.unopened).not.toBeNull());
    expect(row.disabled?.()).toBe(false);
    expect(row.note?.()).toBe('Still unopened: Desktop, Documents');

    unopened.mockResolvedValue([]);
    await row.run();
    expect(allow).toHaveBeenCalledWith(['/Users/sam/Desktop', '/Users/sam/Documents']);
    expect(row.note?.()).toBe('All allowed');
    expect(row.disabled?.()).toBe(true);
  });
});

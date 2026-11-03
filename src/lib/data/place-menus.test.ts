// The Gallery and Recycle Bin menus name their keys through commandHint, so a Mac reads the
// Mac's key (⌘O, ⌥⌘⌫) and Windows and Linux read what they always did.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import type { FileEntry } from '$lib/types/fs';
import { galleryMenuFor } from './gallery-menu';
import { recycleMenuFor } from './recycle-menu';

const onOs = (os: string) =>
  vi.stubGlobal('window', { __TROVE_PLATFORM__: { os, thisPcLabel: 'This PC' } });

const shortcutOf = (items: MenuItem[], key: string) => {
  const item = items.find((i) => i.key === key);
  return item && item.kind === 'item' ? item.shortcut : undefined;
};

const entry = { path: 'C:\\a.png', name: 'a.png' } as FileEntry;
const noop = () => {};
const gallery = () => galleryMenuFor(entry, { open: noop, reveal: noop });
const bin = (count: number) =>
  recycleMenuFor(count, { restore: noop, purge: noop, openLocation: noop });

describe('Gallery and Recycle Bin menu hints', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Windows and Linux: Enter and Delete, as before', () => {
    for (const os of ['windows', 'linux']) {
      onOs(os);
      expect(shortcutOf(gallery(), 'open')).toBe('Enter');
      expect(shortcutOf(bin(1), 'purge')).toBe('Delete');
    }
  });

  it('a Mac: ⌘O and ⌥⌘⌫, the keys those views bind', () => {
    onOs('macos');
    expect(shortcutOf(gallery(), 'open')).toBe('⌘O');
    expect(shortcutOf(bin(2), 'purge')).toBe('⌥⌘⌫');
  });
});

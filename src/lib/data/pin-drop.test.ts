import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pinDropped } from './pin-drop';
import { places } from '$lib/state/places.svelte';
import { settings } from '$lib/state/settings.svelte';

vi.mock('$lib/api/fs', () => ({
  pathKind: vi.fn(async (p: string) =>
    p.includes('gone') ? 'missing' : /\.\w+$/.test(p) ? 'file' : 'dir',
  ),
}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
}));

describe('pinDropped', () => {
  beforeEach(() => {
    settings.pins = [];
    settings.hiddenKnownFolders = [];
    places.knownFolders = [
      { key: 'downloads', label: 'Downloads', path: 'C:\\Users\\alex\\Downloads' },
    ];
  });

  it('pins a folder once, however often it is dropped, and skips files and missing paths', async () => {
    await pinDropped(['C:\\a', 'C:\\a.txt', 'C:\\gone']);
    await pinDropped(['c:\\A']);
    expect(settings.pins).toEqual(['C:\\a']);
  });

  it('a hidden built-in folder is shown again, a visible one is left alone', async () => {
    const dl = 'C:\\Users\\alex\\Downloads';
    settings.toggleKnownFolder('downloads');
    await pinDropped([dl]);
    expect(settings.isKnownFolderHidden('downloads')).toBe(false);
    await pinDropped([dl]);
    expect(settings.isKnownFolderHidden('downloads')).toBe(false);
    expect(settings.pins).toEqual([]);
  });
});

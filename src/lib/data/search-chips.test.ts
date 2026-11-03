import { beforeEach, describe, expect, it, vi } from 'vitest';
import { labelOf } from './command-actions';
import { searchChipItems } from './search-chips';
import { search } from '$lib/state/search.svelte';

vi.mock('$lib/api/search', () => ({
  startSearch: vi.fn(async () => 1),
  cancelSearch: vi.fn(async () => undefined),
  onSearchResults: vi.fn(async () => () => {}),
}));

const chip = (key: string) => {
  const item = searchChipItems.find((i) => i.key === key);
  if (!item || item.kind === 'divider') throw new Error(key);
  return item;
};

describe('search chip labels', () => {
  beforeEach(() => {
    search.chips.kind = null;
    search.chips.modified = null;
    search.chips.size = null;
  });

  it('show the bare axis name when nothing is picked', () => {
    expect(labelOf(chip('chip-kind'))).toBe('Kind');
    expect(labelOf(chip('chip-modified'))).toBe('Date modified');
    expect(labelOf(chip('chip-size'))).toBe('Size');
  });

  it('show the picked preset after a colon', () => {
    search.chips.kind = 'folder';
    search.chips.modified = 'thisweek';
    search.chips.size = 'large';
    expect(labelOf(chip('chip-kind'))).toBe('Kind: Folders');
    expect(labelOf(chip('chip-modified'))).toBe('Date modified: This week');
    expect(labelOf(chip('chip-size'))).toBe('Size: Large (128 MB – 1 GB)');
  });
});

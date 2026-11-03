// "Properties" is Windows' and Linux's word; Finder calls it "Get Info". Customize's registry
// section exists only on Windows.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rowMenu } from './context-menus';
import { moreMenu } from './menus';
import { customizeIntro, showsWindowsEntries } from '$lib/utils/customize-text';

const onOs = (os: string) =>
  vi.stubGlobal('window', { __TROVE_PLATFORM__: { os, thisPcLabel: 'This PC' } });
const labelOf = (items: typeof rowMenu) => {
  const item = items.find((i) => i.key === 'properties');
  return item && item.kind === 'item' ? item.label : undefined;
};

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ['macos', 'Get Info'],
  ['windows', 'Properties'],
  ['linux', 'Properties'],
])('on %s', (os, word) => {
  it(`the row and More menus say ${word}`, () => {
    onOs(os);
    expect(labelOf(rowMenu)).toBe(word);
    expect(labelOf(moreMenu)).toBe(word);
  });
  it(`Customize ${os === 'windows' ? 'shows' : 'hides'} Windows' registry entries`, () => {
    onOs(os);
    expect(showsWindowsEntries()).toBe(os === 'windows');
  });
});

describe('the Customize intro line', () => {
  it('counts Windows entries on Windows only', () => {
    expect(customizeIntro(3, true)).toContain("Windows' own entries (3)");
    expect(customizeIntro(3, false)).toBe('Your commands are listed here.');
  });
});

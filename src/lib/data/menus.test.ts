import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));
vi.mock('$lib/api/default-handler', () => ({
  defaultHandlerStatus: vi.fn(async () => ({ kind: 'not-applied' })),
  defaultHandlerInfo: vi.fn(async () => ({ exePath: '', stable: true })),
  defaultHandlerApply: vi.fn(async () => {}),
  defaultHandlerRevert: vi.fn(async () => {}),
}));

vi.mock('$lib/api/archive', () => ({
  archiveConflicts: vi.fn(async () => []),
  startExtract: vi.fn(async () => 1),
  startExtractHere: vi.fn(async () => 1),
  startCompress: vi.fn(async () => 1),
}));

import { comingFrom } from '$lib/state/coming-from.svelte';
import { selection } from '$lib/state/selection.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { undo } from '$lib/state/undo.svelte';
import { pathLocation } from '$lib/utils/location';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import { startCompress } from '$lib/api/archive';
import { moreMenu } from './menus';
import { navActions } from './nav-actions';

const FORMATS = [
  ['ZIP file', 'zip'],
  ['7z file', '7z'],
  ['tar.gz file', 'tar.gz'],
  ['tar.xz file', 'tar.xz'],
  ['tar.zst file', 'tar.zst'],
] as const;

/** the "Compress to" flyout of `items`: five rows, each starts the archive job in its format */
const checkCompressFlyout = async (items: MenuItem[]) => {
  const flyout = items.find((i) => i.key === 'compress-to');
  if (flyout?.kind !== 'submenu') throw new Error('no "Compress to" flyout');
  expect(flyout.label).toBe('Compress to');
  expect(flyout.items.map((i) => (i.kind === 'item' ? i.label : ''))).toEqual(
    FORMATS.map(([label]) => label),
  );
  tabs.active.location = pathLocation('C:\\scratch');
  selection.replaceAll(['C:\\scratch\\a.txt']);
  for (const [label, format] of FORMATS) {
    vi.mocked(startCompress).mockClear();
    const row = flyout.items.find((i) => i.kind === 'item' && i.label === label);
    if (row?.kind !== 'item') throw new Error(`no ${label} row`);
    expect(row.enabled?.()).toBe(true);
    await row.run();
    expect(startCompress).toHaveBeenCalledExactlyOnceWith(['C:\\scratch\\a.txt'], format);
  }
  selection.clear();
  for (const row of flyout.items) expect(row.kind === 'item' && row.enabled?.()).toBe(false);
};

describe('the … menu', () => {
  it("keeps Explorer's shape: the app settings live in Settings…, not in the flyout", () => {
    const keys = moreMenu.filter((i) => i.kind === 'item').map((i) => i.key);
    expect(keys).toContain('settings');
    for (const gone of [
      'default-handler',
      'keep-running',
      'start-with-windows',
      'restore-tabs',
      'start-home',
      'start-this-pc',
      'show-default-folders',
      'customize-menu',
    ]) {
      expect(keys).not.toContain(gone);
    }
    // short enough to fit a 769 px window at 36 px a row
    expect(moreMenu.length).toBeLessThanOrEqual(24);
  });

  it('has Compress to and Extract here, and no Extract all… yet (no folder picker)', () => {
    const items = moreMenu.filter((i) => i.kind === 'item');
    const label = (key: string) => items.find((i) => i.key === key)?.label;
    expect(moreMenu.some((i) => i.kind === 'submenu' && i.key === 'compress-to')).toBe(true);
    expect(label('extract-here')).toBe('Extract here');
    // the flyout is already at its 24-row cap: Extract all… lives in the right-click menus only
    expect(items.map((i) => i.key)).not.toContain('extract-all');
  });
});

describe('Compress to', () => {
  it('has zip, tar.gz, tar.xz, tar.zst rows, each running its format', async () => {
    await checkCompressFlyout(moreMenu);
  });
});

describe('one action, one name', () => {
  it("calls the path copy 'Copy as path', as the context menu and Explorer do", () => {
    const item = moreMenu.find((i) => i.kind === 'item' && i.key === 'copy-path');
    expect(item?.kind === 'item' && item.label).toBe('Copy as path');
  });
});

// Plan 19, 2.4: hints are getters, so a style flip redraws them without a restart.
// Nothing injected → a Windows host, so Mac style draws the Finder chord with Ctrl.
describe('hints follow the "Coming from" style live', () => {
  afterEach(() => {
    comingFrom.choice = 'native';
  });

  const shortcutOf = (key: string) => {
    const item = moreMenu.find((i) => i.key === key);
    return item?.kind === 'item' ? item.shortcut : undefined;
  };

  it("the toolbar's Back names Ctrl+[ under Mac style and Alt+← under Windows style", () => {
    comingFrom.choice = 'mac';
    expect(navActions[0].key).toBe('back');
    expect(navActions[0].label).toContain('Ctrl+[');
    comingFrom.choice = 'windows';
    expect(navActions[0].label).not.toContain('Ctrl+[');
    expect(navActions[0].label).toContain('Alt+');
  });

  it("the … menu's Redo hint flips between Ctrl+Y and Ctrl+Shift+Z", () => {
    comingFrom.choice = 'windows';
    expect(shortcutOf('redo')).toBe('Ctrl+Y');
    comingFrom.choice = 'mac';
    expect(shortcutOf('redo')).toBe('Ctrl+Shift+Z');
  });
});

// G.63: the … menu names what Undo / Redo will reverse, live as the stack moves.
describe("the … menu's Undo / Redo rows name the action", () => {
  const labelOf = (key: string) => {
    const item = moreMenu.find((i) => i.key === key);
    return item?.kind === 'item' ? item.label : undefined;
  };

  it('reads "Undo Rename" after a rename and "Redo Rename" once it is undone', async () => {
    const reload = vi.spyOn(tabs.active, 'reload').mockResolvedValue();
    expect(labelOf('undo')).toBe(undo.undoLabel);
    undo.push({ label: 'Rename', undo: async () => {}, redo: async () => {} });
    expect(labelOf('undo')).toBe('Undo Rename');
    await undo.undo();
    expect(labelOf('redo')).toBe('Redo Rename');
    await undo.redo();
    expect(labelOf('undo')).toBe('Undo Rename');
    expect(labelOf('redo')).toBe('Redo');
    reload.mockRestore();
  });
});

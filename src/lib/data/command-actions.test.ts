import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';

vi.mock('$lib/api/window', () => ({ close: vi.fn(), openWindow: vi.fn() }));
vi.mock('$lib/api/fs', () => ({}));
vi.mock('$lib/api/transfer', () => ({}));
vi.mock('$lib/api/clipboard', () => ({}));
vi.mock('$lib/api/pty', () => ({}));
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
vi.mock('$lib/api/shell-verbs', () => ({
  shellVerbs: vi.fn(async () => []),
  runShellVerb: vi.fn(async () => {}),
  runCustomCommand: vi.fn(async () => {}),
}));

const { accessibleName, commandTrailing, filterCommand, labelOf, newCommand } =
  await import('./command-actions');
const { glyphIcons } = await import('./glyph-icons');
const { moreFlyout, moreMenu, newMenu } = await import('./menus');
const { matchShortcut } = await import('./shortcuts');
const { backgroundMenu, rowMenu } = await import('./context-menus');
const { paletteActions } = await import('./palette-actions');
const { navActions, viewChoices } = await import('./nav-actions');

const found = commandTrailing.find((i) => i.key === 'settings');
// thrown at import, not asserted in a test: every case below reads the gear's fields
if (found === undefined || found.kind === 'divider')
  throw new Error('no Settings gear in the toolbar');
const gear = found;

describe('the More menu hints', () => {
  const hint = (key: string) => {
    const row = moreFlyout.kind === 'submenu' ? moreFlyout.items.find((i) => i.key === key) : null;
    if (row?.kind !== 'item') throw new Error(`no "${key}" row`);
    return row.shortcut;
  };

  it('names Alt+Enter once: Properties keeps it, Details pane does not repeat it', () => {
    // the default test style is native on a Windows host, where both chords are Alt+Enter
    expect(hint('properties')).toBe('Alt+Enter');
    expect(hint('details-pane')).toBeUndefined();
  });
});

describe('the Settings gear', () => {
  it('sits at the right end of the toolbar with a mapped glyph', () => {
    expect(gear.kind).toBe('icon');
    // a gear nobody has to learn, unlike a `…` menu
    expect(gear.glyph).toBe('settings');
    expect(glyphIcons[gear.glyph].length).toBeGreaterThan(0);
    expect(commandTrailing.at(-1)).toBe(gear);
  });

  it('names its chord in the tooltip, and that chord really opens Settings', () => {
    expect(labelOf(gear)).toBe('Settings (Ctrl+,)');
    const hit = matchShortcut({ key: ',', ctrlKey: true, altKey: false, shiftKey: false }, false);
    expect(hit).not.toBeNull();
    // and it keeps working while a text field has focus, or the gear's promise is conditional
    expect(hit?.whileTyping).toBe(true);
  });

  it('is a second door, not a replacement: the … menu keeps its Settings entry', () => {
    expect(moreMenu.some((i) => i.kind === 'item' && i.key === 'settings')).toBe(true);
  });
});

/** Every key in a menu, flyouts opened, so "is it reachable" sees nested rows too. */
const keysOf = (items: MenuItem[]): string[] =>
  items.flatMap((i) =>
    i.kind === 'divider' ? [] : i.kind === 'submenu' ? [i.key, ...keysOf(i.items)] : [i.key],
  );
const background = keysOf(backgroundMenu);
const row = keysOf(rowMenu);
const palette = paletteActions.map((a) => a.key);
const shortcutOf = (key: string) => {
  const item = [...rowMenu, ...backgroundMenu].find((i) => i.kind === 'item' && i.key === key);
  return item?.kind === 'item' ? item.shortcut : undefined;
};
const chord = (key: string, mods: { ctrl?: boolean; shift?: boolean } = {}) =>
  matchShortcut(
    { key, ctrlKey: mods.ctrl ?? false, shiftKey: mods.shift ?? false, altKey: false },
    false,
  );

/**
 * ⛔ Plan 12 G.1 (D4) dropped Explorer's command bar. This is the list of what it held and the
 * doors each command has now; a command with none is the regression this block exists to catch.
 * The list-scoped keys (Ctrl+X/C/V, F2, Delete, Ctrl+Shift+N, F5) live in `use-file-list`, not
 * the global table, so they are checked through the menu rows that print them.
 */
describe('every command the dropped command bar had is still reachable', () => {
  it('New: the + New button, New ▸ on empty space, Ctrl+Shift+N, the palette', () => {
    expect(newCommand.kind !== 'divider' && newCommand.menu).toBe(newMenu);
    expect(background).toEqual(expect.arrayContaining(['new', 'folder', 'text', 'markdown']));
    expect(newMenu[0].kind === 'item' && newMenu[0].shortcut).toBe('Ctrl+Shift+N');
    expect(palette).toEqual(expect.arrayContaining(['new-folder', 'new-text-file']));
  });

  it.each([
    ['cut', 'Ctrl+X'],
    ['copy', 'Ctrl+C'],
    ['rename', 'F2'],
  ])('%s: the item right-click menu, %s, the palette', (key, keys) => {
    expect(row).toContain(key);
    expect(shortcutOf(key)).toBe(keys);
    expect(palette).toContain(key);
  });

  it('Paste: both right-click menus, Ctrl+V, the palette', () => {
    expect(row).toContain('paste');
    expect(background).toContain('paste');
    expect(shortcutOf('paste')).toBe('Ctrl+V');
    expect(palette).toContain('paste');
  });

  it('Delete: the item right-click menu and the Delete key, deliberately not the palette', () => {
    expect(row).toEqual(expect.arrayContaining(['delete', 'delete-permanently']));
    expect(shortcutOf('delete')).toBe('Delete');
    expect(palette).not.toContain('delete');
  });

  it('Sort: Sort by ▸ and Group by ▸ on empty space, the palette', () => {
    expect(background).toEqual(expect.arrayContaining(['sort-by', 'group-by', 'asc', 'desc']));
    expect(palette).toEqual(
      expect.arrayContaining(['sort-name', 'sort-modified', 'sort-size', 'sort-type']),
    );
  });

  it('View: the toolbar switch, View ▸ on empty space, Ctrl+Shift+1…8, the palette', () => {
    expect(viewChoices.map((c) => c.key)).toEqual(['grid', 'list', 'details', 'gallery']);
    expect(background).toEqual(
      expect.arrayContaining([
        'view',
        'grid-256',
        'grid-96',
        'grid-48',
        'small-48',
        'list-48',
        'details-48',
        'tiles-48',
        'content-48',
        'hidden',
      ]),
    );
    for (const n of ['1', '2', '3', '4', '5', '6', '7', '8'])
      expect(chord(n, { ctrl: true, shift: true })).not.toBeNull();
    expect(palette).toEqual(
      expect.arrayContaining([
        'view-icons',
        'view-list',
        'view-details',
        'view-small-icons',
        'view-tiles',
        'view-content',
        'toggle-hidden',
      ]),
    );
    // the View dropdown's panes went under More ▸
    expect(background).toEqual(
      expect.arrayContaining(['preview-pane', 'details-pane', 'terminal-pane']),
    );
  });

  it('See more: every row of it, whole, under More ▸ on empty space', () => {
    expect(backgroundMenu.at(-1)).toBe(moreFlyout);
    for (const key of keysOf(moreMenu)) expect(background).toContain(key);
    expect(chord('z', { ctrl: true })).not.toBeNull();
    expect(chord('y', { ctrl: true })).not.toBeNull();
    expect(palette).toEqual(
      expect.arrayContaining(['undo', 'redo', 'select-all', 'invert-selection', 'open-terminal']),
    );
  });

  it("Details and Settings: icon buttons at the toolbar's right, the palette, their chords", () => {
    expect(commandTrailing.map((i) => i.key)).toEqual(['details', 'settings']);
    expect(commandTrailing.every((i) => i.kind === 'icon')).toBe(true);
    expect(palette).toEqual(expect.arrayContaining(['toggle-details', 'open-settings']));
    expect(chord(',', { ctrl: true })).not.toBeNull();
  });

  it('the search chips: one Filters button with Kind / Date modified / Size flyouts', () => {
    expect(filterCommand.kind !== 'divider' && filterCommand.menu?.map((i) => i.key)).toEqual([
      'chip-kind',
      'chip-modified',
      'chip-size',
    ]);
    for (const flyout of filterCommand.kind !== 'divider' ? (filterCommand.menu ?? []) : [])
      expect(flyout.kind === 'submenu' && flyout.items.length).toBeGreaterThan(2);
  });

  it('Filters says its active chips in its name and is a menu button, not a toggle', async () => {
    const { search } = await import('$lib/state/search.svelte');
    if (filterCommand.kind === 'divider') throw new Error('not a button');
    expect(accessibleName(filterCommand)).toBe('Filters');
    search.chips.kind = 'folder';
    search.chips.size = 'large';
    expect(accessibleName(filterCommand)).toBe('Filters, 2 active');
    expect(filterCommand.menu).toBeDefined();
  });

  it('back / forward / up / refresh stay toolbar buttons', () => {
    expect(navActions.map((a) => a.key)).toEqual(['back', 'forward', 'up', 'refresh']);
  });

  // Share had no `run` in the bar (a disabled placeholder for a later phase), so there is
  // nothing to move; recorded so its absence is a decision, not an accident.
  it('Share was a placeholder and is not offered anywhere', () => {
    expect([...background, ...row, ...palette]).not.toContain('share');
  });
});

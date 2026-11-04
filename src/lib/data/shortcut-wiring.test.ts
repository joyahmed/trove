// Plan 08 A3: every menu, palette, toolbar and tab-strip hint reads the overridden chord.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/window', () => ({ close: vi.fn() }));
vi.mock('$lib/api/fs', () => ({}));
vi.mock('$lib/api/shell', () => ({}));
vi.mock('$lib/api/transfer', () => ({}));
vi.mock('$lib/api/clipboard', () => ({}));
vi.mock('$lib/api/pty', () => ({}));
vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => null),
  writeSettings: vi.fn(async () => {}),
  mergeSettings: vi.fn(async () => {}),
}));

const { actionHint } = await import('./action-chords');
const { resetAllChords } = await import('./shortcut-overrides');
const { settings } = await import('$lib/state/settings.svelte');
const { keyLabel } = await import('$lib/utils/key-label');
const { showHiddenItem, newMenu, sortMenu, moreMenu, paneItems, viewModeItems } =
  await import('./menus');
const { viewChoices } = await import('./nav-actions');
const { commandTrailing } = await import('./command-actions');
const { VIEW_STEP_ACTIONS } = await import('./action-chords');

type Row = { kind: string; key: string; shortcut?: string; label?: string };
const hintOf = (rows: readonly unknown[], key: string): string | undefined =>
  (rows as Row[]).find((r) => r.kind === 'item' && r.key === key)?.shortcut;

afterEach(() => resetAllChords());

describe('an override shows in menus, the palette, the toolbar and the tab strip (plan 08 A3)', () => {
  it('every hard-coded hint now reads the override', () => {
    settings.shortcutOverrides = {
      'toggle-hidden': 'Ctrl+Alt+J',
      'new-folder': 'Ctrl+Alt+K',
      'sort-name': 'Ctrl+Alt+L',
      'view-icons': 'Ctrl+Alt+U',
      'open-settings': 'Ctrl+Alt+O',
      undo: 'Ctrl+Alt+Z',
      redo: 'Ctrl+Alt+Y',
      'toggle-details': 'Ctrl+Alt+D',
    };
    const k = (c: string) => keyLabel(c);
    expect(actionHint('toggle-hidden')).toBe(k('Ctrl+Alt+J'));
    expect(showHiddenItem.kind === 'item' && showHiddenItem.shortcut).toBe(k('Ctrl+Alt+J'));
    expect(hintOf(newMenu, (newMenu[0] as Row).key)).toBe(k('Ctrl+Alt+K'));
    expect(hintOf(sortMenu, 'name')).toBe(k('Ctrl+Alt+L'));
    expect(hintOf(moreMenu, 'undo')).toBe(k('Ctrl+Alt+Z'));
    expect(hintOf(moreMenu, 'redo')).toBe(k('Ctrl+Alt+Y'));
    expect(hintOf(moreMenu, 'settings')).toBe(k('Ctrl+Alt+O'));
    expect(hintOf(paneItems, 'details-pane')).toBe(k('Ctrl+Alt+D'));
    const i = VIEW_STEP_ACTIONS.indexOf('view-icons');
    expect((viewModeItems[i] as Row).shortcut).toBe(k('Ctrl+Alt+U'));
    expect(viewChoices.find((c) => c.key === 'grid')?.label).toContain(k('Ctrl+Alt+U'));
    const gear = (commandTrailing as Row[]).find((c) => c.key === 'settings');
    expect(gear?.label).toContain(k('Ctrl+Alt+O'));
    const details = (commandTrailing as Row[]).find((c) => c.key === 'details');
    expect(details?.label).toContain(k('Ctrl+Alt+D'));
  });

  it('with no override each hint is the default again', () => {
    expect(showHiddenItem.kind === 'item' && showHiddenItem.shortcut).not.toBe(
      keyLabel('Ctrl+Alt+J'),
    );
    expect(hintOf(moreMenu, 'undo')).toBe(actionHint('undo'));
  });
});

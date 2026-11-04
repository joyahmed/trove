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

import { showFlyout } from '$lib/data/menus';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import { sanitize, settings, type Settings } from '$lib/state/settings.svelte';
import { settingsSections, type SettingRow } from './settings-sections';

// Plan 06 6.3: Explorer's View ▸ Show toggles. Each is a `settings` boolean, a `sanitize` entry,
// an Appearance row and a check in the Show flyout; one table row here covers all four.
type Field = 'showExtensions' | 'compactView' | 'itemCheckboxes' | 'navPane';
const TOGGLES: { row: string; menu: string; field: Field; fallback: boolean }[] = [
  { row: 'show-extensions', menu: 'show-extensions', field: 'showExtensions', fallback: true },
  { row: 'compact-view', menu: 'compact-view', field: 'compactView', fallback: false },
  { row: 'item-checkboxes', menu: 'item-checkboxes', field: 'itemCheckboxes', fallback: false },
  { row: 'nav-pane', menu: 'nav-pane', field: 'navPane', fallback: true },
];

const row = (key: string): Extract<SettingRow, { kind: 'toggle' }> => {
  const r = settingsSections
    .find((s) => s.key === 'appearance')!
    .rows()
    .find((x) => x.key === key);
  if (r?.kind !== 'toggle') throw new Error(`no toggle row ${key}`);
  return r;
};
const menuItem = (key: string): Extract<MenuItem, { kind: 'item' }> => {
  const i = showFlyout.kind === 'submenu' ? showFlyout.items.find((x) => x.key === key) : null;
  if (i?.kind !== 'item') throw new Error(`no Show item ${key}`);
  return i;
};

describe.each(TOGGLES)('view toggle $field', ({ row: rowKey, menu, field, fallback }) => {
  beforeEach(() => settings.apply(sanitize(null)));

  it('a new install and an old file without the key both get the default', () => {
    expect(sanitize(null)[field]).toBe(fallback);
    expect(sanitize({ view: 'details' } as Partial<Settings>)[field]).toBe(fallback);
  });

  it('a junk value falls back to the default; a real boolean is kept', () => {
    for (const bad of ['yes', 'false', 0, 1, null, {}, []])
      expect(sanitize({ [field]: bad })[field]).toBe(fallback);
    expect(sanitize({ [field]: !fallback })[field]).toBe(!fallback);
  });

  it('the Appearance row reads and writes the setting', () => {
    const r = row(rowKey);
    expect(r.get()).toBe(fallback);
    r.set(!fallback);
    expect(settings[field]).toBe(!fallback);
    expect(r.get()).toBe(!fallback);
  });

  it('the Show flyout check flips it and shows its state', () => {
    const i = menuItem(menu);
    expect(i.checked?.()).toBe(fallback);
    i.run();
    expect(settings[field]).toBe(!fallback);
    expect(i.checked?.()).toBe(!fallback);
  });

  it('survives a snapshot / apply round trip', () => {
    settings[field] = !fallback;
    const snap = settings.snapshot();
    expect(snap[field]).toBe(!fallback);
    settings.apply(sanitize(null));
    settings.apply(sanitize(snap));
    expect(settings[field]).toBe(!fallback);
  });
});

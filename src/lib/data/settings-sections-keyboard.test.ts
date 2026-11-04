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

import { settings } from '$lib/state/settings.svelte';
import { actionHint } from './action-chords';
import { keyboardActions, resetAllChords } from './shortcut-overrides';
import { settingsSections, type SettingRow } from './settings-sections';

// Plan 08 A4: Settings ▸ Keyboard - a row per rebindable action, a refusal in words, resets.
const section = () => settingsSections.find((s) => s.key === 'keyboard');
const rows = () => section()?.rows() ?? [];
const shortcut = (id: string) =>
  rows().find((r) => r.key === `shortcut-${id}`) as Extract<SettingRow, { kind: 'shortcut' }>;
const resetAll = () =>
  rows().find((r) => r.key === 'shortcuts-reset-all') as Extract<SettingRow, { kind: 'button' }>;

beforeEach(() => resetAllChords());

describe('Settings ▸ Keyboard', () => {
  it('comes right after Appearance, one row per rebindable action, then Reset all', () => {
    const keys = settingsSections.map((s) => s.key);
    expect(keys.indexOf('keyboard')).toBe(keys.indexOf('appearance') + 1);
    expect(rows().map((r) => r.key)).toEqual([
      ...keyboardActions().map((id) => `shortcut-${id}`),
      'shortcuts-reset-all',
    ]);
    expect(rows().length).toBeGreaterThan(10);
  });

  it('a rebind shows the new chord and notes the default; Reset puts it back', () => {
    const home = shortcut('open-home');
    const before = home.get();
    expect(home.overridden()).toBe(false);
    expect(home.note?.()).toBeNull();
    expect(home.set('ctrl+alt+j')).toBeNull();
    expect(home.get()).toBe(actionHint('open-home'));
    expect(home.get()).not.toBe(before);
    expect(home.overridden()).toBe(true);
    expect(home.note?.()).toBe(`Default: ${before}`);
    home.reset();
    expect(home.get()).toBe(before);
  });

  it('a taken key is refused in words and nothing is saved', () => {
    const home = shortcut('open-home');
    const taken = home.set('ctrl+w');
    expect(typeof taken).toBe('string');
    expect(settings.shortcutOverrides).toEqual({});
  });

  it('Reset all is disabled with no overrides and clears every one', () => {
    expect(resetAll().disabled?.()).toBe(true);
    shortcut('open-home').set('ctrl+alt+j');
    expect(resetAll().disabled?.()).toBe(false);
    void resetAll().run();
    expect(settings.shortcutOverrides).toEqual({});
  });
});

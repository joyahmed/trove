// Plan 08 A3/A4: a rebind fires, shows in every hint, refuses a taken or reserved key, resets,
// and survives a settings round-trip — and every action still has a chord.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyLike } from './shortcuts';

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

const { matchShortcut, shortcutTable } = await import('./shortcuts');
const { ACTION_CHORDS, LIST_OWNED, actionChord, actionHint, defaultChord } =
  await import('./action-chords');
const { rebind, rebindRefusal, resetAllChords, resetChord, isOverridden, keyboardActions } =
  await import('./shortcut-overrides');
const { REBINDABLE_ACTIONS } = await import('$lib/utils/chord-overrides');
const { settings, sanitize } = await import('$lib/state/settings.svelte');
const { keyLabel } = await import('$lib/utils/key-label');

const OS = ['windows', 'mac', 'linux'] as const;
type Os = (typeof OS)[number];
const COMBOS = OS.flatMap((host) => OS.map((style) => ({ host, style })));

const CODES: Record<string, string> = { '`': 'Backquote', '.': 'Period', ',': 'Comma' };
const codeOf = (key: string): string | undefined =>
  /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : CODES[key];

/** The keydown a chord string sends on a host (as action-chords.test.ts presses them). */
const press = (chord: string, host: Os): KeyLike => {
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  const mac = host === 'mac';
  return {
    key: parts.includes('Shift') ? key.toUpperCase() : key.toLowerCase(),
    code: codeOf(key),
    ctrlKey: mac ? parts.includes('Control') : parts.includes('Ctrl') || parts.includes('Control'),
    metaKey: mac && parts.includes('Ctrl'),
    altKey: parts.includes('Alt'),
    shiftKey: parts.includes('Shift'),
  };
};

const fire = (chord: string, host: Os, style: Os, overrides: Record<string, string>) =>
  matchShortcut(
    press(chord, host),
    false,
    shortcutTable(host === 'mac', style, host === 'linux', overrides),
    host === 'mac',
  )?.id;

afterEach(() => resetAllChords());

describe('the rebindable set', () => {
  it('is every chorded action but the file-list-owned ones', () => {
    const want = Object.keys(ACTION_CHORDS).filter((k) => !LIST_OWNED.has(k));
    expect([...REBINDABLE_ACTIONS].sort()).toEqual(want.sort());
    expect([...keyboardActions()].sort()).toEqual(want.sort());
  });
});

describe('an override fires (plan 08 A3)', () => {
  it('each rebindable action answers its new chord under every (host, style), not its old', () => {
    const wrong: string[] = [];
    for (const { host, style } of COMBOS) {
      for (const id of REBINDABLE_ACTIONS) {
        const overrides = { [id]: 'Ctrl+Alt+Shift+J' };
        const got = fire('Ctrl+Alt+Shift+J', host, style, overrides);
        if (got !== id) wrong.push(`${host}/${style} ${id} new → ${got}`);
        const old = defaultChord(id, style, host) as string;
        const oldGot = fire(old, host, style, overrides);
        if (oldGot === id) wrong.push(`${host}/${style} ${id} old ${old} still fires`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('keeps Alt+Enter Properties off a Mac when the Details pane is rebound', () => {
    const table = shortcutTable(false, 'windows', false, { 'toggle-details': 'Ctrl+Alt+J' });
    // `press` lower-cases the key; a real Alt+Enter sends 'Enter'
    const altEnter: KeyLike = {
      key: 'Enter',
      code: 'Enter',
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
    };
    const hit = matchShortcut(altEnter, false, table, false);
    expect(hit?.rebindKeeps).toBe(true);
  });

  it('matches the physical key it was recorded on (code), whatever the layout types', () => {
    const table = shortcutTable(false, 'windows', false, { 'open-home': 'Ctrl+Alt+J' });
    const bengali: KeyLike = {
      key: 'জ',
      code: 'KeyJ',
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
    };
    expect(matchShortcut(bengali, false, table, false)?.id).toBe('open-home');
  });

  it('the live table follows settings.shortcutOverrides', async () => {
    const { currentShortcuts } = await import('./shortcuts');
    settings.shortcutOverrides = { 'open-home': 'Ctrl+Alt+J' };
    expect(currentShortcuts().some((s) => s.id === 'open-home' && s.key === 'J')).toBe(true);
    resetAllChords();
    expect(currentShortcuts().some((s) => s.id === 'open-home' && s.key === 'J')).toBe(false);
  });
});

describe('an override shows in every hint', () => {
  it('actionChord / actionHint name it under every style', () => {
    for (const { host, style } of COMBOS) {
      const o = { 'open-home': 'Ctrl+Alt+J' };
      expect(actionChord('open-home', style, host, o)).toBe('Ctrl+Alt+J');
      expect(actionHint('open-home', style, host, o)).toBe(keyLabel('Ctrl+Alt+J', host === 'mac'));
    }
  });
});

describe('a rebind is refused when the key is taken (plan 08 A4)', () => {
  const pc = { host: 'windows' as const, style: 'windows' as const };

  it("another action's chord: refused in words, nothing saved", () => {
    const why = rebind('open-home', 'ctrl+alt+n', pc); // Ctrl+Alt+N is New text document
    expect(why).toMatch(/already New text document/);
    expect(isOverridden('open-home')).toBe(false);
  });

  it("another action's override counts too", () => {
    expect(rebind('open-home', 'ctrl+alt+j', pc)).toBeNull();
    expect(rebind('open-this-pc', 'ctrl+alt+j', pc)).toMatch(/already Open Home/);
    expect(isOverridden('open-this-pc')).toBe(false);
  });

  it('a built-in window chord (Ctrl+W close tab) and a file-list key (Ctrl+C Copy) are taken', () => {
    expect(rebind('open-home', 'ctrl+w', pc)).toMatch(/already a built-in/);
    expect(rebind('open-home', 'ctrl+c', pc)).toMatch(/already Copy/);
    expect(settings.shortcutOverrides).toEqual({});
  });

  it('a key the system keeps is refused, for the host and for the style', () => {
    expect(rebind('open-home', 'alt+f4', pc)).toMatch(/Close window/);
    expect(rebind('open-home', 'super+q', { host: 'mac', style: 'mac' })).toMatch(/Quit/);
    expect(rebind('open-home', 'shift+super+4', { host: 'mac', style: 'windows' })).toMatch(
      /screenshot/,
    );
    // a PC coming from Mac: Ctrl+Q is the hand reaching for ⌘Q
    expect(rebind('open-home', 'ctrl+q', { host: 'windows', style: 'mac' })).toMatch(/Quit/);
    expect(rebind('open-home', 'ctrl+alt+t', { host: 'linux', style: 'linux' })).toMatch(
      /terminal/,
    );
    expect(settings.shortcutOverrides).toEqual({});
  });

  it('Super off a Mac and Shift alone are refused before any check', () => {
    expect(rebind('open-home', 'super+j', pc)).toMatch(/Windows \(Super\) key/);
    expect(rebind('open-home', 'shift+j', pc)).toMatch(/Shift alone/);
  });

  it('a free key is accepted; the refusal check alone says null', () => {
    expect(rebindRefusal('open-home', 'Ctrl+Alt+J', { ...pc, overrides: {} })).toBeNull();
    expect(rebind('open-home', 'ctrl+alt+j', pc)).toBeNull();
    expect(settings.shortcutOverrides).toEqual({ 'open-home': 'Ctrl+Alt+J' });
  });

  it("re-recording the action's own default is a reset, not an override", () => {
    expect(rebind('open-home', 'ctrl+alt+j', pc)).toBeNull();
    expect(rebind('open-home', 'ctrl+shift+h', pc)).toBeNull();
    expect(isOverridden('open-home')).toBe(false);
  });
});

describe('reset and persistence', () => {
  const pc = { host: 'windows' as const, style: 'windows' as const };

  it('reset one row leaves the others; reset all clears every one', () => {
    rebind('open-home', 'ctrl+alt+j', pc);
    rebind('open-this-pc', 'ctrl+alt+k', pc);
    resetChord('open-home');
    expect(settings.shortcutOverrides).toEqual({ 'open-this-pc': 'Ctrl+Alt+K' });
    resetAllChords();
    expect(settings.shortcutOverrides).toEqual({});
  });

  it('survives a settings round-trip (snapshot → JSON → sanitize → apply)', () => {
    rebind('open-home', 'ctrl+alt+j', pc);
    rebind('undo', 'ctrl+alt+u', pc);
    const saved = JSON.parse(JSON.stringify(settings.snapshot()));
    resetAllChords();
    settings.apply(sanitize(saved));
    expect(settings.shortcutOverrides).toEqual({ 'open-home': 'Ctrl+Alt+J', undo: 'Ctrl+Alt+U' });
  });

  it('every action still has a chord with overrides on (plan 08 A1 holds)', () => {
    rebind('open-home', 'ctrl+alt+j', pc);
    for (const { host, style } of COMBOS)
      for (const key of Object.keys(ACTION_CHORDS))
        expect(actionChord(key, style, host), `${key} ${host}/${style}`).not.toBeNull();
  });
});

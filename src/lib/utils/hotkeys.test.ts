import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chordWarning,
  defaultSpotlightHotkey,
  isSuperKey,
  prettyChord,
  recordChord,
} from './hotkeys';

describe('prettyChord', () => {
  it('reads a chord the way the keyboard is labelled', () => {
    expect(prettyChord('super+space')).toBe('Win + Space');
    expect(prettyChord('ctrl+shift+p')).toBe('Ctrl + Shift + P');
    expect(prettyChord('alt+f1')).toBe('Alt + F1');
  });
});

describe('chordWarning', () => {
  // Win+Space is refused by Windows outright; the others did not fire. Either way the warning
  // belongs on every Win chord, and it has to arrive BEFORE the choice — an error toast is
  // gone in seconds. Measured 2026-09-24.
  it('warns about every Win chord, not only Win+Space', () => {
    expect(chordWarning('super+space')).toMatch(/refused outright/);
    expect(chordWarning('super+f1')).toMatch(/Win/);
    expect(chordWarning('super+shift+space')).toMatch(/Win/);
  });

  it('warns about a chord with no modifier at all', () => {
    expect(chordWarning('space')).toMatch(/Ctrl, Alt or Shift/);
    expect(chordWarning('f1')).toMatch(/Ctrl, Alt or Shift/);
  });

  // Alt+Space was measured working (2026-09-24) — the note names the trade-off it makes,
  // it does not warn the chord off.
  it('tells you what Alt+Space costs, rather than calling it broken', () => {
    const note = chordWarning('alt+space');
    expect(note).toMatch(/This works/);
    expect(note).toMatch(/window menu/);
  });

  it('says nothing about a chord that works', () => {
    expect(chordWarning('ctrl+space')).toBeNull();
    expect(chordWarning('ctrl+shift+p')).toBeNull();
    expect(chordWarning('alt+f1')).toBeNull();
  });
});

describe('prettyChord off Windows', () => {
  it('writes a Mac chord as its menus do: ⌃ ⌥ ⇧ ⌘ symbols, then the key', () => {
    expect(prettyChord('alt+space', true)).toBe('⌥Space');
    expect(prettyChord('ctrl+shift+space', true)).toBe('⌃⇧Space');
    expect(prettyChord('shift+super+p', true)).toBe('⇧⌘P');
  });

  it('calls the Win key Super on Linux and keeps the rest', () => {
    expect(prettyChord('super+space', false, false)).toBe('Super + Space');
    expect(prettyChord('alt+space', false, false)).toBe('Alt + Space');
  });

  it("drops Windows' own warnings off Windows, and names Mac modifiers on a Mac", () => {
    expect(chordWarning('super+space', false)).toBeNull();
    expect(chordWarning('alt+space', false)).toBeNull();
    expect(chordWarning('space', false, true)).toMatch(/⌃, ⌥ or ⇧/);
    expect(chordWarning('space', false, false)).toMatch(/Ctrl, Alt or Shift/);
  });
});

describe('recordChord', () => {
  const press = (
    code: string,
    mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {},
  ) => ({
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });

  it('records Super from the held key, as WebKitGTK never sets metaKey for it', () => {
    // measured on Ubuntu: Super+K arrives as key=k with metaKey false; it used to record nothing
    expect(recordChord(press('KeyK'), true)).toEqual({ chord: 'super+k' });
    // and Ctrl+Shift+Super+J used to be saved as ctrl+shift+j
    expect(recordChord(press('KeyJ', { ctrlKey: true, shiftKey: true }), true)).toEqual({
      chord: 'ctrl+shift+super+j',
    });
    expect(recordChord(press('Space', { metaKey: true }), false)).toEqual({ chord: 'super+space' });
  });

  it('refuses a lone key in words instead of ignoring it', () => {
    const r = recordChord(press('KeyK'), false);
    expect(r).not.toBeNull();
    expect(r && 'refused' in r && r.refused).toMatch(/at least one of/);
  });

  it('keeps listening on a modifier alone', () => {
    expect(recordChord(press('ShiftLeft', { shiftKey: true }), false)).toBeNull();
    expect(recordChord(press('OSLeft'), true)).toBeNull();
  });

  it('knows the Super key in every spelling a webview uses', () => {
    expect(isSuperKey({ key: 'Super', code: 'OSLeft' })).toBe(true);
    expect(isSuperKey({ key: 'Meta', code: 'MetaLeft' })).toBe(true);
    expect(isSuperKey({ key: 'OS', code: 'OSRight' })).toBe(true);
    expect(isSuperKey({ key: 'k', code: 'KeyK' })).toBe(false);
  });
});

// Joy's pick 2026-10-23: GNOME holds Alt+Space for its window menu, so Linux starts on
// Ctrl+Alt+Space; Windows and the Mac keep Alt+Space (⌥Space).
describe('defaultSpotlightHotkey', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is ctrl+alt+space on Linux and alt+space elsewhere', () => {
    expect(defaultSpotlightHotkey(true)).toBe('ctrl+alt+space');
    expect(defaultSpotlightHotkey(false)).toBe('alt+space');
  });

  it('follows the injected host', () => {
    for (const [os, chord] of [
      ['linux', 'ctrl+alt+space'],
      ['windows', 'alt+space'],
      ['macos', 'alt+space'],
    ] as const) {
      vi.stubGlobal('window', { __TROVE_PLATFORM__: { os, thisPcLabel: 'x' } });
      expect(defaultSpotlightHotkey()).toBe(chord);
    }
  });

  it('is the Windows chord off Tauri (nothing injected)', () => {
    expect(defaultSpotlightHotkey()).toBe('alt+space');
  });
});

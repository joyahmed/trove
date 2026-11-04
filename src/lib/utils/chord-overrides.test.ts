// Plan 08 A3/A4: the shape of `shortcutOverrides` and the recorder → override conversion.
import { describe, expect, it, vi } from 'vitest';
import {
  chordSignature,
  fromRecorded,
  isOverrideChord,
  REBINDABLE_ACTIONS,
  fromStoredChord,
  sanitizeOverrides,
  toStoredChord,
  toStoredOverrides,
} from './chord-overrides';

vi.mock('$lib/api/settings', () => ({
  readSettings: vi.fn(async () => null),
  writeSettings: vi.fn(async () => {}),
  mergeSettings: vi.fn(async () => {}),
}));

describe('sanitizeOverrides', () => {
  it('keeps known action ids with well-formed chords', () => {
    expect(sanitizeOverrides({ 'open-home': 'Ctrl+Alt+H', undo: 'Control+Ctrl+U' })).toEqual({
      'open-home': 'Ctrl+Alt+H',
      undo: 'Control+Ctrl+U',
    });
  });

  it('drops unknown ids, list-owned ids and malformed chords', () => {
    expect(
      sanitizeOverrides({
        'no-such-action': 'Ctrl+J',
        copy: 'Ctrl+J', // the file list owns Copy
        'open-home': 'Shift+H', // Shift alone types
        'open-this-pc': 'Alt+Ctrl+J', // modifiers out of order
        'new-tab': 'Ctrl+Ctrl+J', // a modifier twice
        redo: 'Ctrl+', // no key
        'sort-name': 'Ctrl+Escape', // a key it cannot name
        'sort-size': 42,
        'toggle-hidden': 'ctrl+j', // the recorder's spelling, not the table's
      }),
    ).toEqual({});
  });

  it('anything not a record is no overrides', () => {
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides('Ctrl+J')).toEqual({});
    expect(sanitizeOverrides(['Ctrl+J'])).toEqual({});
  });

  it('settings.sanitize runs it, and a missing key is empty', async () => {
    const { sanitize } = await import('$lib/state/settings.svelte');
    expect(sanitize({}).shortcutOverrides).toEqual({});
    expect(
      sanitize({ shortcutOverrides: { 'open-home': 'Ctrl+Alt+H', bogus: 'Ctrl+J' } })
        .shortcutOverrides,
    ).toEqual({ 'open-home': 'Ctrl+Alt+H' });
  });

  it('every rebindable id is unique', () => {
    expect(new Set(REBINDABLE_ACTIONS).size).toBe(REBINDABLE_ACTIONS.length);
  });
});

describe('fromRecorded', () => {
  it('PC: ctrl is Ctrl, keys as the table writes them, modifiers in one order', () => {
    expect(fromRecorded('ctrl+alt+j', false)).toEqual({ chord: 'Ctrl+Alt+J' });
    expect(fromRecorded('ctrl+shift+period', false)).toEqual({ chord: 'Ctrl+Shift+.' });
    expect(fromRecorded('alt+f7', false)).toEqual({ chord: 'Alt+F7' });
    expect(fromRecorded('ctrl+left', false)).toEqual({ chord: 'Ctrl+ArrowLeft' });
    expect(fromRecorded('ctrl+3', false)).toEqual({ chord: 'Ctrl+3' });
  });

  it('Mac: Super is ⌘ (the table Ctrl), ctrl the real Control key', () => {
    expect(fromRecorded('shift+super+j', true)).toEqual({ chord: 'Ctrl+Shift+J' });
    expect(fromRecorded('ctrl+super+j', true)).toEqual({ chord: 'Control+Ctrl+J' });
    expect(fromRecorded('ctrl+alt+j', true)).toEqual({ chord: 'Control+Alt+J' });
  });

  it('refuses Super off a Mac and Shift alone', () => {
    expect(fromRecorded('super+j', false)).toHaveProperty('refused');
    expect(fromRecorded('shift+j', false)).toHaveProperty('refused');
    expect(fromRecorded('shift+j', true)).toHaveProperty('refused');
  });

  it('what it makes, sanitize keeps', () => {
    for (const rec of ['ctrl+alt+j', 'ctrl+shift+backquote', 'alt+bracketleft', 'ctrl+space']) {
      const r = fromRecorded(rec, false);
      expect('chord' in r && isOverrideChord(r.chord)).toBe(true);
    }
  });
});

describe('chordSignature', () => {
  it('Ctrl is ⌘ on a Mac, Control the Control key; both are Ctrl on a PC', () => {
    expect(chordSignature('Ctrl+Shift+H', true)).toBe('meta,shift,h');
    expect(chordSignature('Control+Ctrl+1', true)).toBe('ctrl,meta,1');
    expect(chordSignature('Control+Tab', false)).toBe(chordSignature('Ctrl+Tab', false));
    expect(chordSignature('Ctrl++', false)).toBe('ctrl,+');
  });
});

describe('stored chord spelling', () => {
  it('writes the primary modifier as CmdOrCtrl and round-trips', () => {
    expect(toStoredChord('Control+Ctrl+J')).toBe('Control+CmdOrCtrl+J');
    expect(fromStoredChord('Control+CmdOrCtrl+J')).toBe('Control+Ctrl+J');
    expect(fromStoredChord(toStoredChord('Ctrl+Shift+H'))).toBe('Ctrl+Shift+H');
  });
  it('reads the old and the new file form as the same in-memory chord', () => {
    const old = sanitizeOverrides({ 'new-tab': 'Control+Ctrl+J' });
    const next = sanitizeOverrides({ 'new-tab': 'Control+CmdOrCtrl+J' });
    expect(old).toEqual({ 'new-tab': 'Control+Ctrl+J' });
    expect(next).toEqual(old);
  });
  it('skips non-string values', () => {
    expect(sanitizeOverrides({ 'new-tab': 5 })).toEqual({});
  });
  it('toStoredOverrides never writes a bare Ctrl', () => {
    expect(toStoredOverrides({ 'new-tab': 'Ctrl+T', 'open-home': 'Alt+H' })).toEqual({
      'new-tab': 'CmdOrCtrl+T',
      'open-home': 'Alt+H',
    });
  });
});

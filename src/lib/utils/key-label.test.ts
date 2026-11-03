import { describe, expect, it } from 'vitest';
import {
  commandHint,
  finderDeleteKey,
  LIST_CHORDS,
  platformChord,
  type PlatformCommand,
  isFinderOpenKey,
  isFinderPurgeKey,
  isSelectAllKey,
  keyLabel,
  PLATFORM_CHORDS,
} from './key-label';

describe('keyLabel', () => {
  it('leaves Windows and Linux as written', () => {
    expect(keyLabel('Ctrl+Shift+N', false)).toBe('Ctrl+Shift+N');
    expect(keyLabel('Alt+Enter', false)).toBe('Alt+Enter');
    expect(keyLabel('Ctrl+`', false)).toBe('Ctrl+`');
  });

  it('writes the Mac way, in the Mac modifier order', () => {
    expect(keyLabel('Ctrl+Z', true)).toBe('⌘Z');
    expect(keyLabel('Ctrl+Shift+N', true)).toBe('⇧⌘N');
    expect(keyLabel('Alt+P', true)).toBe('⌥P');
    expect(keyLabel('F5', true)).toBe('F5');
    expect(keyLabel('Ctrl++', true)).toBe('⌘+');
    expect(keyLabel('Ctrl+,', true)).toBe('⌘,');
    expect(keyLabel('Ctrl+Alt+I', true)).toBe('⌥⌘I');
  });

  it("writes the terminal's Ctrl+` with the Mac's Control glyph, ⌃`", () => {
    expect(keyLabel('Ctrl+`', true)).toBe('⌃`');
  });
});

describe('commandHint (Mac, fleet #521)', () => {
  it('names the Mac key on a Mac', () => {
    expect(commandHint('refresh', 'mac', 'mac')).toBe('⌘R');
    expect(commandHint('redo', 'mac', 'mac')).toBe('⇧⌘Z');
    expect(commandHint('properties', 'mac', 'mac')).toBe('⌘I');
    expect(commandHint('detailsPane', 'mac', 'mac')).toBe('⌥⌘I');
  });

  it('keeps Windows and Linux as they were', () => {
    expect(commandHint('refresh', 'windows', 'windows')).toBe('F5');
    expect(commandHint('redo', 'windows', 'windows')).toBe('Ctrl+Y');
    expect(commandHint('properties', 'windows', 'windows')).toBe('Alt+Enter');
    expect(commandHint('detailsPane', 'windows', 'windows')).toBe('Alt+Enter');
  });

  it('gives no two commands the same Mac hint', () => {
    const mac = Object.values(PLATFORM_CHORDS).map(([, m]) => m);
    expect(new Set(mac).size).toBe(mac.length);
  });
});

describe('LIST_CHORDS: keys the file list handles (Mac, Finder keys)', () => {
  it('names Finder keys on a Mac: Open ⌘O, Move to Trash ⌘⌫, Delete permanently ⌥⌘⌫', () => {
    expect(commandHint('open', 'mac', 'mac')).toBe('⌘O');
    expect(commandHint('rename', 'mac', 'mac')).toBe('↩');
    expect(commandHint('delete', 'mac', 'mac')).toBe('⌘⌫');
    expect(commandHint('deletePermanently', 'mac', 'mac')).toBe('⌥⌘⌫');
  });

  it('keeps Windows and Linux as they were', () => {
    expect(commandHint('open', 'windows', 'windows')).toBe('Enter');
    expect(commandHint('rename', 'windows', 'windows')).toBe('F2');
    expect(commandHint('delete', 'windows', 'windows')).toBe('Delete');
    expect(commandHint('deletePermanently', 'windows', 'windows')).toBe('Shift+Delete');
  });

  it('Gallery and bin hints: Return / Delete off a Mac, ⌘O / ⌥⌘⌫ on one', () => {
    expect(commandHint('galleryOpen', 'windows', 'windows')).toBe('Enter');
    expect(commandHint('galleryOpen', 'mac', 'mac')).toBe('⌘O');
    expect(commandHint('binPurge', 'windows', 'windows')).toBe('Delete');
    expect(commandHint('binPurge', 'mac', 'mac')).toBe('⌥⌘⌫');
  });
});

const k = (
  key: string,
  m: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {},
) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...m,
});

describe('isFinderOpenKey (Gallery ⌘O / ⌘↓)', () => {
  it('matches ⌘O, ⌘⇧O-less, and ⌘↓ on a Mac', () => {
    expect(isFinderOpenKey(k('o', { metaKey: true }), 'mac', 'mac')).toBe(true);
    expect(isFinderOpenKey(k('O', { metaKey: true }), 'mac', 'mac')).toBe(true);
    expect(isFinderOpenKey(k('ArrowDown', { metaKey: true }), 'mac', 'mac')).toBe(true);
  });
  it('refuses other modifiers and plain keys', () => {
    expect(isFinderOpenKey(k('o', { metaKey: true, shiftKey: true }), 'mac', 'mac')).toBe(false);
    expect(isFinderOpenKey(k('o', { metaKey: true, altKey: true }), 'mac', 'mac')).toBe(false);
    expect(isFinderOpenKey(k('o'), 'mac', 'mac')).toBe(false);
    expect(isFinderOpenKey(k('ArrowDown'), 'mac', 'mac')).toBe(false);
  });
  it('does nothing off a Mac', () => {
    expect(isFinderOpenKey(k('o', { metaKey: true }), 'windows', 'windows')).toBe(false);
    expect(isFinderOpenKey(k('ArrowDown', { metaKey: true }), 'windows', 'windows')).toBe(false);
  });
});

describe('isFinderPurgeKey (Trash ⌥⌘⌫)', () => {
  it('matches exactly ⌥⌘⌫ on a Mac', () => {
    expect(isFinderPurgeKey(k('Backspace', { metaKey: true, altKey: true }), 'mac', 'mac')).toBe(
      true,
    );
  });
  it('refuses ⌘⌫, ⌃/⇧ added, and plain Backspace', () => {
    expect(isFinderPurgeKey(k('Backspace', { metaKey: true }), 'mac', 'mac')).toBe(false);
    expect(
      isFinderPurgeKey(
        k('Backspace', { metaKey: true, altKey: true, ctrlKey: true }),
        'mac',
        'mac',
      ),
    ).toBe(false);
    expect(
      isFinderPurgeKey(
        k('Backspace', { metaKey: true, altKey: true, shiftKey: true }),
        'mac',
        'mac',
      ),
    ).toBe(false);
    expect(isFinderPurgeKey(k('Backspace'), 'mac', 'mac')).toBe(false);
  });
  it('does nothing off a Mac (bin purge stays Delete)', () => {
    expect(
      isFinderPurgeKey(k('Backspace', { metaKey: true, altKey: true }), 'windows', 'windows'),
    ).toBe(false);
  });
});

describe('back / forward / up hints', () => {
  it('write the arrows on Windows and Linux, the Go-menu keys on a Mac', () => {
    expect(commandHint('back', 'windows', 'windows')).toBe('Alt+←');
    expect(commandHint('forward', 'windows', 'windows')).toBe('Alt+→');
    expect(commandHint('up', 'windows', 'windows')).toBe('Alt+↑');
    expect(commandHint('back', 'mac', 'mac')).toBe('⌘[');
    expect(commandHint('forward', 'mac', 'mac')).toBe('⌘]');
    expect(commandHint('up', 'mac', 'mac')).toBe('⌘↑');
  });
});

describe('isSelectAllKey', () => {
  it('is ⌘A on a Mac and Ctrl+A elsewhere, never the other one', () => {
    expect(isSelectAllKey(k('a', { metaKey: true }), true)).toBe(true);
    expect(isSelectAllKey(k('A', { metaKey: true }), true)).toBe(true);
    expect(isSelectAllKey(k('a', { ctrlKey: true }), true)).toBe(false);
    expect(isSelectAllKey(k('a', { ctrlKey: true }), false)).toBe(true);
    expect(isSelectAllKey(k('a', { metaKey: true }), false)).toBe(false);
    expect(isSelectAllKey(k('b', { metaKey: true }), true)).toBe(false);
  });
});

// Plan 19 Phase 2: the "I'm coming from" style picks the chord, the host draws it.
describe('hints: style picks, host draws (plan 19, 2.1)', () => {
  const OS = ['windows', 'mac', 'linux'] as const;
  const ALL = { ...PLATFORM_CHORDS, ...LIST_CHORDS };
  const RESERVED = ['nextTab', 'prevTab', 'viewIcons', 'viewList', 'viewDetails'];
  const ZAP = ['deletePermanently', 'binPurge'];

  it('3 hosts × 3 styles: every command takes the style column, reserved ones the host column', () => {
    for (const host of OS)
      for (const style of OS)
        for (const cmd of Object.keys(ALL) as PlatformCommand[]) {
          const [win, mac] = ALL[cmd];
          const column = RESERVED.includes(cmd) ? host : style;
          const expected = column === 'mac' && !(host === 'linux' && ZAP.includes(cmd)) ? mac : win;
          expect(platformChord(cmd, style, host), `${host}/${style}/${cmd}`).toBe(expected);
        }
  });

  it('labels name the key you press: Mac style on a PC writes Ctrl, never ⌘', () => {
    expect(commandHint('back', 'mac', 'windows')).toBe('Ctrl+[');
    expect(commandHint('forward', 'mac', 'windows')).toBe('Ctrl+]');
    expect(commandHint('up', 'mac', 'windows')).toBe('Ctrl+↑');
    expect(commandHint('redo', 'mac', 'windows')).toBe('Ctrl+Shift+Z');
    expect(commandHint('properties', 'mac', 'windows')).toBe('Ctrl+I');
    expect(commandHint('delete', 'mac', 'windows')).toBe('Ctrl+Backspace');
    expect(commandHint('deletePermanently', 'mac', 'windows')).toBe('Ctrl+Alt+Backspace');
    for (const host of ['windows', 'linux'] as const)
      for (const cmd of Object.keys(ALL) as PlatformCommand[])
        expect(commandHint(cmd, 'mac', host)).not.toMatch(/[⌘⌥⇧⌃]/);
  });

  it('PC style on a Mac names Explorer keys with Mac glyphs', () => {
    expect(commandHint('back', 'windows', 'mac')).toBe('⌥←');
    expect(commandHint('up', 'windows', 'mac')).toBe('⌥↑');
    expect(commandHint('redo', 'windows', 'mac')).toBe('⌘Y');
    expect(commandHint('properties', 'windows', 'mac')).toBe('⌥↩');
    expect(commandHint('delete', 'linux', 'mac')).toBe('⌦');
  });

  it('views and tab cycle stay the host keys on every style', () => {
    for (const style of OS) {
      expect(commandHint('viewDetails', style, 'mac')).toBe('⌃⌘6');
      expect(commandHint('nextTab', style, 'mac')).toBe('⌃Tab');
      expect(commandHint('viewDetails', style, 'windows')).toBe('Ctrl+Shift+6');
      expect(commandHint('nextTab', style, 'linux')).toBe('Ctrl+Tab');
    }
  });

  it('a Linux host never names Ctrl+Alt+Backspace (X11 Zap)', () => {
    expect(commandHint('deletePermanently', 'mac', 'linux')).toBe('Shift+Delete');
    expect(commandHint('binPurge', 'mac', 'linux')).toBe('Delete');
    expect(commandHint('delete', 'mac', 'linux')).toBe('Ctrl+Backspace');
  });
});

describe('Finder keys on a PC coming from Mac (plan 19, 2.1 / 2.3)', () => {
  const altGr = (m: Parameters<typeof k>[1]) => ({
    ...k('Backspace', m),
    getModifierState: (key: string) => key === 'AltGraph',
  });

  it('Open: Ctrl+O / Ctrl+↓ on Windows and Linux with Mac style, not ⌘ there', () => {
    for (const host of ['windows', 'linux'] as const) {
      expect(isFinderOpenKey(k('o', { ctrlKey: true }), 'mac', host)).toBe(true);
      expect(isFinderOpenKey(k('ArrowDown', { ctrlKey: true }), 'mac', host)).toBe(true);
      expect(isFinderOpenKey(k('o', { metaKey: true }), 'mac', host)).toBe(false);
      expect(isFinderOpenKey(k('o', { ctrlKey: true, shiftKey: true }), 'mac', host)).toBe(false);
      expect(isFinderOpenKey(k('o', { ctrlKey: true }), 'windows', host)).toBe(false);
      expect(isFinderOpenKey(k('o', { ctrlKey: true }), 'linux', host)).toBe(false);
    }
  });

  it("a Mac keeps ⌘O under every style (a style never removes the host's keys)", () => {
    for (const style of ['windows', 'mac', 'linux'] as const)
      expect(isFinderOpenKey(k('o', { metaKey: true }), style, 'mac')).toBe(true);
  });

  it('purge: Ctrl+Alt+Backspace on Windows with Mac style; never AltGr; never on Linux', () => {
    expect(
      isFinderPurgeKey(k('Backspace', { ctrlKey: true, altKey: true }), 'mac', 'windows'),
    ).toBe(true);
    expect(isFinderPurgeKey(altGr({ ctrlKey: true, altKey: true }), 'mac', 'windows')).toBe(false);
    expect(isFinderPurgeKey(k('Backspace', { ctrlKey: true, altKey: true }), 'mac', 'linux')).toBe(
      false,
    );
    expect(
      isFinderPurgeKey(k('Backspace', { ctrlKey: true, altKey: true }), 'windows', 'windows'),
    ).toBe(false);
    expect(
      isFinderPurgeKey(k('Backspace', { metaKey: true, altKey: true }), 'windows', 'mac'),
    ).toBe(true);
  });

  it('finderDeleteKey: bin / permanent / nothing, exact chords per host', () => {
    // Windows host, Mac style
    expect(finderDeleteKey(k('Backspace', { ctrlKey: true }), 'mac', 'windows')).toBe('bin');
    expect(finderDeleteKey(k('Backspace', { ctrlKey: true, altKey: true }), 'mac', 'windows')).toBe(
      'permanent',
    );
    expect(finderDeleteKey(altGr({ ctrlKey: true, altKey: true }), 'mac', 'windows')).toBeNull();
    expect(
      finderDeleteKey(k('Backspace', { ctrlKey: true, shiftKey: true }), 'mac', 'windows'),
    ).toBeNull();
    expect(finderDeleteKey(k('Backspace', { metaKey: true }), 'mac', 'windows')).toBeNull();
    expect(finderDeleteKey(k('Backspace'), 'mac', 'windows')).toBeNull();
    // Windows style on a PC: neither
    expect(finderDeleteKey(k('Backspace', { ctrlKey: true }), 'windows', 'windows')).toBeNull();
    expect(
      finderDeleteKey(k('Backspace', { ctrlKey: true, altKey: true }), 'windows', 'windows'),
    ).toBeNull();
    // Linux: bin yes, Zap never
    expect(finderDeleteKey(k('Backspace', { ctrlKey: true }), 'mac', 'linux')).toBe('bin');
    expect(
      finderDeleteKey(k('Backspace', { ctrlKey: true, altKey: true }), 'mac', 'linux'),
    ).toBeNull();
    // a Mac keeps ⌘⌫ / ⌥⌘⌫ on every style, and Ctrl+⌫ is not them
    for (const style of ['windows', 'mac', 'linux'] as const) {
      expect(finderDeleteKey(k('Backspace', { metaKey: true }), style, 'mac')).toBe('bin');
      expect(finderDeleteKey(k('Backspace', { metaKey: true, altKey: true }), style, 'mac')).toBe(
        'permanent',
      );
      expect(finderDeleteKey(k('Backspace', { ctrlKey: true }), style, 'mac')).toBeNull();
    }
  });

  it('Mac host: Ctrl+Alt+Backspace does nothing, in a folder (finderDeleteKey) and in the Trash (isFinderPurgeKey)', () => {
    const chord = k('Backspace', { ctrlKey: true, altKey: true });
    for (const style of ['windows', 'mac', 'linux'] as const) {
      expect(finderDeleteKey(chord, style, 'mac')).toBeNull();
      expect(isFinderPurgeKey(chord, style, 'mac')).toBe(false);
    }
  });
});

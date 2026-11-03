// G.59: show / hide hidden items from the keyboard, each system's own key, per host and style.
import { describe, expect, it, vi } from 'vitest';
import type { KeyLike } from './shortcuts';

vi.mock('$lib/api/window', () => ({ close: vi.fn() }));
vi.mock('$lib/api/fs', () => ({}));
vi.mock('$lib/api/shell', () => ({}));
vi.mock('$lib/api/transfer', () => ({}));
vi.mock('$lib/api/clipboard', () => ({}));
vi.mock('$lib/api/pty', () => ({}));

const { matchShortcut, shortcutTable } = await import('./shortcuts');
const { settings } = await import('$lib/state/settings.svelte');
const { hiddenItemsChord, hiddenItemsHint } = await import('$lib/utils/key-label');

const OS = ['windows', 'mac', 'linux'] as const;
type Os = (typeof OS)[number];

const tableOn = (host: Os, style: Os) => shortcutTable(host === 'mac', style, host === 'linux');
/** Finder's ⇧⌘. on a Mac keyboard, Ctrl+Shift+. on a PC: Shift makes the key ">" */
const finderKey = (host: Os): KeyLike => ({
  key: '>',
  code: 'Period',
  ctrlKey: host !== 'mac',
  metaKey: host === 'mac',
  altKey: false,
  shiftKey: true,
});
const ctrlH: KeyLike = { key: 'h', code: 'KeyH', ctrlKey: true, altKey: false, shiftKey: false };
const cmdH: KeyLike = { ...ctrlH, ctrlKey: false, metaKey: true };
const fires = (e: KeyLike, host: Os, style: Os) =>
  matchShortcut(e, false, tableOn(host, style), host === 'mac') !== null;

describe('hidden items key (G.59)', () => {
  it('Finder’s chord: on a Mac host always, on a PC only under Mac style', () => {
    for (const style of OS) expect(fires(finderKey('mac'), 'mac', style), style).toBe(true);
    for (const host of ['windows', 'linux'] as const)
      for (const style of OS)
        expect(fires(finderKey(host), host, style), `${host}/${style}`).toBe(style === 'mac');
  });

  it('Ctrl+H: on a Linux host always, on Windows only under Linux style, never on a Mac', () => {
    for (const style of OS) {
      expect(fires(ctrlH, 'linux', style), `linux/${style}`).toBe(true);
      expect(fires(ctrlH, 'windows', style), `windows/${style}`).toBe(style === 'linux');
      expect(fires(cmdH, 'mac', style), `mac/${style} ⌘H`).toBe(false);
      expect(fires(ctrlH, 'mac', style), `mac/${style} ⌃H`).toBe(false);
    }
  });

  it('Windows style on a Windows host binds no hidden key (Explorer has none)', () => {
    expect(fires(finderKey('windows'), 'windows', 'windows')).toBe(false);
    expect(fires(ctrlH, 'windows', 'windows')).toBe(false);
    expect(hiddenItemsChord('windows', 'windows')).toBeNull();
    expect(hiddenItemsHint('windows', 'windows')).toBeUndefined();
  });

  it('the key flips Show hidden items, and not from a text field', () => {
    const was = settings.showHidden;
    const hit = matchShortcut(finderKey('mac'), false, tableOn('mac', 'mac'), true);
    void hit?.run();
    expect(settings.showHidden).toBe(!was);
    void hit?.run();
    expect(settings.showHidden).toBe(was);
    expect(matchShortcut(finderKey('mac'), true, tableOn('mac', 'mac'), true)).toBeNull();
  });

  it('the menu hint names a chord the table binds, under every (host, style)', () => {
    for (const host of OS)
      for (const style of OS) {
        const chord = hiddenItemsChord(style, host);
        if (chord === null) continue;
        const e = chord === 'Ctrl+H' ? ctrlH : finderKey(host);
        expect(fires(e, host, style), `${host}/${style} ${chord}`).toBe(true);
      }
    expect(hiddenItemsHint('mac', 'mac')).toBe('⇧⌘.');
    expect(hiddenItemsHint('linux', 'mac')).toBe('⇧⌘.');
    expect(hiddenItemsHint('linux', 'windows')).toBe('Ctrl+H');
    expect(hiddenItemsHint('mac', 'linux')).toBe('Ctrl+Shift+.');
  });

  it('no two entries answer the same key, in all 9 tables with the Linux host’s set', () => {
    for (const host of OS)
      for (const style of OS) {
        const table = tableOn(host, style);
        for (const e of [ctrlH, cmdH, finderKey(host)]) {
          const hits = table.filter((t) => matchShortcut(e, false, [t], host === 'mac'));
          expect(hits.length, `${host}/${style}`).toBeLessThanOrEqual(1);
        }
      }
  });
});

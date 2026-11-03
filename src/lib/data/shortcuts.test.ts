import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyLike, QueryRoot, Shortcut } from './shortcuts';

vi.mock('$lib/api/window', () => ({
  close: vi.fn(),
  snapWindow: vi.fn(() => Promise.resolve()),
}));
vi.mock('$lib/api/fs', () => ({}));
vi.mock('$lib/api/shell', () => ({}));
vi.mock('$lib/api/transfer', () => ({}));
vi.mock('$lib/api/clipboard', () => ({}));
vi.mock('$lib/api/pty', () => ({}));

const {
  addressBarShortcuts,
  addressHistoryShortcut,
  openAddressHistory,
  findAnythingHint,
  findAnythingShortcut,
  focusAddressBar,
  explorerShortcuts,
  finderShortcuts,
  currentShortcuts,
  propertiesShortcut,
  shortcutFor,
  TERMINAL_PANE,
  matchShortcut,
  menuCommandFor,
  shortcutTable,
} = await import('./shortcuts');
const shortcuts = currentShortcuts();
const { isRevealKey } = await import('$lib/utils/key-label');
const { navActions, viewChoices } = await import('./nav-actions');
const { findAnything } = await import('$lib/hooks/use-palette.svelte');
const { selection } = await import('$lib/state/selection.svelte');
const { panes } = await import('$lib/state/panes.svelte');
const { actions } = await import('$lib/state/actions.svelte');
const { tabs } = await import('$lib/state/tabs.svelte');
const { PLATFORM_CHORDS, platformChord } = await import('$lib/utils/key-label');
const { comingFrom } = await import('$lib/state/coming-from.svelte');

const key = (key: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean }> = {}) => ({
  key,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe('shortcuts', () => {
  it('maps the Explorer navigation chords', () => {
    expect(matchShortcut(key('ArrowLeft', { alt: true }), false)).toBe(
      shortcuts.find((s) => s.key === 'ArrowLeft'),
    );
    expect(matchShortcut(key('ArrowUp', { alt: true }), false)?.alt).toBe(true);
    expect(matchShortcut(key('Backspace'), false)?.key).toBe('Backspace');
    // Alt+Left without Alt is not a shortcut; Ctrl+Left is not either
    expect(matchShortcut(key('ArrowLeft'), false)).toBeNull();
    expect(matchShortcut(key('ArrowLeft', { ctrl: true }), false)).toBeNull();
  });

  it('skips the chords a text field owns while typing, keeps the tab ones', () => {
    expect(matchShortcut(key('Backspace'), true)).toBeNull();
    expect(matchShortcut(key('z', { ctrl: true }), true)).toBeNull();
    expect(matchShortcut(key('p', { alt: true }), true)).toBeNull();
    expect(matchShortcut(key('T', { ctrl: true }), true)?.key).toBe('t');
    expect(matchShortcut(key('T', { ctrl: true, shift: true }), true)?.shift).toBe(true);
    expect(matchShortcut(key('3', { ctrl: true }), true)?.key).toBe('3');
  });

  it('maps Ctrl+Shift+digit to the views by physical key, not the shifted symbol', () => {
    const hit = matchShortcut(
      { key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true, altKey: false },
      false,
    );
    expect(hit?.code).toBe('Digit1');
    expect(
      matchShortcut(
        { key: '1', code: 'Digit1', ctrlKey: true, shiftKey: false, altKey: false },
        false,
      )?.code,
    ).toBeUndefined();
  });

  it('opens Find anything on Ctrl+K, typing or not, and only with Ctrl', () => {
    const hit = matchShortcut(key('K', { ctrl: true }), true);
    expect(hit?.key).toBe('k');
    expect(hit?.ctrl).toBe(true);
    expect(matchShortcut(key('k'), false)).toBeNull();
    expect(matchShortcut(key('k', { ctrl: true, shift: true }), false)).toBeNull();
  });

  it('toggles the panel: the chord closes what it opened', () => {
    const hit = matchShortcut(key('k', { ctrl: true }), false);
    expect(findAnything.open).toBe(false);
    void hit?.run();
    expect(findAnything.open).toBe(true);
    void hit?.run();
    expect(findAnything.open).toBe(false);
  });

  it('is ⌘K on a Mac, not Ctrl+K, and not Ctrl+⌘+K', () => {
    const mac = findAnythingShortcut(true);
    const cmdK = { ...key('k'), metaKey: true };
    expect(matchShortcut(cmdK, true, [mac])).toBe(mac);
    expect(matchShortcut(key('k', { ctrl: true }), true, [mac])).toBeNull();
    expect(matchShortcut({ ...key('k', { ctrl: true }), metaKey: true }, true, [mac])).toBeNull();
    // off a Mac, ⌘ held does not stop the other chords from matching, as before
    expect(matchShortcut({ ...key('t', { ctrl: true }), metaKey: true }, true)?.key).toBe('t');
  });

  it('names the chord the way the platform does', () => {
    expect(findAnythingHint(false)).toBe('Ctrl K');
    expect(findAnythingHint(true)).toBe('⌘K');
  });
});

describe('the Mac way (Mac, 2026-10-06)', () => {
  const ev = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });
  const keyOf = (s: Shortcut | null) => (s === null ? null : `${s.key}${s.alt ? '+alt' : ''}`);

  it('⌘F is the folder search on a Mac; Ctrl+F there is left to the system', () => {
    expect(keyOf(matchShortcut(ev('f', { metaKey: true }), false, shortcuts, true))).toBe('f');
    expect(matchShortcut(ev('f', { ctrlKey: true }), false, shortcuts, true)).toBeNull();
  });

  it('Windows and Linux keep Ctrl, and ignore ⌘ chords', () => {
    expect(keyOf(matchShortcut(ev('f', { ctrlKey: true }), false, shortcuts, false))).toBe('f');
    expect(matchShortcut(ev('f', { metaKey: true }), false, shortcuts, false)).toBeNull();
  });

  it('Option+P opens the preview though the Mac typed "π"', () => {
    const hit = matchShortcut(ev('π', { code: 'KeyP', altKey: true }), false, shortcuts, true);
    expect(keyOf(hit)).toBe('p+alt');
  });

  it('the terminal toggle stays Ctrl+` on a Mac', () => {
    expect(keyOf(matchShortcut(ev('`', { ctrlKey: true }), true, shortcuts, true))).toBe('`');
    expect(matchShortcut(ev('`', { metaKey: true }), true, shortcuts, true)).toBeNull();
  });

  it('the terminal toggle answers the key left of 1 on any layout, and a ` typed elsewhere', () => {
    // German: that key types "^"; French: "²". Its code stays Backquote.
    for (const typed of ['^', '²', '`'])
      for (const mac of [false, true]) {
        const e = ev(typed, { code: 'Backquote', ctrlKey: true });
        expect(keyOf(matchShortcut(e, true, shortcuts, mac))).toBe('`');
      }
    // a layout where ` sits on another key still opens it by the character
    expect(keyOf(matchShortcut(ev('`', { code: 'Equal', ctrlKey: true }), true, shortcuts))).toBe(
      '`',
    );
    expect(
      matchShortcut(ev('^', { code: 'Backquote', metaKey: true }), true, shortcuts, true),
    ).toBeNull();
  });

  it('⌘K still opens Find anything on a Mac, not Ctrl+⌘+K', () => {
    const table = [findAnythingShortcut(true)];
    expect(matchShortcut(ev('k', { metaKey: true }), true, table, true)).not.toBeNull();
    expect(matchShortcut(ev('k', { metaKey: true, ctrlKey: true }), true, table, true)).toBeNull();
  });
});

describe("Finder's Back / Forward / Enclosing folder on a Mac (Mac, 2026-10-07)", () => {
  const ev = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });
  const macTable = [...finderShortcuts(), ...shortcuts];
  const winTable = [...explorerShortcuts(), ...shortcuts];

  it('⌘[ goes back, ⌘] forward, ⌘↑ to the parent folder', () => {
    const t = tabs.active;
    const back = vi.spyOn(t, 'back').mockImplementation(() => {});
    const forward = vi.spyOn(t, 'forward').mockImplementation(() => {});
    const up = vi.spyOn(t, 'up').mockImplementation(() => {});
    void matchShortcut(ev('[', { metaKey: true }), false, macTable, true)?.run();
    void matchShortcut(ev(']', { metaKey: true }), false, macTable, true)?.run();
    void matchShortcut(ev('ArrowUp', { metaKey: true }), false, macTable, true)?.run();
    expect([back.mock.calls.length, forward.mock.calls.length, up.mock.calls.length]).toEqual([
      1, 1, 1,
    ]);
    back.mockRestore();
    forward.mockRestore();
    up.mockRestore();
  });

  it('matches the modifiers exactly', () => {
    for (const mods of [
      { metaKey: true, altKey: true },
      { metaKey: true, shiftKey: true },
      { metaKey: true, ctrlKey: true },
      { ctrlKey: true },
      {},
    ]) {
      expect(matchShortcut(ev('[', mods), false, macTable, true)).toBeNull();
      expect(matchShortcut(ev(']', mods), false, macTable, true)).toBeNull();
    }
    expect(
      matchShortcut(ev('ArrowUp', { metaKey: true, shiftKey: true }), false, macTable, true),
    ).toBeNull();
    expect(matchShortcut(ev('ArrowUp', { ctrlKey: true }), false, macTable, true)).toBeNull();
  });

  it('binds no ⌘↓ — that is Open, the list’s own key', () => {
    expect(matchShortcut(ev('ArrowDown', { metaKey: true }), false, macTable, true)).toBeNull();
  });

  it('not from a text field: ⌘↑ there moves the caret', () => {
    expect(matchShortcut(ev('ArrowUp', { metaKey: true }), true, macTable, true)).toBeNull();
    expect(matchShortcut(ev('[', { metaKey: true }), true, macTable, true)).toBeNull();
  });

  it('⌥↑ / ⌥← / ⌥→ still work on a Mac', () => {
    for (const k of ['ArrowUp', 'ArrowLeft', 'ArrowRight']) {
      expect(matchShortcut(ev(k, { altKey: true }), false, macTable, true)?.alt).toBe(true);
    }
  });

  it('Windows and Linux keep Alt+←/→/↑ and gain no Ctrl+[ / Ctrl+] / Ctrl+↑', () => {
    for (const k of ['ArrowUp', 'ArrowLeft', 'ArrowRight']) {
      expect(matchShortcut(ev(k, { altKey: true }), false, winTable, false)?.alt).toBe(true);
    }
    expect(matchShortcut(ev('[', { ctrlKey: true }), false, winTable, false)).toBeNull();
    expect(matchShortcut(ev(']', { ctrlKey: true }), false, winTable, false)).toBeNull();
    expect(matchShortcut(ev('ArrowUp', { ctrlKey: true }), false, winTable, false)).toBeNull();
  });
});

describe('the address bar from the keyboard (Ctrl+L, Alt+D, ⌘L)', () => {
  const ev = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });

  it('Ctrl+L and Alt+D on Windows and Linux, even from a text field', () => {
    const table = addressBarShortcuts(false);
    expect(matchShortcut(ev('l', { ctrlKey: true }), true, table, false)).toBe(table[0]);
    expect(matchShortcut(ev('L', { ctrlKey: true }), false, table, false)).toBe(table[0]);
    expect(matchShortcut(ev('d', { altKey: true }), true, table, false)).toBe(table[1]);
    expect(matchShortcut(ev('l'), false, table, false)).toBeNull();
    expect(matchShortcut(ev('d', { ctrlKey: true }), false, table, false)).toBeNull();
  });

  it('⌘L on a Mac, and no ⌥D there (it types ∂)', () => {
    const table = addressBarShortcuts(true);
    expect(table).toHaveLength(1);
    expect(matchShortcut(ev('l', { metaKey: true }), false, table, true)).toBe(table[0]);
    expect(matchShortcut(ev('l', { ctrlKey: true }), false, table, true)).toBeNull();
    expect(matchShortcut(ev('∂', { code: 'KeyD', altKey: true }), true, table, true)).toBeNull();
  });

  it('are in the window table', () => {
    expect(matchShortcut(ev('l', { ctrlKey: true }), false, shortcuts, false)?.key).toBe('l');
    expect(matchShortcut(ev('d', { altKey: true }), false, shortcuts, false)?.key).toBe('d');
  });

  it('F4 opens the ▾ list of recent places; Alt+F4 is not it, and a text field keeps F4', () => {
    expect(matchShortcut(ev('F4'), false, shortcuts, false)).toBe(addressHistoryShortcut);
    expect(matchShortcut(ev('F4', { altKey: true }), false, shortcuts, false)).toBeNull();
    expect(matchShortcut(ev('F4'), true, shortcuts, false)).toBeNull();
  });

  it('F4 sends the address bar its event; no bar, nothing happens', () => {
    const dispatchEvent = vi.fn();
    const root = {
      querySelector: (s: string) => (s === '[data-address-bar]' ? { dispatchEvent } : null),
    };
    expect(openAddressHistory(root as unknown as QueryRoot)).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(openAddressHistory({ querySelector: () => null })).toBe(false);
  });

  it('clicks the crumb row, which turns the bar into its text field', () => {
    const click = vi.fn();
    const seen: string[] = [];
    const crumb = {
      closest: (s: string) => {
        seen.push(s);
        return s === '[role="presentation"]' ? { click } : null;
      },
    };
    const root = {
      querySelector: (s: string) => (s === '[data-drop-kind="crumb"]' ? crumb : null),
    };
    expect(focusAddressBar(root as unknown as QueryRoot)).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['[role="presentation"]']);
  });

  it('does nothing when there is no crumb row (the bar is already a text field)', () => {
    expect(focusAddressBar({ querySelector: () => null })).toBe(false);
    const crumb = { closest: () => null } as unknown as Element;
    expect(focusAddressBar({ querySelector: () => crumb })).toBe(false);
  });
});

describe('Alt+Enter, Properties, from anywhere in the window', () => {
  const altEnter = { key: 'Enter', ctrlKey: false, altKey: true, shiftKey: false };

  it('is a window shortcut, but not from a text field', () => {
    expect(matchShortcut(altEnter, false, shortcuts, false)).toBe(propertiesShortcut);
    expect(matchShortcut(altEnter, false, shortcuts, true)).toBe(propertiesShortcut);
    expect(matchShortcut(altEnter, true, shortcuts, false)).toBeNull();
    expect(matchShortcut({ ...altEnter, altKey: false }, false, shortcuts, false)).toBeNull();
  });

  it('opens the details pane for a selection, and closes it again', () => {
    selection.clear();
    if (panes.isOpen('details')) panes.toggle('details');
    void propertiesShortcut.run();
    expect(panes.isOpen('details')).toBe(false); // nothing selected: nothing to show
    selection.contextClick('/tmp/a.txt');
    void propertiesShortcut.run();
    expect(panes.isOpen('details')).toBe(true);
    selection.clear();
    void propertiesShortcut.run();
    expect(panes.isOpen('details')).toBe(false); // open: the chord closes it, selection or not
  });
});

describe('Ctrl K while renaming', () => {
  it('cancels the rename, keeping the old name, then opens Find anything', () => {
    for (const mac of [false, true]) {
      if (findAnything.open) findAnything.toggle();
      const commit = vi.spyOn(actions, 'commitRename');
      actions.renaming = '/tmp/old.txt';
      actions.draft = 'half-typ';
      const chord = { key: 'k', ctrlKey: !mac, metaKey: mac, altKey: false, shiftKey: false };
      const hit = matchShortcut(chord, true, [findAnythingShortcut(mac)], mac);
      void hit?.run();
      expect(actions.renaming).toBeNull();
      expect(commit).not.toHaveBeenCalled();
      expect(findAnything.open).toBe(true);
      commit.mockRestore();
      findAnything.toggle();
    }
  });

  it('leaves no rename to cancel when none is open', () => {
    const cancel = vi.spyOn(actions, 'cancelRename');
    actions.renaming = null;
    void findAnythingShortcut(false).run();
    expect(cancel).not.toHaveBeenCalled();
    expect(findAnything.open).toBe(true);
    findAnything.toggle();
    cancel.mockRestore();
  });
});

describe('the terminal keeps its shell chords', () => {
  const ctrl = (key: string) => ({ key, ctrlKey: true, altKey: false, shiftKey: false });
  const altD = { key: 'd', ctrlKey: false, altKey: true, shiftKey: false };
  /** the terminal's textarea, inside the pane */
  const terminal = {
    tagName: 'TEXTAREA',
    closest: (s: string) => (s === TERMINAL_PANE ? {} : null),
  };
  /** the search box, in the toolbar */
  const searchBox = { tagName: 'INPUT', closest: () => null };

  it('Ctrl+L / Alt+D from the terminal reach the shell, not the address bar', () => {
    expect(shortcutFor(ctrl('l'), terminal, shortcuts, false)).toBeNull();
    expect(shortcutFor(altD, terminal, shortcuts, false)).toBeNull();
  });

  it('Ctrl+L / Alt+D from the search box still open the address bar', () => {
    const table = addressBarShortcuts(false);
    expect(shortcutFor(ctrl('l'), searchBox, table, false)).toBe(table[0]);
    expect(shortcutFor(altD, searchBox, table, false)).toBe(table[1]);
    expect(shortcutFor(ctrl('l'), searchBox, shortcuts, false)?.key).toBe('l');
    expect(shortcutFor(altD, searchBox, shortcuts, false)?.key).toBe('d');
    expect(shortcutFor(ctrl('l'), null, shortcuts, false)?.key).toBe('l');
  });

  it('Ctrl+K, Ctrl+E and Ctrl+F go to the shell too; the tab chords do not', () => {
    for (const k of ['k', 'e', 'f']) {
      expect(shortcutFor(ctrl(k), terminal, shortcuts, false)).toBeNull();
      expect(shortcutFor(ctrl(k), searchBox, shortcuts, false)?.key).toBe(k);
    }
    expect(shortcutFor(ctrl('t'), terminal, shortcuts, false)?.key).toBe('t');
    expect(shortcutFor(ctrl('`'), terminal, shortcuts, false)?.key).toBe('`');
  });

  it('a text field anywhere still skips the chords it owns', () => {
    expect(shortcutFor(ctrl('z'), searchBox, shortcuts, false)).toBeNull();
    expect(
      shortcutFor(ctrl('z'), { tagName: 'DIV', closest: () => null }, shortcuts, false)?.key,
    ).toBe('z');
  });
});

describe('Ctrl+Alt+Enter', () => {
  it('matches no window chord, so the list runs Properties itself and it toggles once', () => {
    const chord = { key: 'Enter', ctrlKey: true, altKey: true, shiftKey: false };
    expect(matchShortcut(chord, false, shortcuts, false)).toBeNull();
    expect(
      matchShortcut({ ...chord, ctrlKey: false, metaKey: true }, false, shortcuts, true),
    ).toBeNull();
  });
});

describe('Mac menu hints name keys that work (Mac, fleet #521)', () => {
  /** A table chord ("Ctrl+Shift+Z") as the keydown a Mac sends for it: Ctrl is ⌘ there. */
  const macPress = (chord: string): KeyLike => {
    const parts = chord.split('+');
    const k = parts.pop() ?? '';
    const has = (m: string) => parts.includes(m);
    return {
      key: k.length === 1 ? k.toLowerCase() : k,
      code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^\d$/.test(k) ? `Digit${k}` : undefined,
      ctrlKey: has('Control'),
      metaKey: has('Ctrl'),
      altKey: has('Alt'),
      shiftKey: has('Shift'),
    };
  };
  const macTable = shortcutTable(true);

  it('every Mac chord a menu shows is bound on a Mac', () => {
    for (const [, mac] of Object.values(PLATFORM_CHORDS)) {
      expect(matchShortcut(macPress(mac), false, macTable, true), mac).not.toBeNull();
    }
  });

  it('every non-Mac chord a menu shows is bound off a Mac', () => {
    for (const [win] of Object.values(PLATFORM_CHORDS)) {
      if (win === 'F5' || win === 'Alt+Enter') continue; // handled by the list / Properties, not the window table
      const p = macPress(win);
      const press = { ...p, ctrlKey: !!p.metaKey, metaKey: false };
      expect(matchShortcut(press, false), win).not.toBeNull();
    }
  });

  it('⇧⌘Z redoes, ⌘Z still undoes', () => {
    const redo = vi.spyOn(actions, 'redo').mockResolvedValue(undefined);
    const undo = vi.spyOn(actions, 'undo').mockResolvedValue(undefined);
    void matchShortcut(macPress('Ctrl+Shift+Z'), false, macTable, true)?.run();
    expect(redo).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
    void matchShortcut(macPress('Ctrl+Z'), false, macTable, true)?.run();
    expect(undo).toHaveBeenCalledTimes(1);
    redo.mockRestore();
    undo.mockRestore();
  });

  it('⌘R refreshes', () => {
    expect(matchShortcut(macPress('Ctrl+R'), false, macTable, true)?.key).toBe('r');
  });

  it('⌘I is Properties (needs a selection); ⌥⌘I toggles the Details pane', () => {
    selection.clear();
    if (panes.isOpen('details')) panes.toggle('details');
    void matchShortcut(macPress('Ctrl+I'), false, macTable, true)?.run();
    expect(panes.isOpen('details')).toBe(false); // nothing selected: nothing to show
    void matchShortcut(macPress('Ctrl+Alt+I'), false, macTable, true)?.run();
    expect(panes.isOpen('details')).toBe(true);
    void matchShortcut(macPress('Ctrl+Alt+I'), false, macTable, true)?.run();
    expect(panes.isOpen('details')).toBe(false);
  });

  it('⌥⌘I matches by key position though the Mac typed a dead key', () => {
    const hit = matchShortcut({ ...macPress('Ctrl+Alt+I'), key: 'ˆ' }, false, macTable, true);
    expect(hit?.alt).toBe(true);
  });

  it('Windows and Linux keep Ctrl+Y for Redo and bind no Ctrl+I or Ctrl+Shift+Z', () => {
    expect(explorerShortcuts().map((s) => s.key)).toEqual(['y']);
    const ctrl = (k: string, shift = false) => ({
      key: k,
      ctrlKey: true,
      altKey: false,
      shiftKey: shift,
    });
    expect(matchShortcut(ctrl('y'), false, shortcuts, false)?.key).toBe('y');
    expect(matchShortcut(ctrl('i'), false, shortcuts, false)).toBeNull();
    expect(matchShortcut(ctrl('z', true), false, shortcuts, false)).toBeNull();
  });
});

describe('Mac chords the system owns (Mac, 2026-10-07)', () => {
  const mac = shortcutTable(true);
  const press = (key: string, mods: Partial<KeyLike> = {}, code?: string): KeyLike => ({
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });
  const cmd = { metaKey: true };

  it('binds none of ⌘Tab, ⇧⌘3/4/5/6, ⌘Space, ⌥⌘Space, ⌘H, ⌘M, ⌘Q', () => {
    const reserved: KeyLike[] = [
      press('Tab', cmd),
      press('Tab', { ...cmd, shiftKey: true }),
      ...['3', '4', '5', '6'].flatMap((d) => [
        press('#', { ...cmd, shiftKey: true }, `Digit${d}`),
        press(d, { ...cmd, shiftKey: true }),
      ]),
      press(' ', cmd, 'Space'),
      press(' ', { ...cmd, altKey: true }, 'Space'),
      press('h', cmd, 'KeyH'),
      press('m', cmd, 'KeyM'),
      press('q', cmd, 'KeyQ'),
    ];
    for (const e of reserved) {
      for (const typing of [false, true]) {
        expect(matchShortcut(e, typing, mac, true), JSON.stringify(e)).toBeNull();
      }
    }
  });

  it('⌃Tab / ⌃⇧Tab and ⇧⌘] / ⇧⌘[ cycle the tabs, even from a text field', () => {
    const next = vi.spyOn(tabs, 'next').mockImplementation(() => {});
    const prev = vi.spyOn(tabs, 'prev').mockImplementation(() => {});
    const go = (e: KeyLike) => void matchShortcut(e, true, mac, true)?.run();
    go(press('Tab', { ctrlKey: true }));
    go(press('}', { metaKey: true, shiftKey: true }, 'BracketRight'));
    expect(next).toHaveBeenCalledTimes(2);
    go(press('Tab', { ctrlKey: true, shiftKey: true }));
    go(press('{', { metaKey: true, shiftKey: true }, 'BracketLeft'));
    expect(prev).toHaveBeenCalledTimes(2);
    next.mockRestore();
    prev.mockRestore();
  });

  it('⌘1-9 still jump to a tab; ⌃⌘1…6 are the views and ⇧⌘1…6 are nothing', () => {
    expect(matchShortcut(press('2', cmd, 'Digit2'), false, mac, true)?.ctrl).toBe(true);
    for (const d of [1, 2, 3, 4, 5, 6]) {
      const hit = matchShortcut(
        press(String(d), { ctrlKey: true, metaKey: true }, `Digit${d}`),
        false,
        mac,
        true,
      );
      expect(hit?.code, `⌃⌘${d}`).toBe(`Digit${d}`);
      expect(
        matchShortcut(press('!', { ...cmd, shiftKey: true }, `Digit${d}`), false, mac, true),
        `⇧⌘${d}`,
      ).toBeNull();
    }
  });

  it('keeps Ctrl+Tab and Ctrl+Shift+1…6 on Windows and Linux', () => {
    const win = shortcutTable(false);
    const e = (k: string, c: string | undefined, shiftKey = false): KeyLike =>
      press(k, { ctrlKey: true, shiftKey }, c);
    expect(matchShortcut(e('Tab', undefined), false, win, false)).not.toBeNull();
    expect(matchShortcut(e('Tab', undefined, true), false, win, false)).not.toBeNull();
    expect(matchShortcut(e('!', 'Digit1', true), false, win, false)?.code).toBe('Digit1');
    expect(matchShortcut(e('1', 'Digit1'), false, win, false)?.code).toBeUndefined();
  });

  it('Ctrl+Shift+Tab is the previous tab when WebKitGTK reports key "Unidentified" (Linux X11)', () => {
    const win = shortcutTable(false);
    const gtk = press('Unidentified', { ctrlKey: true, shiftKey: true }, 'Tab');
    expect(matchShortcut(gtk, false, win, false)?.shift).toBe(true);
    expect(
      matchShortcut(press('Tab', { ctrlKey: true }, 'Tab'), false, win, false)?.shift,
    ).toBeUndefined();
    expect(
      matchShortcut(press('Unidentified', { ctrlKey: true }, 'KeyQ'), false, win, false),
    ).toBeNull();
  });

  it('the view tooltips and Refresh name a key', () => {
    expect(viewChoices.map((v) => v.label)).toEqual([
      expect.stringMatching(/^Icons \(.+\)$/),
      expect.stringMatching(/^List \(.+\)$/),
      expect.stringMatching(/^Details \(.+\)$/),
      expect.stringMatching(/^Gallery/),
    ]);
    expect(navActions.find((a) => a.key === 'refresh')?.label).toMatch(/^Refresh \((F5|⌘R)\)$/);
  });

  it('⇧⌘N / Ctrl+Shift+N makes a new folder from anywhere, not from a text field', () => {
    const nf = vi.spyOn(actions, 'newFolder').mockResolvedValue(undefined as never);
    void matchShortcut(press('N', { metaKey: true, shiftKey: true }), false, mac, true)?.run();
    expect(nf).toHaveBeenCalledTimes(1);
    expect(
      matchShortcut(press('n', { metaKey: true, shiftKey: true }), true, mac, true),
    ).toBeNull();
    const win = shortcutTable(false);
    expect(
      matchShortcut(press('N', { ctrlKey: true, shiftKey: true }), false, win, false),
    ).not.toBeNull();
    // ⌘N alone is still a new window, not a folder
    expect(matchShortcut(press('n', cmd), false, mac, true)?.shift).toBeUndefined();
    nf.mockRestore();
  });

  it('Find anything shows in folder on ⌘↩ on a Mac, Ctrl+↩ elsewhere', () => {
    const e = (mods: Partial<KeyLike>) => press('Enter', mods);
    expect(isRevealKey(e({ metaKey: true }), true)).toBe(true);
    expect(isRevealKey(e({ ctrlKey: true }), true)).toBe(false);
    expect(isRevealKey(e({}), true)).toBe(false);
    expect(isRevealKey(e({ ctrlKey: true }), false)).toBe(true);
    expect(isRevealKey(e({ metaKey: true }), false)).toBe(false);
  });
});

describe('menuCommandFor', () => {
  it('runs the same action as the chord the Mac menu took over', () => {
    const mac = shortcutTable(true);
    const chord = (k: string) => matchShortcut({ ...key(k), metaKey: true }, false, mac, true)?.run;
    expect(menuCommandFor('new-tab')).toBe(chord('t'));
    expect(menuCommandFor('new-window')).toBe(chord('n'));
    expect(menuCommandFor('close-tab')).toBe(chord('w'));
  });

  it('knows nothing else, not even what an object inherits', () => {
    expect(menuCommandFor('close-window')).toBeNull();
    expect(menuCommandFor('toString')).toBeNull();
    expect(menuCommandFor('')).toBeNull();
  });
});

// Plan 19 Phase 2: the window table is the host's set plus the "I'm coming from" style's set.
describe('the table follows the "coming from" style (plan 19, 2.2)', () => {
  const OS = ['windows', 'mac', 'linux'] as const;
  type Os = (typeof OS)[number];
  afterEach(() => {
    comingFrom.choice = 'native';
    vi.unstubAllGlobals();
  });

  /** A table chord ("Ctrl+Shift+Z") as the keydown the host sends: Ctrl is ⌘ on a Mac. */
  const pressOn = (chord: string, host: Os): KeyLike => {
    const parts = chord.split('+');
    const k = parts.pop() ?? '';
    const has = (m: string) => parts.includes(m);
    const mac = host === 'mac';
    return {
      key: k.length === 1 ? k.toLowerCase() : k,
      code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^\d$/.test(k) ? `Digit${k}` : undefined,
      ctrlKey: has('Control') || (!mac && has('Ctrl')),
      metaKey: mac && has('Ctrl'),
      altKey: has('Alt'),
      shiftKey: has('Shift'),
    };
  };
  /** The keydown that a table entry is written for, on this host. */
  const eventFor = (s: Shortcut, mac: boolean): KeyLike => {
    const primaryIsMeta = mac && s.meta === undefined && !s.keepCtrl;
    return {
      key: s.key,
      code: s.code,
      ctrlKey: primaryIsMeta ? false : !!s.ctrl,
      metaKey: primaryIsMeta ? !!s.ctrl : !!s.meta,
      altKey: !!s.alt,
      shiftKey: !!s.shift,
    };
  };
  const RESERVED = new Set(['nextTab', 'prevTab', 'viewIcons', 'viewList', 'viewDetails']);

  it('every hint a menu shows is bound, under every (host, style)', () => {
    for (const host of OS)
      for (const style of OS) {
        const table = shortcutTable(host === 'mac', style);
        for (const cmd of Object.keys(PLATFORM_CHORDS) as (keyof typeof PLATFORM_CHORDS)[]) {
          if (RESERVED.has(cmd)) continue; // host column: covered by the host tests above
          const chord = platformChord(cmd, style, host);
          if (chord === 'F5') continue; // the list's own key, not the window table's
          expect(
            matchShortcut(pressOn(chord, host), false, table, host === 'mac'),
            `${host}/${style}/${cmd} ${chord}`,
          ).not.toBeNull();
        }
      }
  });

  it('no two entries in one table answer the same key, in all 9 tables', () => {
    for (const host of OS)
      for (const style of OS) {
        const mac = host === 'mac';
        const table = shortcutTable(mac, style);
        for (const s of table) {
          const hits = table.filter((t) => matchShortcut(eventFor(s, mac), false, [t], mac));
          expect(hits.length, `${host}/${style} ${s.key}`).toBe(1);
        }
      }
  });

  it('Backspace alone is Back in all 9 tables', () => {
    const back = vi.spyOn(tabs.active, 'back').mockImplementation(() => {});
    for (const host of OS)
      for (const style of OS) {
        const hit = matchShortcut(
          pressOn('Backspace', host),
          false,
          shortcutTable(host === 'mac', style),
          host === 'mac',
        );
        void hit?.run();
      }
    expect(back).toHaveBeenCalledTimes(9);
    back.mockRestore();
  });

  it('a style adds keys, never removes the host’s own', () => {
    for (const style of OS) {
      const mac = shortcutTable(true, style);
      const pc = shortcutTable(false, style);
      expect(matchShortcut(pressOn('Ctrl+[', 'mac'), false, mac, true), style).not.toBeNull();
      expect(matchShortcut(pressOn('Ctrl+Shift+Z', 'mac'), false, mac, true)).not.toBeNull();
      expect(matchShortcut(pressOn('Ctrl+Y', 'windows'), false, pc, false)).not.toBeNull();
      expect(matchShortcut(pressOn('Alt+ArrowLeft', 'windows'), false, pc, false)).not.toBeNull();
    }
    // and only Mac style brings Finder's set to a PC
    const winOnPc = shortcutTable(false, 'windows');
    expect(matchShortcut(pressOn('Ctrl+[', 'windows'), false, winOnPc, false)).toBeNull();
  });

  it('a Linux host never matches Ctrl+Alt+Backspace, whatever the style', () => {
    for (const style of OS) {
      const press = { key: 'Backspace', ctrlKey: true, altKey: true, shiftKey: false };
      expect(matchShortcut(press, false, shortcutTable(false, style), false)).toBeNull();
    }
  });

  it('AltGr (ctrl+alt with AltGraph) matches nothing on Windows and Linux', () => {
    const table = shortcutTable(false, 'mac');
    const ctrlAltI = { key: 'i', code: 'KeyI', ctrlKey: true, altKey: true, shiftKey: false };
    expect(matchShortcut(ctrlAltI, false, table, false)).not.toBeNull(); // real Ctrl+Alt+I
    const altGr = { ...ctrlAltI, getModifierState: (k: string) => k === 'AltGraph' };
    expect(matchShortcut(altGr, false, table, false)).toBeNull();
    // every chord in the table, pressed through AltGr, is refused
    for (const s of table) {
      const e = {
        ...eventFor(s, false),
        ctrlKey: true,
        altKey: true,
        getModifierState: altGr.getModifierState,
      };
      expect(matchShortcut(e, false, table, false), s.key).toBeNull();
    }
  });

  it('a Settings flip changes the table in force with no restart (memo keyed by style)', () => {
    const back = vi.spyOn(tabs.active, 'back').mockImplementation(() => {});
    const ctrlBracket = { key: '[', ctrlKey: true, altKey: false, shiftKey: false };
    comingFrom.choice = 'windows';
    expect(matchShortcut(ctrlBracket, false)).toBeNull();
    comingFrom.choice = 'mac';
    void matchShortcut(ctrlBracket, false)?.run();
    expect(back).toHaveBeenCalledTimes(1);
    expect(currentShortcuts()).toBe(currentShortcuts()); // not rebuilt per key
    comingFrom.choice = 'native'; // nothing injected: the host is Windows
    expect(matchShortcut(ctrlBracket, false)).toBeNull();
    back.mockRestore();
  });
});

describe('snap keys per host and style (plan 20.3.1)', () => {
  const OS = ['windows', 'mac', 'linux'] as const;
  const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
  const press = (
    k: string,
    m: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }>,
  ): KeyLike => ({
    key: k,
    ctrlKey: m.ctrl ?? false,
    altKey: m.alt ?? false,
    shiftKey: m.shift ?? false,
    metaKey: m.meta ?? false,
  });

  it('binds ⌃⌥ + arrows only on a Mac coming from Windows, in all 9 tables', async () => {
    const { snapWindow } = await import('$lib/api/window');
    for (const host of OS)
      for (const style of OS) {
        const mac = host === 'mac';
        const table = shortcutTable(mac, style, host === 'linux');
        const on = mac && style === 'windows';
        ARROWS.forEach((arrow, i) => {
          const hit = matchShortcut(press(arrow, { ctrl: true, alt: true }), false, table, mac);
          const isSnap = hit !== null && hit.keepCtrl === true && hit.alt === true;
          expect(isSnap, `${host}/${style} ⌃⌥${arrow}`).toBe(on);
          if (on && hit) {
            vi.mocked(snapWindow).mockClear();
            hit.run();
            expect(snapWindow).toHaveBeenCalledWith(['left', 'right', 'up', 'down'][i]);
          }
        });
      }
  });

  it('never answers ⌃←, ⌘←, ⌃⌥⌘← or ⇧⌃⌥← as a snap', () => {
    for (const style of OS) {
      const table = shortcutTable(true, style);
      for (const arrow of ARROWS)
        for (const m of [
          { ctrl: true },
          { meta: true },
          { ctrl: true, alt: true, meta: true },
          { ctrl: true, alt: true, shift: true },
        ]) {
          const hit = matchShortcut(press(arrow, m), false, table, true);
          expect(
            hit?.keepCtrl === true && hit.alt === true,
            `${style} ${arrow} ${JSON.stringify(m)}`,
          ).toBe(false);
        }
    }
  });

  it('names the keys ⌃⌥← / ⌃⌥→ / ⌃⌥↑ / ⌃⌥↓ where they are bound, nothing elsewhere', async () => {
    const { snapHint, snapKeysOn } = await import('$lib/utils/key-label');
    expect(
      ['left', 'right', 'up', 'down'].map((k) => snapHint(k as 'left', 'windows', 'mac')),
    ).toEqual(['⌃⌥←', '⌃⌥→', '⌃⌥↑', '⌃⌥↓']);
    for (const host of OS)
      for (const style of OS) {
        const on = host === 'mac' && style === 'windows';
        expect(snapKeysOn(style, host), `${host}/${style}`).toBe(on);
        expect(snapHint('left', style, host) === undefined, `${host}/${style}`).toBe(!on);
      }
  });
});

describe('text undo belongs to the text field (plan 15 E.1.9)', () => {
  const field = (tagName: string, isContentEditable = false) => ({
    tagName,
    isContentEditable,
    closest: () => null,
  });
  const list = field('DIV');
  const pc = (k: string, shift = false) => ({
    key: k,
    ctrlKey: true,
    altKey: false,
    shiftKey: shift,
  });
  const cmd = (k: string, shift = false) => ({ ...pc(k, shift), ctrlKey: false, metaKey: true });
  const hosts = [
    {
      host: 'windows',
      mac: false,
      table: shortcutTable(false, 'windows', false),
      undo: pc('z'),
      redo: pc('y'),
    },
    {
      host: 'linux',
      mac: false,
      table: shortcutTable(false, 'windows', true),
      undo: pc('z'),
      redo: pc('y'),
    },
    {
      host: 'mac',
      mac: true,
      table: shortcutTable(true, 'mac', false),
      undo: cmd('z'),
      redo: cmd('z', true),
    },
  ];

  it.each(hosts)('$host: undo and redo stand down in a text field, run in the list', (h) => {
    for (const f of [field('INPUT'), field('TEXTAREA'), field('DIV', true)]) {
      expect(shortcutFor(h.undo, f, h.table, h.mac)).toBeNull();
      expect(shortcutFor(h.redo, f, h.table, h.mac)).toBeNull();
    }
    expect(shortcutFor(h.undo, list, h.table, h.mac)).not.toBeNull();
    expect(shortcutFor(h.redo, list, h.table, h.mac)).not.toBeNull();
  });
});

describe('zoom in with a shifted plus (plan 15 E.1.8)', () => {
  const zoomIn = (e: KeyLike, mac: boolean) => matchShortcut(e, false, shortcuts, mac)?.key;
  const chord = (k: string, shift: boolean, mac: boolean): KeyLike => ({
    key: k,
    ctrlKey: !mac,
    metaKey: mac,
    altKey: false,
    shiftKey: shift,
  });

  it.each([true, false])('matches "+" with Shift held (mac: %s)', (mac) => {
    expect(zoomIn(chord('+', true, mac), mac)).toBe('+');
  });

  it.each([true, false])('still matches "=" and "+" without Shift (mac: %s)', (mac) => {
    expect(zoomIn(chord('=', false, mac), mac)).toBe('=');
    expect(zoomIn(chord('+', false, mac), mac)).toBe('+');
  });

  it('does not match "=" with Shift alone, or with Shift but no Ctrl/Cmd', () => {
    expect(matchShortcut(key('=', { shift: true }), false, shortcuts, false)).toBeNull();
    expect(zoomIn(chord('=', true, false), false)).toBeUndefined();
  });

  it('leaves a real shifted chord alone: Ctrl+Shift+T still reopens a tab', () => {
    const e = { ...key('t', { ctrl: true, shift: true }), metaKey: false };
    expect(matchShortcut(e, false, shortcuts, false)?.key).toBe('t');
  });

  // measured on a Mac WKWebView (plan 15 E): a ⌘ chord reports the UNshifted key, so ⇧⌘= is "="
  const probe = (k: string, code: string, meta: boolean, shift: boolean): KeyLike => ({
    key: k,
    code,
    ctrlKey: false,
    metaKey: meta,
    altKey: false,
    shiftKey: shift,
  });

  it('zooms in on the probed Mac ⇧⌘= (key "=", code Equal, meta, shift)', () => {
    expect(zoomIn(probe('=', 'Equal', true, true), true)).toBe('=');
  });

  it('zooms in on the probed Mac ⌘= and out on ⌘-', () => {
    expect(zoomIn(probe('=', 'Equal', true, false), true)).toBe('=');
    expect(zoomIn(probe('-', 'Minus', true, false), true)).toBe('-');
  });

  it('does nothing for the probed ⇧= alone (key "+", no ⌘)', () => {
    expect(matchShortcut(probe('+', 'Equal', false, true), false, shortcuts, true)).toBeNull();
  });

  it('keeps ⇧⌘T as reopen tab on a Mac', () => {
    expect(zoomIn(probe('t', 'KeyT', true, true), true)).toBe('t');
  });

  it('does not zoom out on ⇧⌘- (Shift stays a modifier for minus)', () => {
    expect(zoomIn(probe('-', 'Minus', true, true), true)).not.toBe('-');
  });
});

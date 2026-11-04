// Plan 08 A1: every command and palette action has a keyboard chord under every "I'm coming
// from" style on every host — or sits on the allow-list with its reason — and the chord its
// hint names is one the window table really binds, to that action, shadowed by nothing.
import { describe, expect, it, vi } from 'vitest';
import type { KeyLike, Shortcut } from './shortcuts';

vi.mock('$lib/api/window', () => ({ close: vi.fn() }));
vi.mock('$lib/api/fs', () => ({}));
vi.mock('$lib/api/shell', () => ({}));
vi.mock('$lib/api/transfer', () => ({}));
vi.mock('$lib/api/clipboard', () => ({}));
vi.mock('$lib/api/pty', () => ({}));

const { matchShortcut, shortcutTable } = await import('./shortcuts');
const { paletteActions } = await import('./palette-actions');
const { paletteActionRunners } = await import('./palette-action-runners');
const { newCommand, filterCommand, commandTrailing } = await import('./command-actions');
const { ACTION_CHORDS, CHORD_FREE, COMMAND_ACTIONS, LIST_OWNED, actionChord, actionHint } =
  await import('./action-chords');

const OS = ['windows', 'mac', 'linux'] as const;
type Os = (typeof OS)[number];
const COMBOS = OS.flatMap((host) => OS.map((style) => ({ host, style })));

const tableOn = (host: Os, style: Os) => shortcutTable(host === 'mac', style, host === 'linux');

const CODES: Record<string, string> = { '`': 'Backquote', '.': 'Period', ',': 'Comma' };
const SHIFTED: Record<string, string> = { '`': '~', '.': '>', ',': '<' };
const codeOf = (key: string): string | undefined =>
  /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : CODES[key];

/** The keydown a chord string ("Ctrl+Shift+H", "Control+Alt+Ctrl+1") sends on a host. */
const press = (chord: string, host: Os): KeyLike => {
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  const shift = parts.includes('Shift');
  const mac = host === 'mac';
  return {
    key: shift ? (SHIFTED[key] ?? key.toUpperCase()) : key,
    code: codeOf(key),
    ctrlKey: mac ? parts.includes('Control') : parts.includes('Ctrl') || parts.includes('Control'),
    metaKey: mac && parts.includes('Ctrl'),
    altKey: parts.includes('Alt'),
    shiftKey: shift,
  };
};

/** The keydown that a table row itself describes, drawn for the host (the Ctrl is ⌘ on a Mac). */
const pressRow = (s: Shortcut, mac: boolean): KeyLike => {
  const primaryIsMeta = mac && s.meta === undefined && !s.keepCtrl;
  return {
    key: s.key,
    code: s.code ?? s.orCode ?? codeOf(s.key),
    ctrlKey: primaryIsMeta ? false : (s.ctrl ?? false),
    metaKey: primaryIsMeta ? (s.ctrl ?? false) : (s.meta ?? false),
    altKey: s.alt ?? false,
    shiftKey: s.shift ?? false,
  };
};

/** Every command and palette action, by the key the allow-list uses. */
const commandKeys = [newCommand, filterCommand, ...commandTrailing]
  .filter((c) => c.kind !== 'divider')
  .map((c) => c.key);
const actionKeys = paletteActions.map((a) => a.key);

describe('every command and palette action has a chord (plan 08 A1)', () => {
  it('each palette action has a chord under every (host, style), or a reason on the allow-list', () => {
    const missing: string[] = [];
    for (const key of actionKeys) {
      if (key in CHORD_FREE) continue;
      for (const { host, style } of COMBOS)
        if (actionChord(key, style, host) === null) missing.push(`${key} ${host}/${style}`);
    }
    expect(missing).toEqual([]);
  });

  it('each toolbar command runs a chorded action, or has a reason on the allow-list', () => {
    for (const key of commandKeys) {
      if (`command:${key}` in CHORD_FREE) continue;
      const action = COMMAND_ACTIONS[key];
      expect(action, `command ${key} has no chord and no allow-list reason`).toBeDefined();
      expect(ACTION_CHORDS[action], key).toBeDefined();
    }
  });

  it('the allow-list names real actions, gives a reason each, and holds none that has a chord', () => {
    for (const [key, reason] of Object.entries(CHORD_FREE)) {
      const real = key.startsWith('command:')
        ? commandKeys.includes(key.slice('command:'.length))
        : actionKeys.includes(key);
      expect(real, `${key} is on the allow-list but is no action`).toBe(true);
      expect(reason.length, key).toBeGreaterThan(20);
      expect(ACTION_CHORDS[key], `${key} has a chord AND an allow-list entry`).toBeUndefined();
    }
  });

  it('the chord table names only real palette actions, each with a runner', () => {
    for (const key of Object.keys(ACTION_CHORDS)) {
      expect(actionKeys, key).toContain(key);
      expect(paletteActionRunners[key], key).toBeDefined();
    }
  });

  it('each window chord a hint names reaches its own action in the window table', () => {
    const wrong: string[] = [];
    for (const { host, style } of COMBOS) {
      const table = tableOn(host, style);
      for (const key of Object.keys(ACTION_CHORDS)) {
        if (LIST_OWNED.has(key)) continue;
        const chord = actionChord(key, style, host) as string;
        const hit = matchShortcut(press(chord, host), false, table, host === 'mac');
        if (hit?.id !== key)
          wrong.push(`${host}/${style} ${key} ${chord} → ${hit?.id ?? 'nothing'}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the list-owned chords (Ctrl+X/C/V/A, F2) are not ALSO window chords, which would run twice', () => {
    for (const { host, style } of COMBOS) {
      const table = tableOn(host, style);
      for (const key of LIST_OWNED) {
        const chord = actionChord(key, style, host) as string;
        expect(matchShortcut(press(chord, host), false, table, host === 'mac'), key).toBeNull();
      }
      // the list answers Ctrl (⌘) + A/X/C/V with any other modifier too (Ctrl+Shift+C is Copy as path)
      for (const s of table)
        expect(['a', 'x', 'c', 'v'].includes(s.key.toLowerCase()) && s.ctrl && !s.keepCtrl).toBe(
          false,
        );
    }
  });
});

describe('no two actions share a chord', () => {
  it('within a (host, style), no two palette actions print the same chord', () => {
    for (const { host, style } of COMBOS) {
      const seen = new Map<string, string>();
      for (const key of Object.keys(ACTION_CHORDS)) {
        const chord = actionChord(key, style, host) as string;
        expect(
          seen.get(chord),
          `${host}/${style}: ${key} and ${seen.get(chord)} share ${chord}`,
        ).toBe(undefined);
        seen.set(chord, key);
      }
    }
  });

  it('every row of every window table is reachable by its own chord: none shadows another', () => {
    const shadowed: string[] = [];
    for (const { host, style } of COMBOS) {
      const table = tableOn(host, style);
      for (const s of table) {
        const hit = matchShortcut(pressRow(s, host === 'mac'), false, table, host === 'mac');
        if (hit !== s)
          shadowed.push(`${host}/${style} ${JSON.stringify({ ...s, run: undefined })}`);
      }
    }
    expect(shadowed).toEqual([]);
  });
});

/** Each system's reserved keys, as the host's keyboard sends them. */
const RESERVED: Record<Os, [string, KeyLike][]> = {
  windows: [
    ['Alt+F4', { key: 'F4', ctrlKey: false, altKey: true, shiftKey: false }],
    ['Alt+Tab', { key: 'Tab', code: 'Tab', ctrlKey: false, altKey: true, shiftKey: false }],
    ['Ctrl+Esc', { key: 'Escape', ctrlKey: true, altKey: false, shiftKey: false }],
    ['Ctrl+Shift+Esc', { key: 'Escape', ctrlKey: true, altKey: false, shiftKey: true }],
    ['Ctrl+Alt+Delete', { key: 'Delete', ctrlKey: true, altKey: true, shiftKey: false }],
    [
      'Win+E',
      { key: 'e', code: 'KeyE', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true },
    ],
    [
      'Win+D',
      { key: 'd', code: 'KeyD', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true },
    ],
    [
      'Win+H',
      { key: 'h', code: 'KeyH', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true },
    ],
    [
      'Win+Shift+M',
      { key: 'M', code: 'KeyM', ctrlKey: false, altKey: false, shiftKey: true, metaKey: true },
    ],
    [
      'Win+Shift+S',
      { key: 'S', code: 'KeyS', ctrlKey: false, altKey: false, shiftKey: true, metaKey: true },
    ],
  ],
  mac: [
    [
      '⌘Q',
      { key: 'q', code: 'KeyQ', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
    ],
    [
      '⌘H',
      { key: 'h', code: 'KeyH', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
    ],
    [
      '⌥⌘H',
      { key: '˙', code: 'KeyH', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false },
    ],
    [
      '⌘M',
      { key: 'm', code: 'KeyM', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
    ],
    [
      '⌘Tab',
      { key: 'Tab', code: 'Tab', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
    ],
    [
      '⌘Space',
      { key: ' ', code: 'Space', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
    ],
    ['⌥⌘Esc', { key: 'Escape', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }],
    [
      '⌘`',
      {
        key: '`',
        code: 'Backquote',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
    ],
    [
      '⇧⌘`',
      { key: '~', code: 'Backquote', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
    ],
    [
      '⇧⌘3',
      { key: '#', code: 'Digit3', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
    ],
    [
      '⇧⌘4',
      { key: '$', code: 'Digit4', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
    ],
    [
      '⇧⌘5',
      { key: '%', code: 'Digit5', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
    ],
    ...(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const).map(
      (key): [string, KeyLike] => [
        `⌃${key}`,
        { key, metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      ],
    ),
  ],
  linux: [
    ['Ctrl+Alt+T', { key: 't', code: 'KeyT', ctrlKey: true, altKey: true, shiftKey: false }],
    ['Alt+F2', { key: 'F2', ctrlKey: false, altKey: true, shiftKey: false }],
    ['Alt+F4', { key: 'F4', ctrlKey: false, altKey: true, shiftKey: false }],
    ['Alt+Tab', { key: 'Tab', code: 'Tab', ctrlKey: false, altKey: true, shiftKey: false }],
    ['Ctrl+Alt+Delete', { key: 'Delete', ctrlKey: true, altKey: true, shiftKey: false }],
    ['Ctrl+Alt+Backspace', { key: 'Backspace', ctrlKey: true, altKey: true, shiftKey: false }],
    [
      'Super+A',
      { key: 'a', code: 'KeyA', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true },
    ],
    ...(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const).map(
      (key): [string, KeyLike] => [
        `Ctrl+Alt+${key}`,
        { key, ctrlKey: true, altKey: true, shiftKey: false },
      ],
    ),
  ],
};

describe('no chord takes a key the system reserves', () => {
  it('no window table answers a reserved key of its host, under any style', () => {
    const taken: string[] = [];
    for (const { host, style } of COMBOS)
      for (const [name, e] of RESERVED[host]) {
        const hit = matchShortcut(e, false, tableOn(host, style), host === 'mac');
        if (hit !== null) taken.push(`${host}/${style} ${name}`);
      }
    expect(taken).toEqual([]);
  });

  it('the Super / Win key never takes part in a PC chord', () => {
    for (const host of ['windows', 'linux'] as const)
      for (const style of OS)
        for (const s of tableOn(host, style))
          expect(s.meta === true, JSON.stringify(s.key)).toBe(false);
  });
});

describe('the hints the palette rows print', () => {
  it('names the chord drawn for the host keyboard', () => {
    expect(actionHint('open-home', 'mac', 'mac')).toBe('⇧⌘H');
    expect(actionHint('open-home', 'windows', 'windows')).toBe('Ctrl+Shift+H');
    expect(actionHint('open-home', 'linux', 'linux')).toBe('Alt+Home');
    expect(actionHint('sort-name', 'mac', 'mac')).toBe('⌃⌥⌘1');
    expect(actionHint('sort-name', 'mac', 'windows')).toBe('Ctrl+Alt+1');
    expect(actionHint('open-terminal', 'windows', 'mac')).toBe('⌃⇧`');
    expect(actionHint('view-gallery', 'windows', 'windows')).toBe('Ctrl+Shift+9');
    expect(actionHint('toggle-hidden', 'windows', 'windows')).toBe('Ctrl+Shift+.');
    expect(actionHint('cascade-windows', 'windows', 'windows')).toBeUndefined();
  });
});

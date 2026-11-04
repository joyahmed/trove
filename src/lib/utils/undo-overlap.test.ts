import { describe, expect, it } from 'vitest';
import type { UndoKind, UndoRecord } from '$lib/types/undo';
import {
  blockedText,
  blockerOf,
  entryTitle,
  firstTouch,
  pathsTouch,
  recordPaths,
  type OverlapEntry,
} from './undo-overlap';

const linux = { os: 'linux', thisPcLabel: 'Computer' };
const windows = { os: 'windows', thisPcLabel: 'This PC' };

/** One record of each kind, all touching `p`. */
const recordOf = (kind: UndoKind, p: string): UndoRecord => {
  switch (kind) {
    case 'rename':
      return { kind, from: p, to: `${p}-renamed` };
    case 'move':
      return { kind, pairs: [{ from: p, to: `/elsewhere/${p.split('/').at(-1)}` }] };
    case 'copy':
      return { kind, created: [p] };
    case 'trash':
    case 'deleteForever':
      return { kind, paths: [p] };
    case 'newFolder':
      return { kind, path: p };
    case 'newFile':
      return { kind, path: p, baseName: 'n', ext: 'txt' };
    case 'other':
      return { kind, reason: 'a Replace' };
  }
};

const KINDS: UndoKind[] = [
  'rename',
  'move',
  'copy',
  'trash',
  'deleteForever',
  'newFolder',
  'newFile',
  'other',
];

const e = (label: string, record: UndoRecord | null): OverlapEntry => ({ label, record });

describe('recordPaths', () => {
  it('lists what each kind touches; an `other` is unknown', () => {
    expect(recordPaths({ kind: 'rename', from: '/a', to: '/b' })).toEqual(['/a', '/b']);
    expect(recordPaths({ kind: 'move', pairs: [{ from: '/a', to: '/d/a' }] })).toEqual([
      '/a',
      '/d/a',
    ]);
    expect(recordPaths({ kind: 'copy', created: ['/d/a'], sources: ['/a'] })).toEqual(['/d/a']);
    expect(recordPaths({ kind: 'trash', paths: ['/a'] })).toEqual(['/a']);
    expect(recordPaths({ kind: 'newFolder', path: '/n' })).toEqual(['/n']);
    expect(recordPaths({ kind: 'other', reason: 'x' })).toBeNull();
  });
});

describe('pathsTouch', () => {
  it('same path, nested either way, and not a sibling with a common prefix', () => {
    expect(pathsTouch('/a/b', '/a/b', linux)).toBe(true);
    expect(pathsTouch('/a/b/', '/a/b', linux)).toBe(true);
    expect(pathsTouch('/a', '/a/b/c', linux)).toBe(true);
    expect(pathsTouch('/a/b/c', '/a', linux)).toBe(true);
    expect(pathsTouch('/a/b', '/a/bc', linux)).toBe(false);
    expect(pathsTouch('/a/b', '/a/c', linux)).toBe(false);
    expect(pathsTouch('', '/a', linux)).toBe(false);
  });

  it('folds case and slashes on Windows only', () => {
    expect(pathsTouch('C:\\Docs\\Report.txt', 'c:/docs/report.TXT', windows)).toBe(true);
    expect(pathsTouch('C:\\Docs', 'c:\\docs\\inner\\x.txt', windows)).toBe(true);
    expect(pathsTouch('/a/Report.txt', '/a/report.txt', linux)).toBe(false);
  });

  it('firstTouch gives the later path that hits, or null', () => {
    expect(firstTouch(['/a', '/b'], ['/c', '/b/x'], linux)).toBe('/b/x');
    expect(firstTouch(['/a'], ['/c'], linux)).toBeNull();
  });
});

describe('blockerOf', () => {
  it('every kind against every kind on the same path: blocked (8×8)', () => {
    for (const older of KINDS)
      for (const newer of KINDS) {
        const entries = [e('Old', recordOf(older, '/w/f')), e('New', recordOf(newer, '/w/f'))];
        expect(blockerOf(entries, 0, linux), `${older} under ${newer}`).toEqual({
          index: 1,
          path: older === 'other' || newer === 'other' ? null : '/w/f',
          more: 0,
        });
      }
  });

  it('every kind against every kind on other paths: free unless one is an `other` (8×8)', () => {
    for (const older of KINDS)
      for (const newer of KINDS) {
        const entries = [e('Old', recordOf(older, '/w/f')), e('New', recordOf(newer, '/z/g'))];
        const got = blockerOf(entries, 0, linux);
        if (older === 'other' || newer === 'other')
          expect(got, `${older} under ${newer}`).toEqual({ index: 1, path: null, more: 0 });
        else expect(got, `${older} under ${newer}`).toBeNull();
      }
  });

  it('a later change inside a renamed folder blocks the rename', () => {
    const entries = [
      e('Rename', { kind: 'rename', from: '/w/old', to: '/w/new' }),
      e('Move', { kind: 'move', pairs: [{ from: '/w/new/a.txt', to: '/x/a.txt' }] }),
    ];
    expect(blockerOf(entries, 0, linux)).toEqual({ index: 1, path: '/w/new/a.txt', more: 0 });
  });

  it('Windows case folding makes a blocker', () => {
    const entries = [
      e('Rename', { kind: 'rename', from: 'C:\\W\\a.txt', to: 'C:\\W\\B.txt' }),
      e('Delete', { kind: 'trash', paths: ['c:\\w\\b.TXT'] }),
    ];
    expect(blockerOf(entries, 0, windows)?.index).toBe(1);
    expect(blockerOf(entries, 0, linux)).toBeNull();
  });

  it('names the NEWEST later blocker and counts the rest; untouched entries do not count', () => {
    const entries = [
      e('New folder', { kind: 'newFolder', path: '/w/n' }),
      e('Copy', { kind: 'copy', created: ['/w/n/a'] }),
      e('Rename', { kind: 'rename', from: '/z/x', to: '/z/y' }),
      e('Move', { kind: 'move', pairs: [{ from: '/w/n', to: '/v/n' }] }),
    ];
    expect(blockerOf(entries, 0, linux)).toEqual({ index: 3, path: '/w/n', more: 1 });
    expect(blockerOf(entries, 2, linux)).toBeNull();
    expect(blockerOf(entries, 3, linux)).toBeNull();
    expect(blockerOf(entries, 9, linux)).toBeNull();
  });

  it('an entry with no record is unknown, so it blocks and is blocked', () => {
    const entries = [e('Rename', { kind: 'rename', from: '/a', to: '/b' }), e('Replace', null)];
    expect(blockerOf(entries, 0, linux)).toEqual({ index: 1, path: null, more: 0 });
  });
});

describe('entryTitle', () => {
  it('adds what the action acted on', () => {
    expect(entryTitle('Rename', { kind: 'rename', from: '/w/a.txt', to: '/w/b.txt' })).toBe(
      'Rename "a.txt"',
    );
    expect(
      entryTitle('Move', {
        kind: 'move',
        pairs: [
          { from: '/a', to: '/d/a' },
          { from: '/b', to: '/d/b' },
          { from: '/c', to: '/d/c' },
        ],
      }),
    ).toBe('Move 3 items');
    expect(entryTitle('Delete', { kind: 'trash', paths: ['/w/r.txt'] })).toBe('Delete "r.txt"');
    expect(entryTitle('New folder', { kind: 'newFolder', path: '/w/n' })).toBe('New folder "n"');
    expect(entryTitle('Copy', { kind: 'copy', created: [] })).toBe('Copy');
    expect(entryTitle('Replace', { kind: 'other', reason: 'x' })).toBe('Replace');
    expect(entryTitle('Replace', null)).toBe('Replace');
  });
});

describe('blockedText', () => {
  it('names the blocker, what it did, and how many more stand in the way', () => {
    const move = e('Move', {
      kind: 'move',
      pairs: [
        { from: '/w/report.txt', to: '/x/report.txt' },
        { from: '/w/b', to: '/x/b' },
        { from: '/w/c', to: '/x/c' },
      ],
    });
    expect(blockedText(move, { index: 3, path: '/w/report.txt', more: 0 })).toBe(
      'Undo Move 3 items first — it moved report.txt',
    );
    expect(blockedText(move, { index: 3, path: '/w/report.txt', more: 2 })).toBe(
      'Undo Move 3 items first — it moved report.txt (and 2 more newer actions)',
    );
    expect(blockedText(move, { index: 3, path: '/w/report.txt', more: 1 })).toBe(
      'Undo Move 3 items first — it moved report.txt (and 1 more newer action)',
    );
  });

  it('says whose files are unknown', () => {
    const folder = e('New folder', { kind: 'newFolder', path: '/w/n' });
    const replace = e('Replace', { kind: 'other', reason: 'x' });
    expect(
      blockedText(folder, { index: 1, path: null, more: 0 }, { kind: 'other', reason: 'x' }),
    ).toBe(`Undo New folder "n" first — Trove can't tell which files this one touched`);
    expect(
      blockedText(replace, { index: 1, path: null, more: 0 }, { kind: 'trash', paths: ['/a'] }),
    ).toBe(`Undo Replace first — Trove can't tell which files it touched`);
  });
});

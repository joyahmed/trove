import { describe, expect, it } from 'vitest';
import type { SavedUndo, UndoRecord } from '$lib/types/undo';
import { readRecord, sanitizeUndoLog, serializeUndoLog, UNDO_LOG_CAP } from './undo-records';

const saved = (record: UndoRecord, at = 1): SavedUndo => ({ label: 'X', at, record });

const every: UndoRecord[] = [
  { kind: 'rename', from: '/p/a.txt', to: '/p/b.txt' },
  { kind: 'newFolder', path: '/p/New folder' },
  { kind: 'newFile', path: '/p/New Text Document.txt', baseName: 'New Text Document', ext: 'txt' },
  { kind: 'trash', paths: ['/p/a', '/p/b'] },
  { kind: 'move', pairs: [{ from: '/p/a', to: '/q/a' }] },
  { kind: 'copy', created: ['/q/a'], sources: ['/p/a'], destination: '/q' },
  { kind: 'copy', created: ['/p/a.zip'] },
  { kind: 'deleteForever', paths: ['/p/a'] },
  { kind: 'other', reason: 'a cancelled copy' },
];

describe('undo records', () => {
  it('every kind survives serialize → JSON → sanitize unchanged', () => {
    const entries = every.map((r, i) => ({ ...saved(r, i), what: `w${i}`, folder: '/p' }));
    const text = JSON.stringify(serializeUndoLog(entries));
    expect(sanitizeUndoLog(JSON.parse(text))).toEqual(entries);
  });

  it('a corrupt or foreign file is an empty history', () => {
    for (const raw of [null, 'x', 42, [], {}, { version: 2, entries: [] }, { version: 1 }])
      expect(sanitizeUndoLog(raw)).toEqual([]);
  });

  it('drops unknown kinds and bad shapes, keeps the good ones in order', () => {
    const good = saved({ kind: 'newFolder', path: '/p/n' }, 5);
    const raw = {
      version: 1,
      entries: [
        { label: 'X', at: 1, record: { kind: 'format-disk', path: '/' } },
        { label: 'X', at: 1, record: { kind: 'rename', from: '/a' } },
        { label: 'X', at: 1, record: { kind: 'rename', from: '', to: '/b' } },
        { label: 'X', at: 1, record: { kind: 'trash', paths: [] } },
        { label: 'X', at: 1, record: { kind: 'trash', paths: ['/a', 7] } },
        { label: 'X', at: 1, record: { kind: 'move', pairs: [{ from: '/a' }] } },
        { label: 'X', at: 1, record: { kind: 'copy', created: ['/a'], sources: ['/b'] } },
        { label: 'X', at: 1, record: { kind: 'toString' } },
        { label: '', at: 1, record: { kind: 'newFolder', path: '/n' } },
        { label: 'X', at: 'now', record: { kind: 'newFolder', path: '/n' } },
        { label: 'X', at: 1, what: 3, record: { kind: 'newFolder', path: '/n' } },
        'junk',
        good,
      ],
    };
    expect(sanitizeUndoLog(raw)).toEqual([good]);
  });

  it('keeps known fields only', () => {
    expect(readRecord({ kind: 'rename', from: '/a', to: '/b', run: 'rm -rf /' })).toEqual({
      kind: 'rename',
      from: '/a',
      to: '/b',
    });
  });

  it('caps at N on write and on read, keeping the newest', () => {
    const many = Array.from({ length: UNDO_LOG_CAP + 7 }, (_, i) =>
      saved({ kind: 'newFolder', path: `/p/${i}` }, i),
    );
    const written = serializeUndoLog(many);
    expect(written.entries).toHaveLength(UNDO_LOG_CAP);
    expect(written.entries[0].at).toBe(7);
    const read = sanitizeUndoLog({ version: 1, entries: many });
    expect(read).toHaveLength(UNDO_LOG_CAP);
    expect(read.at(-1)?.at).toBe(UNDO_LOG_CAP + 6);
    expect(sanitizeUndoLog({ version: 1, entries: many }, 3).map((e) => e.at)).toEqual([
      54, 55, 56,
    ]);
  });
});

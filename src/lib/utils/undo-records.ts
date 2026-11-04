// The undo history's file form: building it from the live stack, and reading it back. The
// file is ours, but it is still input — a crash, a hand edit or an older build can leave
// anything there — so every entry is checked field by field and a bad one is dropped, never
// half-trusted. A record that would undo the wrong thing is worse than no record.
import type { MovedPair, SavedUndo, SavedUndoLog, UndoKind, UndoRecord } from '$lib/types/undo';

/** How many actions survive a restart (plan 08 F2 names none; 50 is what the lead set). */
export const UNDO_LOG_CAP = 50;

/** A record holding more paths than this is refused: no real action of Trove's needs it. */
export const MAX_RECORD_PATHS = 10_000;

const MAX_TEXT = 2_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isPath = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 32_767;

const isText = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT;

const paths = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length > 0 && v.length <= MAX_RECORD_PATHS && v.every(isPath)
    ? [...v]
    : null;

const pairs = (v: unknown): MovedPair[] | null =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= MAX_RECORD_PATHS &&
  v.every((p) => isObject(p) && isPath(p.from) && isPath(p.to))
    ? v.map((p: MovedPair) => ({ from: p.from, to: p.to }))
    : null;

/** Each kind's own reader: the record rebuilt from known fields only, or null when it is bad. */
const readers: { [K in UndoKind]: (r: Record<string, unknown>) => UndoRecord | null } = {
  rename: (r) =>
    isPath(r.from) && isPath(r.to) ? { kind: 'rename', from: r.from, to: r.to } : null,
  newFolder: (r) => (isPath(r.path) ? { kind: 'newFolder', path: r.path } : null),
  newFile: (r) =>
    isPath(r.path) && isText(r.baseName) && typeof r.ext === 'string' && r.ext.length <= 64
      ? { kind: 'newFile', path: r.path, baseName: r.baseName, ext: r.ext }
      : null,
  trash: (r) => {
    const p = paths(r.paths);
    return p ? { kind: 'trash', paths: p } : null;
  },
  move: (r) => {
    const p = pairs(r.pairs);
    return p ? { kind: 'move', pairs: p } : null;
  },
  copy: (r) => {
    const created = paths(r.created);
    if (!created) return null;
    const sources = r.sources === undefined ? undefined : paths(r.sources);
    if (sources === null) return null;
    if (r.destination !== undefined && !isPath(r.destination)) return null;
    // a redo needs both halves: one without the other is a bad record, not a partial one
    if ((sources === undefined) !== (r.destination === undefined)) return null;
    return sources && isPath(r.destination)
      ? { kind: 'copy', created, sources, destination: r.destination }
      : { kind: 'copy', created };
  },
  deleteForever: (r) => {
    const p = paths(r.paths);
    return p ? { kind: 'deleteForever', paths: p } : null;
  },
  other: (r) => (isText(r.reason) ? { kind: 'other', reason: r.reason } : null),
};

const isKind = (v: unknown): v is UndoKind => typeof v === 'string' && Object.hasOwn(readers, v);

/** One record, checked: null for an unknown kind or any field of the wrong shape. */
export const readRecord = (raw: unknown): UndoRecord | null =>
  isObject(raw) && isKind(raw.kind) ? readers[raw.kind](raw) : null;

/** One saved entry, checked; extra fields are dropped. */
export const readSaved = (raw: unknown): SavedUndo | null => {
  if (!isObject(raw) || !isText(raw.label)) return null;
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null;
  if (raw.what !== undefined && !isText(raw.what)) return null;
  if (raw.folder !== undefined && !isPath(raw.folder)) return null;
  const record = readRecord(raw.record);
  if (!record) return null;
  return {
    label: raw.label,
    at: raw.at,
    record,
    ...(raw.what === undefined ? {} : { what: raw.what as string }),
    ...(raw.folder === undefined ? {} : { folder: raw.folder as string }),
  };
};

/**
 * The file read back: the entries that pass, oldest first, the newest `cap` of them. Anything
 * that is not a version-1 log (missing, corrupt, another build's) is an empty history.
 */
export const sanitizeUndoLog = (raw: unknown, cap = UNDO_LOG_CAP): SavedUndo[] => {
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) return [];
  const good = raw.entries.map(readSaved).filter((e): e is SavedUndo => e !== null);
  return cap > 0 ? good.slice(-cap) : [];
};

/** The file to write: the newest `cap` entries, oldest first. */
export const serializeUndoLog = (entries: SavedUndo[], cap = UNDO_LOG_CAP): SavedUndoLog => ({
  version: 1,
  entries: cap > 0 ? entries.slice(-cap) : [],
});

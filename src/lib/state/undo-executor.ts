// A saved undo record (`types/undo.ts`) turned back into the undo it describes: the check that
// the disk still matches, and the step itself. Rename, New folder / file and Delete push their
// entries through here while Trove runs, so the undo a restart brings back is the same code as
// the one the action left. A copy or move keeps its job-aware entry (`transfers`) while it is
// live and comes through here only after a restart.
import * as fs from '$lib/api/fs';
import { restoreFromTrash } from '$lib/api/transfer';
import { confirm } from '$lib/state/confirm.svelte';
import { transfers } from '$lib/state/transfers.svelte';
import { BARRIER_MESSAGE, UndoBarrier, UndoDeclined, UndoRefused } from '$lib/state/undo.svelte';
import type { UndoEntry } from '$lib/state/undo.svelte';
import type { MovedPair, UndoRecord } from '$lib/types/undo';
import { recycleList } from '$lib/api/recycle';
import { noBinQuestion, noRecycleBin } from '$lib/utils/no-bin';
import { onMac } from '$lib/utils/platform';
import { nameOf, parentOf, samePath } from '$lib/utils/path';

export type UndoStep = 'undo' | 'redo';

/** The words an entry carries beside its record. */
export interface UndoMeta {
  label: string;
  what?: string;
  folder?: string;
  at?: number;
}

const quoted = (paths: string[]) =>
  paths.length === 1 ? `"${nameOf(paths[0])}"` : `${paths.length} items`;

const exists = async (path: string) => (await fs.pathKind(path)) !== 'missing';

/** Refuse unless every path is there: `"a.txt" is no longer there`. */
const mustExist = async (verb: string, paths: string[]) => {
  const gone: string[] = [];
  for (const p of paths) if (!(await exists(p))) gone.push(p);
  if (gone.length === 0) return;
  const why = `${quoted(gone)} ${gone.length === 1 ? 'is' : 'are'} no longer there`;
  throw new UndoRefused(`Can't ${verb} — ${why}`, why);
};

/** Refuse unless every path is free: `something named "a.txt" is already there`. */
const mustBeFree = async (verb: string, paths: string[]) => {
  const taken: string[] = [];
  for (const p of paths) if (await exists(p)) taken.push(p);
  if (taken.length === 0) return;
  const why =
    taken.length === 1
      ? `something named "${nameOf(taken[0])}" is already there`
      : `${taken.length} of the names are taken by something new`;
  throw new UndoRefused(`Can't ${verb} — ${why}`, why);
};

const froms = (pairs: MovedPair[]) => pairs.map((p) => p.from);
const tos = (pairs: MovedPair[]) => pairs.map((p) => p.to);

/**
 * Does the disk still match `record`, for this step? Throws `UndoRefused` naming what differs;
 * nothing is changed either way. A permanent delete throws `UndoBarrier`, an `other` refuses.
 */
export const checkWorld = async (record: UndoRecord, step: UndoStep): Promise<void> => {
  const verb = `${step} the ${record.kind === 'newFolder' || record.kind === 'newFile' ? 'new item' : record.kind}`;
  switch (record.kind) {
    case 'rename':
      if (step === 'undo') {
        await mustExist(verb, [record.to]);
        return mustBeFree(verb, [record.from]);
      }
      await mustExist(verb, [record.from]);
      return mustBeFree(verb, [record.to]);
    case 'newFolder':
    case 'newFile':
      // a redo makes the next free name, so only an undo has something to find
      if (step === 'undo') await mustExist(verb, [record.path]);
      return;
    case 'trash':
      // a restore puts each item back at its own path, which must be free; the bin has them
      return step === 'undo' ? mustBeFree(verb, record.paths) : mustExist(verb, record.paths);
    case 'move':
      if (step === 'undo') {
        await mustExist(verb, tos(record.pairs));
        return mustBeFree(verb, froms(record.pairs));
      }
      await mustExist(verb, froms(record.pairs));
      return mustBeFree(verb, tos(record.pairs));
    case 'copy':
      if (step === 'undo') return mustExist(verb, record.created);
      return record.sources ? mustExist(verb, record.sources) : undefined;
    case 'deleteForever':
      throw new UndoBarrier(BARRIER_MESSAGE);
    case 'other':
      throw new UndoRefused(`Can't ${step} this — ${record.reason}`, record.reason);
  }
};

/**
 * Remove what an action made: to the Recycle Bin, or — where the backend says there is none —
 * asked about and then deleted for good. A "no" throws `UndoDeclined`: nothing was removed.
 */
export const removeMade = async (paths: string[], what: string) => {
  let refused: fs.NoRecycleBin | null;
  try {
    return await fs.trashEntries(paths);
  } catch (e) {
    refused = noRecycleBin(e);
    if (!refused) throw e;
  }
  const ok = await confirm.ask({
    title: what.includes('folder')
      ? 'Delete Folder'
      : paths.length === 1
        ? 'Delete File'
        : 'Delete Items',
    message: noBinQuestion(refused, what),
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok)
    throw new UndoDeclined(
      `Undo cancelled — ${what} ${paths.length === 1 ? 'was' : 'were'} not deleted`,
    );
  await fs.deleteEntries(paths);
};

/** Items grouped by the folder they go to, with the name each lands under. */
const byFolder = (items: { send: string; land: string }[]) => {
  const groups = new Map<string, { paths: string[]; names: string[] }>();
  for (const { send, land } of items) {
    const folder = parentOf(land);
    if (folder === null) continue;
    const group = groups.get(folder) ?? { paths: [], names: [] };
    group.paths.push(send);
    group.names.push(nameOf(land));
    groups.set(folder, group);
  }
  return [...groups];
};

/** A move sent as a job with Skip, per destination folder, never over anything there. */
const moveAll = async (items: { send: string; land: string }[], purpose: UndoStep) => {
  for (const [folder, { paths, names }] of byFolder(items)) {
    const renamed = names.some((n, i) => n !== nameOf(paths[i]));
    await transfers.start(paths, folder, 'move', 'skip', {
      record: false,
      sent: paths.length,
      purpose,
      ...(renamed ? { names } : {}),
    });
  }
};

/** What a removal's question and its "no" call the made thing: the label for one new item. */
const madeNoun = (record: UndoRecord, label: string) =>
  record.kind === 'newFolder' || record.kind === 'newFile'
    ? `the ${label.toLowerCase()}`
    : quoted(record.kind === 'copy' ? record.created : []);

/**
 * Do the step `record` describes. `update` hands back the record as it stands after, where the
 * step changes it (a redone New folder may get the next free name, a redone copy lands its own
 * copies). Run `checkWorld` first.
 */
export const runStep = async (
  record: UndoRecord,
  step: UndoStep,
  update: (next: UndoRecord) => void = () => {},
  label = '',
): Promise<void> => {
  switch (record.kind) {
    case 'rename':
      if (step === 'undo') await fs.renameEntry(record.to, nameOf(record.from));
      else await fs.renameEntry(record.from, nameOf(record.to));
      return;
    case 'newFolder':
    case 'newFile': {
      if (step === 'undo') return removeMade([record.path], madeNoun(record, label));
      const dir = parentOf(record.path) ?? '';
      const path =
        record.kind === 'newFolder'
          ? await fs.createFolder(dir)
          : await fs.createFile(dir, record.baseName, record.ext);
      return update({ ...record, path });
    }
    case 'trash':
      if (step === 'undo') return restoreFromTrash(record.paths);
      return fs.trashEntries(record.paths);
    case 'move':
      if (step === 'undo')
        return moveAll(
          record.pairs.map((p) => ({ send: p.to, land: p.from })),
          'undo',
        );
      return moveAll(
        record.pairs.map((p) => ({ send: p.from, land: p.to })),
        'redo',
      );
    case 'copy': {
      if (step === 'undo') return removeMade(record.created, madeNoun(record, label));
      const { sources, destination } = record;
      if (!sources || !destination) throw new UndoRefused("Can't redo this after a restart");
      // the job lands later; its hook hands the record what this run made
      await transfers.start(sources, destination, 'copy', 'skip', {
        record: false,
        sent: sources.length,
        purpose: 'redo',
        undo: (outputs) => {
          if (outputs.length > 0) update({ ...record, created: outputs.map((o) => o.to) });
          return null;
        },
      });
      return;
    }
    case 'deleteForever':
      throw new UndoBarrier(BARRIER_MESSAGE);
    case 'other':
      throw new UndoRefused(`Can't ${step} this — ${record.reason}`);
  }
};

/**
 * The undo entry for `record`: the world checked before each step, the step run, the record
 * kept current for the next save. A permanent delete is a barrier, as `pushBarrier` makes it.
 */
export const entryFor = (meta: UndoMeta, first: UndoRecord): UndoEntry => {
  let record = first;
  const step = (s: UndoStep) => () => runStep(record, s, (next) => (record = next), meta.label);
  return {
    ...meta,
    at: meta.at ?? Date.now(),
    toRecord: () => record,
    check: (s) => checkWorld(record, s),
    undo: step('undo'),
    redo: step('redo'),
    ...(first.kind === 'deleteForever' ? { barrier: true as const } : {}),
  };
};

export const MAC_TRASH_STALE = "the Trash can't be read after a restart";
export const NOT_IN_BIN_STALE = 'it is no longer in the Recycle Bin';

/** Is every trashed path still in the bin, by the folder it came from and its name? */
const allInBin = async (paths: string[]) => {
  const items = await recycleList();
  return paths.every((p) =>
    items.some(
      (i) =>
        i.originalParent !== null &&
        samePath(i.originalParent, parentOf(p) ?? '') &&
        samePath(i.name, nameOf(p)),
    ),
  );
};

/**
 * Why a record read back after a restart can no longer be undone, or undefined when it still
 * can. A permanent delete stays a barrier (undefined), an `other` says its reason, a trash on a
 * Mac is never restorable (the Trash keeps no original path), elsewhere it must still be in the
 * bin; and `checkWorld` must pass. A bin that cannot be listed leaves the trash to `checkWorld`
 * and the restore itself to say what went wrong.
 */
export const staleReason = async (record: UndoRecord): Promise<string | undefined> => {
  if (record.kind === 'deleteForever') return undefined;
  if (record.kind === 'other') return record.reason;
  if (record.kind === 'trash') {
    if (onMac()) return MAC_TRASH_STALE;
    const inBin = await allInBin(record.paths).catch(() => true);
    if (!inBin) return NOT_IN_BIN_STALE;
  }
  try {
    await checkWorld(record, 'undo');
    return undefined;
  } catch (e) {
    if (e instanceof UndoRefused) return e.reason;
    throw e;
  }
};

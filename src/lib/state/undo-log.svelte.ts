// The undo history across restarts (plan 08 F2): `undo.json` read once when the main window
// opens, every entry checked (`utils/undo-records.ts`) and turned back into its undo
// (`undo-executor.ts`), then written again after every change. Only `main` keeps the file:
// another window's history is its own and ends with it, so two windows never overwrite each
// other's saves.
import { readUndoLog, writeUndoLog } from '$lib/api/undo-log';
import { isMainWindow } from '$lib/api/window';
import { logError } from '$lib/api/log';
import { entryFor, staleReason } from '$lib/state/undo-executor';
import { undo } from '$lib/state/undo.svelte';
import { sanitizeUndoLog, serializeUndoLog } from '$lib/utils/undo-records';

class UndoLog {
  #loaded = false;
  /** writes go one after another, so an older save never lands over a newer one */
  #writing: Promise<void> = Promise.resolve();

  save = () => {
    const value = serializeUndoLog(undo.saved());
    this.#writing = this.#writing
      .then(() => writeUndoLog(value))
      .catch((e: unknown) => logError('undoLog.save', e));
    return this.#writing;
  };

  /** Read the last run's history under anything done since, and save from now on. Once. */
  async load(main = isMainWindow()) {
    if (!main || this.#loaded) return;
    this.#loaded = true;
    const raw = await readUndoLog().catch((e: unknown) => {
      logError('undoLog.load', e);
      return null;
    });
    const doneSince = undo.saved().length;
    // what can no longer be undone is worked out now, before the menu shows the entry
    const entries = await Promise.all(
      sanitizeUndoLog(raw).map(async (s) => {
        const entry = entryFor(
          { label: s.label, what: s.what, folder: s.folder, at: s.at },
          s.record,
        );
        const stale = await staleReason(s.record).catch((e: unknown) => {
          logError('undoLog.stale', e);
          return undefined;
        });
        return stale === undefined ? entry : { ...entry, stale };
      }),
    );
    undo.restore(entries);
    undo.onChange(this.save);
    // something done before the file was read is saved now, not at the next change
    if (doneSince > 0) await this.save();
  }
}

export const undoLog = new UndoLog();

// The undo stack: every file action pushes an entry that knows how to reverse itself and how
// to do it again. Ctrl+Z / Ctrl+Y and the … menu come through here. A redo after a new
// action is gone, as in every editor.
import { tabs } from '$lib/state/tabs.svelte';
import type { SavedUndo, UndoRecord } from '$lib/types/undo';
import { inBinWords } from '$lib/utils/platform';
import { samePath } from '$lib/utils/path';
import { blockedText, blockerOf, type OverlapEntry } from '$lib/utils/undo-overlap';

export interface UndoEntry {
  /** "Rename", "Move", "Copy", "Delete", "New folder" — shown as "Undo <label>" */
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** what the notice after an undo / redo names: `copy of "pkg" to "out2"` (else the label) */
  what?: string;
  /** the folder the action happened in: an undo there while another is shown says so */
  folder?: string;
  /** a permanent delete (`pushBarrier`): nothing to reverse, and nothing older is reached */
  barrier?: true;
  /**
   * What the action did as plain data, read at save time (a Redo can change what it landed),
   * so the history outlives the window (`types/undo.ts`). An entry without one is not saved.
   */
  toRecord?: () => UndoRecord;
  /**
   * Run before the step: does the world still match the record (the target there, the place it
   * goes back to free)? Throws `UndoRefused` rather than let the step clobber anything.
   */
  check?: (step: 'undo' | 'redo') => Promise<void>;
  /** Unix ms when the action happened */
  at?: number;
  /**
   * Why an entry read back after a restart can no longer be undone ("the Trash can't be read
   * after a restart"), worked out once when it is read (`undo-log.svelte.ts`). The menu says
   * so, and an Undo on it drops it with that reason instead of trying.
   */
  stale?: string;
}

/**
 * The disk no longer matches what the entry would reverse (the file is gone, or something new
 * took the name it goes back to): nothing was changed, the entry is dropped, and the message
 * says why. Shown as news, not as an error.
 */
export class UndoRefused extends Error {
  override name = 'UndoRefused';
  /** the part after the dash, for a menu line that names its own action ("is no longer there") */
  constructor(
    message: string,
    readonly reason: string = message,
  ) {
    super(message);
  }
}

/**
 * The menu line and the notice for an entry that can no longer be undone. The stored reason keeps
 * the Windows word ("the Recycle Bin"); the bin is named in the chosen style's word here, where
 * the person reads it (plan 19), so the menu label, the notice and the history row agree.
 */
export const staleText = (entry: UndoEntry) =>
  inBinWords(`Can't undo ${entry.label} — ${entry.stale}`);

/**
 * An undo the person declined at its own question: nothing changed, so the caller shows news, not
 * an error. Thrown out of `entry.undo()`, it drops the entry (no redo of something that did not
 * happen) and `undo.undo()` rethrows it.
 */
export class UndoDeclined extends Error {
  override name = 'UndoDeclined';
}

/**
 * Thrown by `undo.undo()` when the last action was a permanent delete. ⛔ Its barrier stays on
 * the stack: a Ctrl+Z after a Shift+Delete used to reach past it and silently undo an OLDER
 * action, in a folder the person was not even looking at.
 */
export class UndoBarrier extends Error {
  override name = 'UndoBarrier';
}

export const BARRIER_MESSAGE = "Can't undo a permanent delete";

const labelled = (verb: string, entry: UndoEntry | undefined) =>
  entry?.barrier
    ? BARRIER_MESSAGE
    : entry?.stale && verb === 'Undo'
      ? staleText(entry)
      : entry
        ? `${verb} ${entry.label}`
        : verb;

/**
 * The notice after an undo / redo: `Undid copy of "pkg" to "out2"`. An action in a folder that is
 * not the one shown adds where it was, so a change out of sight is never silent.
 */
export const steppedText = (verb: 'Undid' | 'Redid', entry: UndoEntry, shown: string) => {
  const text = `${verb} ${entry.what ?? entry.label.toLowerCase()}`;
  return entry.folder && !samePath(entry.folder, shown)
    ? `${text} — in ${entry.folder}, not this folder`
    : text;
};

/** An entry as the overlap check reads it: its record now (a Redo can change it), else null. */
export const overlapOf = (entry: UndoEntry): OverlapEntry => ({
  label: entry.label,
  record: entry.toRecord?.() ?? null,
});

/**
 * Why `entries[index]` (oldest first) cannot be undone on its own yet — `Undo Move 3 items
 * first — it moved report.txt` — or null when no later entry touches its paths.
 */
export const blockedReason = (entries: readonly UndoEntry[], index: number): string | null => {
  const seen = entries.map(overlapOf);
  const blocker = blockerOf(seen, index);
  return blocker ? blockedText(seen[blocker.index], blocker, seen[index].record) : null;
};

class UndoState {
  #past = $state<UndoEntry[]>([]);
  #future = $state<UndoEntry[]>([]);
  busy = $state(false);

  canUndo = $derived(this.#past.length > 0 && !this.busy);
  canRedo = $derived(this.#future.length > 0 && !this.busy);
  undoLabel = $derived(labelled('Undo', this.#past.at(-1)));
  redoLabel = $derived(labelled('Redo', this.#future.at(-1)));

  #listeners = new Set<() => void>();

  /** The undo history, oldest first (Edit ▸ History lists it newest first). */
  get entries(): readonly UndoEntry[] {
    return this.#past;
  }

  push(entry: UndoEntry) {
    this.#past.push(entry);
    this.#future = [];
    this.#changed();
  }

  /** Called after every change to the history (a push, a step, a restore): how it is saved. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed() {
    for (const listener of this.#listeners) listener();
  }

  /**
   * Entries read back from the last run, oldest first: they go under anything done since this
   * window opened, so the newest action is still the first one Ctrl+Z reaches.
   */
  restore(entries: UndoEntry[]) {
    if (entries.length === 0) return;
    this.#past = [...entries, ...this.#past];
    this.#changed();
  }

  /** The undo history as the file keeps it, oldest first: the entries that have a record. */
  saved(): SavedUndo[] {
    return this.#past.flatMap((e) =>
      e.toRecord
        ? [
            {
              label: e.label,
              at: e.at ?? Date.now(),
              record: e.toRecord(),
              ...(e.what === undefined ? {} : { what: e.what }),
              ...(e.folder === undefined ? {} : { folder: e.folder }),
            },
          ]
        : [],
    );
  }

  /** A permanent delete: no undo of its own, and Ctrl+Z after it says so instead of going past. */
  pushBarrier(folder?: string, paths: string[] = []) {
    const never = async () => {
      throw new UndoBarrier(BARRIER_MESSAGE);
    };
    this.push({
      label: 'Permanent delete',
      undo: never,
      redo: never,
      folder,
      barrier: true,
      at: Date.now(),
      ...(paths.length > 0
        ? { toRecord: () => ({ kind: 'deleteForever' as const, paths: [...paths] }) }
        : {}),
    });
  }

  /**
   * Reverse the last action and return it, for the notice that names it; on failure the entry is
   * dropped and the error rethrown. A permanent delete on top throws `UndoBarrier` and stays.
   */
  undo = () => this.#step(this.#past, this.#future, 'undo');
  redo = () => this.#step(this.#future, this.#past, 'redo');

  /**
   * Out-of-order undo (plan 08 F): reverse the entry at `index` (oldest first) and take it out of
   * the history, leaving every other entry where it was. The newest entry is a plain `undo()` and
   * goes on redo as always; an older one does NOT — its redo would land under later actions that
   * never saw it undone (Decision, plan 08 F).
   *
   * Refused, with nothing changed and the entry kept, while a later entry touches any of its
   * paths (`UndoRefused` naming that entry: undo it first). Then, like `undo()`: a permanent
   * delete throws `UndoBarrier` and stays, a stale entry is dropped with its reason, `world`
   * (the entry's own `check`, else the caller's `checkWorld`) runs before the step, and on any
   * failure past that the entry is dropped and the error rethrown.
   */
  async undoAt(
    index: number,
    world: (entry: UndoEntry) => Promise<void> = async (e) => e.check?.('undo'),
  ): Promise<UndoEntry | undefined> {
    if (index === this.#past.length - 1) return this.undo();
    if (this.busy) return;
    const entry = this.#past[index];
    if (!entry) return;
    if (entry.barrier) throw new UndoBarrier(BARRIER_MESSAGE);
    const blocked = blockedReason(this.#past, index);
    if (blocked) throw new UndoRefused(blocked);
    this.#past.splice(index, 1);
    this.busy = true;
    try {
      if (entry.stale) throw new UndoRefused(staleText(entry), entry.stale);
      await world(entry);
      await entry.undo();
      return entry;
    } finally {
      this.busy = false;
      this.#changed();
      await tabs.active.reload();
    }
  }

  async #step(
    from: UndoEntry[],
    to: UndoEntry[],
    step: 'undo' | 'redo',
  ): Promise<UndoEntry | undefined> {
    if (this.busy) return;
    if (from.at(-1)?.barrier) throw new UndoBarrier(BARRIER_MESSAGE);
    const entry = from.pop();
    if (!entry) return;
    this.busy = true;
    try {
      // known since it was read back: dropped with its reason, nothing tried
      if (entry.stale && step === 'undo') throw new UndoRefused(staleText(entry), entry.stale);
      await entry.check?.(step);
      await entry[step]();
      to.push(entry);
      return entry;
    } finally {
      this.busy = false;
      this.#changed();
      await tabs.active.reload();
    }
  }
}

export const undo = new UndoState();

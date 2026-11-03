// The undo stack: every file action pushes an entry that knows how to reverse itself and how
// to do it again. Ctrl+Z / Ctrl+Y and the … menu come through here. A redo after a new
// action is gone, as in every editor.
import { tabs } from '$lib/state/tabs.svelte';
import { samePath } from '$lib/utils/path';

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
}

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
  entry?.barrier ? BARRIER_MESSAGE : entry ? `${verb} ${entry.label}` : verb;

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

class UndoState {
  #past = $state<UndoEntry[]>([]);
  #future = $state<UndoEntry[]>([]);
  busy = $state(false);

  canUndo = $derived(this.#past.length > 0 && !this.busy);
  canRedo = $derived(this.#future.length > 0 && !this.busy);
  undoLabel = $derived(labelled('Undo', this.#past.at(-1)));
  redoLabel = $derived(labelled('Redo', this.#future.at(-1)));

  push(entry: UndoEntry) {
    this.#past.push(entry);
    this.#future = [];
  }

  /** A permanent delete: no undo of its own, and Ctrl+Z after it says so instead of going past. */
  pushBarrier(folder?: string) {
    const never = async () => {
      throw new UndoBarrier(BARRIER_MESSAGE);
    };
    this.push({ label: 'Permanent delete', undo: never, redo: never, folder, barrier: true });
  }

  /**
   * Reverse the last action and return it, for the notice that names it; on failure the entry is
   * dropped and the error rethrown. A permanent delete on top throws `UndoBarrier` and stays.
   */
  undo = () => this.#step(this.#past, this.#future, (e) => e.undo());
  redo = () => this.#step(this.#future, this.#past, (e) => e.redo());

  async #step(
    from: UndoEntry[],
    to: UndoEntry[],
    run: (e: UndoEntry) => Promise<void>,
  ): Promise<UndoEntry | undefined> {
    if (this.busy) return;
    if (from.at(-1)?.barrier) throw new UndoBarrier(BARRIER_MESSAGE);
    const entry = from.pop();
    if (!entry) return;
    this.busy = true;
    try {
      await run(entry);
      to.push(entry);
      return entry;
    } finally {
      this.busy = false;
      await tabs.active.reload();
    }
  }
}

export const undo = new UndoState();

// Edit ▸ History (plan 08 F, out-of-order undo): the panel that lists the undo history newest
// first and undoes ONE older entry on its own when no later entry touches its files. Open or
// not, and which row is picked; the rows are worked out from the live stack (`undo.entries`).
import { BARRIER_MESSAGE, blockedReason, staleText, undo } from '$lib/state/undo.svelte';
import type { UndoEntry } from '$lib/state/undo.svelte';
import { entryTitle } from '$lib/utils/undo-overlap';

/**
 * - `ready`: Enter undoes it.
 * - `blocked`: a newer entry touches its files; picking it says which one, nothing changes.
 * - `stale`: read back after a restart and no longer undoable; shows why, disabled.
 * - `barrier`: a permanent delete, never undoable; disabled.
 */
export type HistoryStatus = 'ready' | 'blocked' | 'stale' | 'barrier';

export interface HistoryRow {
  /** the entry's place in the stack, oldest first (what `undo.undoAt` takes) */
  index: number;
  title: string;
  /** the notice's words for it (`move of 3 items to "out"`), when it has them */
  detail: string | null;
  /** Unix ms, or null for an entry that never said */
  at: number | null;
  status: HistoryStatus;
  /** why it is blocked, stale or a barrier; null when it is ready */
  note: string | null;
  /** the newest entry: a plain Undo, which Redo can bring back */
  newest: boolean;
}

/** The rows, newest first, from the stack as `undo.entries` holds it (oldest first). */
export const historyRows = (entries: readonly UndoEntry[]): HistoryRow[] =>
  entries
    .map((entry, index): HistoryRow => {
      const record = entry.toRecord?.() ?? null;
      const blocked = blockedReason(entries, index);
      const [status, note]: [HistoryStatus, string | null] = entry.barrier
        ? ['barrier', BARRIER_MESSAGE]
        : entry.stale
          ? ['stale', staleText(entry)]
          : blocked
            ? ['blocked', blocked]
            : ['ready', null];
      return {
        index,
        title: entryTitle(entry.label, record),
        detail: entry.what ?? null,
        at: entry.at ?? null,
        status,
        note,
        newest: index === entries.length - 1,
      };
    })
    .reverse();

/** Rows a pick cannot act on at all (Enter does nothing, the row reads as disabled). */
export const isDisabled = (row: HistoryRow) => row.status === 'stale' || row.status === 'barrier';

class UndoHistoryState {
  open = $state(false);
  /** the picked row's place in `rows` (0 = newest) */
  active = $state(0);

  rows = $derived(historyRows(undo.entries));

  show() {
    this.active = 0;
    this.open = true;
  }

  close() {
    this.open = false;
  }

  /** Move the pick by `delta` rows, held inside the list. */
  move(delta: number) {
    const last = this.rows.length - 1;
    this.active = Math.max(0, Math.min(last, this.active + delta));
  }

  moveTo(at: number) {
    this.active = Math.max(0, Math.min(this.rows.length - 1, at));
  }

  /** after an undo the list is shorter: keep the pick on a row that is still there */
  clamp() {
    this.moveTo(this.active);
  }
}

export const undoHistory = new UndoHistoryState();

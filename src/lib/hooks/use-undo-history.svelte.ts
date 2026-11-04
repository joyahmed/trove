// Edit ▸ History's reactivity (plan 08 F): the rows, the picked one, and the keys — ↑ ↓ Home End
// move the pick, Enter undoes it, Escape closes. Only the topmost dialog reacts: a Confirm the
// undo raises ("Delete permanently?" with no bin) answers its own keys.
import { actions } from '$lib/state/actions.svelte';
import { undo } from '$lib/state/undo.svelte';
import { isDisabled, undoHistory, type HistoryRow } from '$lib/state/undo-history.svelte';
import { ownsEnter } from '$lib/utils/focus-trap';
import { useFocusReturn } from './use-focus-return.svelte';

export const rowId = (row: HistoryRow) => `undo-history-${row.index}`;

export const useUndoHistory = () => {
  const { trap, isTop } = useFocusReturn();

  // the picked row stays on screen as ↑ ↓ Home End walk past the list's edge
  $effect(() => {
    const row = undoHistory.rows[undoHistory.active];
    if (row) document.getElementById(rowId(row))?.scrollIntoView({ block: 'nearest' });
  });

  const pick = async (row: HistoryRow | undefined) => {
    if (!row || isDisabled(row) || undo.busy) return;
    await actions.undoAt(row.index);
    undoHistory.clamp();
  };

  const KEYS: Record<string, () => void> = {
    ArrowDown: () => undoHistory.move(1),
    ArrowUp: () => undoHistory.move(-1),
    Home: () => undoHistory.moveTo(0),
    End: () => undoHistory.moveTo(undoHistory.rows.length - 1),
    Escape: () => undoHistory.close(),
  };

  const onkeydown = (e: KeyboardEvent) => {
    if (!isTop()) return;
    const run = KEYS[e.key];
    if (run) run();
    // a focused button (Close) answers its own Enter
    else if (e.key === 'Enter' && !ownsEnter(e.target))
      void pick(undoHistory.rows[undoHistory.active]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return {
    get rows() {
      return undoHistory.rows;
    },
    get active() {
      return undoHistory.active;
    },
    get activeId() {
      const row = undoHistory.rows[undoHistory.active];
      return row ? rowId(row) : undefined;
    },
    get busy() {
      return undo.busy;
    },
    /** a click: pick the row, then undo it */
    choose: (at: number) => {
      undoHistory.moveTo(at);
      void pick(undoHistory.rows[at]);
    },
    close: () => undoHistory.close(),
    onkeydown,
    /** on the panel: takes focus into the dialog as it opens, keeps Tab inside (utils/focus-trap) */
    trap,
  };
};

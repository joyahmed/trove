// The conflict dialog's reactivity: what is pending, the names to show, the answer. The
// dialog is lazy-mounted while `transfers.pending` is set (see Shell.svelte).
import type { Resolution } from '$lib/types/transfer';
import { transfers } from '$lib/state/transfers.svelte';
import { conflictChoices } from '$lib/data/conflict-choices';
import { useFocusReturn } from './use-focus-return.svelte';

const SHOWN = 8;

export const useConflictDialog = () => {
  // "Keep both" must leave Delete working in the list: focus goes back where it was
  const { trap, isTop } = useFocusReturn();
  const conflicts = $derived(transfers.pending?.conflicts ?? []);
  const count = $derived(conflicts.length);
  const names = $derived(conflicts.slice(0, SHOWN).map((p) => p.split(/[\\/]/).at(-1) ?? p));
  const more = $derived(Math.max(0, count - SHOWN));
  // Replace says whether Undo can bring the old files back (no bin there: it cannot)
  const choices = $derived(conflictChoices(transfers.pending?.noBin ?? null));
  const summary = $derived(
    `The destination has ${count} file${count === 1 ? '' : 's'} with the same name${count === 1 ? '' : 's'}`,
  );

  const onkeydown = (e: KeyboardEvent) => {
    // no Enter here on purpose: Enter on a focused Replace / Skip / Keep both is that button's
    // own click, so the answer is always the button the person is on
    if (e.key === 'Escape' && isTop()) transfers.cancelPending();
  };

  return {
    get names() {
      return names;
    },
    get more() {
      return more;
    },
    get summary() {
      return summary;
    },
    get choices() {
      return choices;
    },
    choose: (resolution: Resolution) => transfers.resolve(resolution),
    cancel: transfers.cancelPending,
    onkeydown,
    /** on the panel: takes focus into the dialog as it opens, keeps Tab inside (utils/focus-trap) */
    trap,
  };
};

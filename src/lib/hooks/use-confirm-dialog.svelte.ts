// The confirm dialog's reactivity: the question, Enter = OK (Cancel when `cancelDefault`),
// Escape = cancel.
//
// ⛔ Enter = OK only when Enter lands on the panel (or <body>). With a button focused — Tab
// from the panel reaches Cancel first — that button's own click answers; answering yes here
// too turned "Tab, Enter" on Cancel into a permanent delete. Only the topmost dialog reacts.
import { confirm } from '$lib/state/confirm.svelte';
import { ownsEnter } from '$lib/utils/focus-trap';
import { useFocusReturn } from './use-focus-return.svelte';

export const useConfirmDialog = () => {
  const { trap, isTop } = useFocusReturn();
  const onkeydown = (e: KeyboardEvent) => {
    if (!isTop()) return;
    if (e.key === 'Escape') confirm.answer(false);
    else if (e.key === 'Enter' && !ownsEnter(e.target))
      confirm.answer(confirm.pending?.cancelDefault !== true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return {
    get title() {
      return confirm.pending?.title ?? '';
    },
    get message() {
      return confirm.pending?.message ?? '';
    },
    get okLabel() {
      return confirm.pending?.okLabel ?? 'OK';
    },
    get danger() {
      return confirm.pending?.danger === true;
    },
    ok: () => confirm.answer(true),
    cancel: () => confirm.answer(false),
    onkeydown,
    /** on the panel: takes focus into the dialog as it opens, keeps Tab inside (utils/focus-trap) */
    trap,
  };
};

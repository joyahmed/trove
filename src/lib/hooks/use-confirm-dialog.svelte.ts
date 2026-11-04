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
    get input() {
      return confirm.pending?.input ?? null;
    },
    get problem() {
      return confirm.problem;
    },
    get text() {
      return confirm.text;
    },
    set text(v: string) {
      confirm.text = v;
      confirm.problem = null;
    },
    /** `use:` action for the name box: focus it with its text selected, after the panel's trap took focus */
    focusInput: (el: HTMLInputElement) => {
      const t = setTimeout(() => {
        el.focus();
        el.select();
      }, 0);
      return { destroy: () => clearTimeout(t) };
    },
    /** Enter in the name box answers OK; the dialog's own handler leaves a text field alone */
    ok: () => confirm.answer(true),
    cancel: () => confirm.answer(false),
    onkeydown,
    /** on the panel: takes focus into the dialog as it opens, keeps Tab inside (utils/focus-trap) */
    trap,
  };
};

// The toasts' reactivity: the visible notices and the hover pause/resume of each one's clock.
// Returns getters so the component stays live (CONTRIBUTING § 1).
import { noticeLooks } from '$lib/data/notice-kinds';
import { notices, type Notice } from '$lib/state/notices.svelte';

export const useToasts = () => {
  const run = (n: Notice, which: 'action' | 'second' = 'action') => {
    void n[which]?.run();
    notices.dismiss(n.id);
  };

  return {
    get list() {
      return notices.list;
    },
    lookOf: (n: Notice) => noticeLooks[n.kind],
    dismiss: (n: Notice) => notices.dismiss(n.id),
    run,
    onpointerenter: (n: Notice) => notices.pause(n.id),
    onpointerleave: (n: Notice) => notices.resume(n.id),
  };
};

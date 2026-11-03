// One yes/no question at a time, asked by an action and answered by the lazy ConfirmDialog
// (mounted while `pending` is set — see Shell.svelte). `ask` resolves with the answer.
export interface ConfirmRequest {
  title: string;
  message: string;
  okLabel: string;
  /** a destructive OK (permanent delete) is styled red */
  danger: boolean;
  /** Enter answers Cancel, not OK: a yes here loses someone's work (End task, plan 21B) */
  cancelDefault?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

class ConfirmState {
  pending = $state<PendingConfirm | null>(null);

  /** Ask; a question asked while another is open answers the first one "no". */
  ask(request: ConfirmRequest): Promise<boolean> {
    this.pending?.resolve(false);
    return new Promise((resolve) => {
      this.pending = { ...request, resolve };
    });
  }

  answer(ok: boolean) {
    const p = this.pending;
    this.pending = null;
    p?.resolve(ok);
  }
}

export const confirm = new ConfirmState();

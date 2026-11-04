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
  /** a name box under the message (`askText`); OK is refused while `validate` returns a problem */
  input?: { placeholder: string; validate: (value: string) => string | null };
}

/** What `askText` takes: a question plus the box's starting text. */
export interface TextRequest extends Omit<ConfirmRequest, 'danger' | 'input'> {
  placeholder: string;
  value: string;
  validate: (value: string) => string | null;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

class ConfirmState {
  pending = $state<PendingConfirm | null>(null);
  /** the name box's text and the problem shown under it (only while `pending.input` is set) */
  text = $state('');
  problem = $state<string | null>(null);

  /** Ask; a question asked while another is open answers the first one "no". */
  ask(request: ConfirmRequest): Promise<boolean> {
    this.pending?.resolve(false);
    this.problem = null;
    return new Promise((resolve) => {
      this.pending = { ...request, resolve };
    });
  }

  /** Ask for a line of text; the typed text on OK, `null` on cancel. */
  async askText(request: TextRequest): Promise<string | null> {
    const { placeholder, value, validate, ...rest } = request;
    const open = this.ask({ ...rest, danger: false, input: { placeholder, validate } });
    this.text = value; // after `ask` has cleared the last question's text
    return (await open) ? this.text.replace(/\s+/g, ' ').trim() : null;
  }

  answer(ok: boolean) {
    const p = this.pending;
    if (ok && p?.input) {
      const problem = p.input.validate(this.text);
      if (problem) {
        this.problem = problem;
        return;
      }
    }
    this.pending = null;
    p?.resolve(ok);
  }
}

export const confirm = new ConfirmState();

// What the toasts show: a short queue of notices (at most four on screen, newest at the
// bottom), each with a kind, an optional title and one or two actions, and a timer that pauses while the
// pointer is over it. Errors linger longest; nothing here is modal.
export type NoticeKind = 'info' | 'success' | 'warning' | 'error';

export interface NoticeAction {
  label: string;
  run: () => unknown;
}

export interface NoticeInput {
  kind: NoticeKind;
  message: string;
  title?: string;
  action?: NoticeAction;
  /** a second button beside `action` (End task beside Retry, plan 21B) */
  second?: NoticeAction;
  /** overrides the kind's default */
  timeoutMs?: number;
}

export interface Notice extends NoticeInput {
  id: number;
  timeoutMs: number;
}

export const MAX_SHOWN = 4;
export const TIMEOUT_MS: Record<NoticeKind, number> = {
  info: 6000,
  success: 6000,
  warning: 10000,
  error: 15000,
};

interface Timer {
  handle: ReturnType<typeof setTimeout> | undefined;
  /** ms left when paused; the full timeout before the first start */
  remaining: number;
  startedAt: number;
}

class NoticesState {
  list = $state<Notice[]>([]);
  #next = 1;
  #timers: Record<number, Timer> = {};

  push(input: NoticeInput): number {
    const id = this.#next++;
    const notice: Notice = { ...input, id, timeoutMs: input.timeoutMs ?? TIMEOUT_MS[input.kind] };
    this.list.push(notice);
    while (this.list.length > MAX_SHOWN) this.#drop(this.list[0].id);
    this.#timers[id] = { handle: undefined, remaining: notice.timeoutMs, startedAt: 0 };
    this.#start(id);
    return id;
  }

  dismiss(id: number) {
    this.#drop(id);
  }

  /** The pointer is over the toast: hold the clock. */
  pause(id: number) {
    const t = this.#timers[id];
    if (!t || t.handle === undefined) return;
    clearTimeout(t.handle);
    t.handle = undefined;
    t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
  }

  /** The pointer left: run the rest of the clock. */
  resume(id: number) {
    const t = this.#timers[id];
    if (!t || t.handle !== undefined) return;
    this.#start(id);
  }

  #start(id: number) {
    const t = this.#timers[id];
    if (!t) return;
    t.startedAt = Date.now();
    t.handle = setTimeout(() => this.#drop(id), t.remaining);
  }

  #drop(id: number) {
    const t = this.#timers[id];
    if (t?.handle !== undefined) clearTimeout(t.handle);
    delete this.#timers[id];
    const i = this.list.findIndex((n) => n.id === id);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** Test seam and a clean slate on demand. */
  clear() {
    for (const n of [...this.list]) this.#drop(n.id);
  }
}

export const notices = new NoticesState();

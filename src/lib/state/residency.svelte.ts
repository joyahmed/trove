// Whether the app stays alive in the tray and starts with Windows. One switch drives both when
// the app is the default file manager (Win+E must answer at once and a portable exe has no
// installer to register it); the two settings below add them on their own.
import { onTrayNewTab, setResident, setStartWithWindows } from '$lib/api/tray';
import { settings } from '$lib/state/settings.svelte';
import { tabs } from '$lib/state/tabs.svelte';

class ResidencyState {
  /** what Rust was last told; null until the first sync */
  resident = $state<boolean | null>(null);
  startWithWindows = $state<boolean | null>(null);
  error = $state<string | null>(null);

  /** Resident and started at logon when either setting or the default toggle says so. */
  wantsResident = $derived(settings.keepRunning || settings.defaultHandler.applied);
  wantsStartup = $derived(settings.startWithWindows || settings.defaultHandler.applied);

  /**
   * The sync running now, and the ones waiting behind it. Syncs are queued, not guarded by a
   * generation: the tray icon and the HKCU `Run` entry are single OS-wide things, and `sync`
   * sends only what *changed* — so two overlapping runs both read `this.resident` before either
   * has written it (a read-modify-write, not just a stale write), both push, and Rust applies
   * them in whichever order its two command tasks finish. The older run then answers last: it
   * records what it asked for as "what Rust was last told", and because that record is what
   * gates every later push, the machine can stay registered the way the person has just stopped
   * wanting with nothing left to correct it. It also clears `error`, taking away a failure the
   * newer run has only just reported.
   *
   * A superseded sync cannot simply return, either: by then it has created or dropped a real
   * tray icon, so there is nothing to release and nothing to skip — it has to finish. Queueing
   * gives both runs their turn in the order they were asked for, and the wanted state is read
   * when a run's turn comes, so the runs that pile up behind a slow one collapse into no-ops.
   */
  #tail: Promise<void> = Promise.resolve();

  /** Push the wanted state to Rust; only what changed is sent. One at a time — see `#tail`. */
  sync() {
    this.#tail = this.#tail.then(() => this.#push());
    return this.#tail;
  }

  /** `#push` never rejects, so the queue in `#tail` cannot be broken by a failed sync. */
  async #push() {
    const [resident, startup] = [this.wantsResident, this.wantsStartup];
    try {
      if (resident !== this.resident) {
        await setResident(resident);
        this.resident = resident;
      }
      if (startup !== this.startWithWindows) {
        await setStartWithWindows(startup);
        this.startWithWindows = startup;
      }
      this.error = null;
    } catch (e) {
      this.error = String(e);
    }
  }

  /** The tray's "New tab" → a tab on Home in the (already shown) window. Returns detach. */
  attach() {
    const unlisten = onTrayNewTab(() => void tabs.open());
    return () => void unlisten.then((f) => f());
  }
}

export const residency = new ResidencyState();

// The order of a window's start for "Restore tabs" (plan 15 G.45), kept apart from the shell so
// it can be tested without a window: what the last run left is restored once, this window's
// own saves wait for that, and a hidden start keeps the other windows until it is first shown.
import type { RestorePlan, WindowPlan } from '$lib/utils/restore-tabs';

export interface SessionRestoreDeps {
  /** show `plan`'s folders in this window's tabs */
  openHere: (plan: WindowPlan) => void;
  /** open the last run's other windows */
  openWindows: (plans: WindowPlan[]) => Promise<void>;
  /** keep not-yet-opened windows in the session file (`[]` releases them) */
  hold: (plans: WindowPlan[]) => Promise<void>;
  /** report this window's tabs */
  save: (plan: WindowPlan) => Promise<void>;
  /** a failed hold or save: logged, never thrown into the start */
  onError: (what: string, e: unknown) => void;
}

/**
 * One window's restore-and-save sequence.
 *
 * ⚠️ **Saves wait for the restore.** A window reports `[]` the moment it mounts, before the
 * restore has run; written then, that empty tab list would replace the last session on disk,
 * and a crash during start would lose it. So a save before `restore` is only remembered, and
 * sent once the restore has run.
 *
 * A hidden start (resident, `--hidden`) keeps the other windows pending: opening them would put
 * windows on screen while `main` stays in the tray. They are held in the session file meanwhile
 * (`hold`), so a quit from the tray does not lose them, and open on `shown`.
 */
export const createSessionRestore = (deps: SessionRestoreDeps) => {
  let restored = false;
  let pending: WindowPlan[] = [];
  /** the latest save asked for before the restore ran */
  let waiting: WindowPlan | null = null;
  let lastSent = '';

  const send = (plan: WindowPlan) => {
    const key = JSON.stringify(plan);
    if (key === lastSent) return;
    lastSent = key;
    void deps.save(plan).catch((e: unknown) => deps.onError('saveWindowTabs', e));
  };

  return {
    get restored() {
      return restored;
    },
    get pending(): readonly WindowPlan[] {
      return pending;
    },

    /** This window's tabs now: sent, or held back until the restore has run. */
    save(plan: WindowPlan) {
      if (restored) send(plan);
      else waiting = plan;
    },

    /**
     * Apply `plan`. With `deferOthers` the other windows wait for `shown`; held in the file
     * first, so nothing this window saves next can be the only record. Once per window: a later
     * call (a second launch) only opens its own tabs, it never re-arms the wait.
     */
    async restore(plan: RestorePlan, deferOthers: boolean) {
      deps.openHere(plan.main);
      if (plan.others.length > 0) {
        if (deferOthers) {
          pending = [...pending, ...plan.others];
          await deps.hold(pending).catch((e: unknown) => deps.onError('holdWindows', e));
        } else {
          void deps.openWindows(plan.others);
        }
      }
      if (restored) return;
      restored = true;
      if (waiting) send(waiting);
      waiting = null;
    },

    /**
     * The window is on screen: open the windows a hidden start kept back. Released from the
     * file first — a crash between the two loses them rather than restoring them twice.
     */
    async shown() {
      if (pending.length === 0) return;
      const plans = pending;
      pending = [];
      await deps.hold([]).catch((e: unknown) => deps.onError('holdWindows', e));
      await deps.openWindows(plans);
    },
  };
};

export type SessionRestore = ReturnType<typeof createSessionRestore>;

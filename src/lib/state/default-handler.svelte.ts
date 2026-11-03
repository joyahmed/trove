// "Use as default file manager": what the registry says now, what we did last time (settings),
// and the one toggle that applies or reverts the HKCU keys. Never applies on its own — a reset
// by Windows or a moved exe becomes a Re-apply offer in a toast, not a silent write.
import {
  defaultHandlerApply,
  defaultHandlerInfo,
  defaultHandlerRevert,
  defaultHandlerStatus,
} from '$lib/api/default-handler';
import { notices } from '$lib/state/notices.svelte';
import { settings } from '$lib/state/settings.svelte';
import { onWindows } from '$lib/utils/platform';
import type { HandlerInfo, HandlerStatus } from '$lib/types/default-handler';

export const LABEL = 'Use as default file manager';
export const UNSTABLE_WARNING =
  'The exe is in a temporary or build folder; move it somewhere permanent before setting it as default';
export const APPLIED_TITLE = 'Trove is the default file manager';
export const APPLIED_NOTICE =
  'It stays in the tray and starts with Windows. Undo here, or from the … menu at any time.';
export const REVERTED_NOTICE = 'Explorer is the default file manager again';

class DefaultHandlerState {
  status = $state<HandlerStatus | null>(null);
  info = $state<HandlerInfo | null>(null);
  busy = $state(false);
  error = $state<string | null>(null);

  /**
   * True from the moment `apply` / `revert` touches the registry until a `load` that started
   * afterwards has answered: `status` is then a reading of keys we have since rewritten, and
   * nothing may be concluded from it (see `needsReapply`). It is only ever used to *withhold* a
   * claim — never to assert that the app is the default, which stays the registry's word alone.
   */
  #statusPredatesWrite = $state(false);

  /**
   * Which `load` is the current one. Loads overlap: one on mount, and one in the `finally` of
   * every `apply` and `revert` — and `busy` is lowered before that load, so a second toggle may
   * start while the first's load is still in flight. Two registry reads do not resolve in the
   * order they were started, so without this the older one answers last and puts its reading of
   * the keys *as they were before the newer write* into `status`. That is a plain stale write,
   * and it is the one that makes `needsReapply` true off a pre-apply reading and flips the
   * settings switch back on its own.
   */
  #generation = 0;

  isDefault = $derived(this.status?.kind === 'applied');
  label = LABEL;
  checked = $derived(this.isDefault);
  /** set when the exe lives somewhere that will not stay put */
  warning = $derived(this.info !== null && !this.info.stable ? UNSTABLE_WARNING : null);

  /** The exe was applied from another path than the one we run from now. */
  movedTo = $derived(
    settings.defaultHandler.applied &&
      this.info !== null &&
      this.info.exePath !== settings.defaultHandler.exePath
      ? this.info.exePath
      : null,
  );
  /**
   * We applied it once and the registry no longer says so: Windows reset it, or the exe moved.
   *
   * `#statusPredatesWrite` is part of the question. `apply` writes the keys, then remembers in
   * settings that it did, and only then re-reads the registry — so between those two there is a
   * window in which `settings.defaultHandler.applied` is already true while `status` is still
   * the reading from *before* the keys were written, which by definition says "not applied".
   * Read in that window this says Windows reset the default file manager, and the shell hook
   * raises exactly that toast the moment it turns true. It is not a reset; it is our own
   * pre-apply reading. Until a reading taken after the write lands, we do not know.
   */
  needsReapply = $derived(
    settings.defaultHandler.applied &&
      !this.#statusPredatesWrite &&
      this.status !== null &&
      this.status.kind !== 'applied',
  );
  reapplyText = $derived(
    this.movedTo !== null
      ? 'The app moved — Re-apply with the new path'
      : 'Windows reset the default file manager — Re-apply',
  );

  /**
   * Read the registry and this exe's path; safe to call again. A load that has been superseded
   * writes nothing at all — not the status, not the info, not the error; the newest load owns
   * them. Only a reading that lands current clears `#statusPredatesWrite`: a read that failed
   * leaves `status` as the reading from before the write, which is still not evidence.
   */
  async load() {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    this.error = null;
    try {
      const [status, info] = await Promise.all([defaultHandlerStatus(), defaultHandlerInfo()]);
      if (!current()) return;
      this.status = status;
      this.info = info;
      this.#statusPredatesWrite = false;
    } catch (e) {
      if (!current()) return;
      this.error = String(e);
    }
  }

  /** Write the keys with this exe's path and remember that we did. */
  async apply() {
    if (this.busy) return;
    if (this.warning) {
      notices.push({ kind: 'warning', message: this.warning });
      return;
    }
    this.busy = true;
    // from here `status` describes keys we are rewriting; a failed apply may have written some
    this.#statusPredatesWrite = true;
    try {
      await defaultHandlerApply();
      settings.defaultHandler = { applied: true, exePath: this.info?.exePath ?? '' };
      notices.push({
        kind: 'success',
        title: APPLIED_TITLE,
        message: onWindows()
          ? APPLIED_NOTICE
          : 'It stays in the tray and starts at login. Undo here at any time.',
        action: { label: 'Undo', run: () => void this.revert() },
      });
    } catch (e) {
      notices.push({ kind: 'error', message: String(e) });
    } finally {
      this.busy = false;
      await this.load();
    }
  }

  /** Delete what `apply` wrote, restore what it overwrote, forget that we applied. */
  async revert() {
    if (this.busy) return;
    this.busy = true;
    this.#statusPredatesWrite = true;
    try {
      await defaultHandlerRevert();
      settings.defaultHandler = { applied: false, exePath: '' };
      notices.push({
        kind: 'info',
        message: onWindows() ? REVERTED_NOTICE : 'The previous default file manager is back',
      });
    } catch (e) {
      notices.push({ kind: 'error', message: String(e) });
    } finally {
      this.busy = false;
      await this.load();
    }
  }

  toggle = () => (this.isDefault ? this.revert() : this.apply());
}

export const defaultHandler = new DefaultHandlerState();

// The status bar's update line (plan 22.5.3): "A new version is ready" + "Restart to update".
// ⛔ Never forced: Rust downloads and verifies in the background, then this only offers the
// restart and waits for a click. A build without the updater (every build today, and the
// Store build always) never asks Rust and never shows the line.
import { onUpdateReady, updateReady, updateRestart } from '$lib/api/updater';
import { notices } from '$lib/state/notices.svelte';
import { logError } from '$lib/api/log';
import { selfUpdates } from '$lib/utils/platform';

export const UPDATE_READY_TEXT = 'A new version is ready';
export const RESTART_TO_UPDATE = 'Restart to update';

class UpdaterState {
  /** the downloaded version waiting for a restart, or null (nothing to show) */
  version = $state<string | null>(null);
  restarting = $state(false);
  #started = false;

  /** Ask once per window whether an update is already waiting, then hear the next one. */
  start(on: boolean = selfUpdates()) {
    if (!on || this.#started) return;
    this.#started = true;
    updateReady()
      .then((v) => {
        if (v) this.version = v;
      })
      .catch((e: unknown) => logError('updater.ready', e));
    onUpdateReady((v) => {
      this.version = v;
    }).catch((e: unknown) => logError('updater.listen', e));
  }

  /** The person clicked "Restart to update". */
  async restart() {
    if (this.version === null || this.restarting) return;
    this.restarting = true;
    try {
      await updateRestart();
    } catch (e) {
      this.restarting = false;
      this.version = null;
      logError('updater.restart', e);
      notices.push({
        kind: 'error',
        title: 'The update did not install',
        message: String(e),
      });
    }
  }
}

export const updater = new UpdaterState();

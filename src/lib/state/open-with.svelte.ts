// The apps that can open the right-clicked file, read when the menu opens. A late answer for a
// file the person has already moved off is dropped, so the flyout never lists the wrong apps.
import { openWithApp, openWithApps, openWithDialog } from '$lib/api/open-with';
import { logError } from '$lib/api/log';
import { actions } from '$lib/state/actions.svelte';
import type { OpenWithApp } from '$lib/types/open-with';

class OpenWithState {
  apps = $state.raw<OpenWithApp[]>([]);
  loading = $state(false);
  /** the file `apps` belongs to */
  path = $state('');
  #generation = 0;

  async load(path: string) {
    const generation = ++this.#generation;
    this.path = path;
    this.apps = [];
    this.loading = true;
    try {
      const apps = await openWithApps(path);
      if (generation !== this.#generation) return;
      this.apps = apps;
    } catch (e) {
      if (generation !== this.#generation) return;
      logError('openWith.load', e);
      this.apps = [];
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }

  async open(id: string, paths: string[]) {
    try {
      await openWithApp(id, paths);
    } catch (e) {
      actions.notify(String(e), 'error');
    }
  }

  /** Windows' own "Choose another app" dialog. */
  async choose(path: string) {
    try {
      await openWithDialog(path);
    } catch (e) {
      actions.notify(String(e), 'error');
    }
  }
}

export const openWith = new OpenWithState();

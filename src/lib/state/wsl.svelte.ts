// The installed WSL distros, listed once from the registry; opening one asks the OS for its
// home (which starts the distro) and navigates the active tab there. Which of them are running
// is asked of `wsl.exe -l --running` (never starts one) on load, after an open, and every 15 s.
import { wslDistros, wslHome, wslRunningDistros } from '$lib/api/wsl';
import { tabs } from '$lib/state/tabs.svelte';
import type { WslDistro } from '$lib/types/wsl';

/** A distro stops on its own a few seconds after its last process; 15 s keeps the dot honest
 * without a `wsl.exe` spawn every few seconds. */
export const RUNNING_POLL_MS = 15_000;

class WslState {
  distros = $state<WslDistro[]>([]);
  loaded = $state(false);
  /** the distro whose home is being looked up right now — "Starting Ubuntu…" in the list */
  starting = $state<string | null>(null);
  /** names of the distros running now; the sidebar marks them with a dot */
  running = $state<string[]>([]);
  #poll: ReturnType<typeof setInterval> | null = null;

  async load() {
    if (this.loaded) return;
    this.distros = await wslDistros();
    this.loaded = true;
    if (this.distros.length === 0) return;
    await this.refreshRunning();
    if (this.#poll === null)
      this.#poll = setInterval(() => void this.refreshRunning(), RUNNING_POLL_MS);
  }

  /** A failed ask keeps the last answer: a dot must not flicker off on one slow spawn. */
  refreshRunning = async () => {
    try {
      this.running = await wslRunningDistros();
    } catch {
      // keep the previous answer
    }
  };

  isRunning = (name: string) => this.running.includes(name);

  /** The distro's home is the entry point, as its terminal opens there. */
  open = async (distro: WslDistro) => {
    const tab = tabs.active;
    this.starting = distro.name;
    try {
      await tab.navigate(await wslHome(distro.name, distro.uid));
    } catch (e) {
      tab.error = String(e);
    } finally {
      this.starting = null;
      void this.refreshRunning();
    }
  };
}

export const wsl = new WslState();

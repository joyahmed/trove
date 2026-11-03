// The installed WSL distros, listed once from the registry; opening one asks the OS for its
// home (which starts the distro) and navigates the active tab there.
import { wslDistros, wslHome } from '$lib/api/wsl';
import { tabs } from '$lib/state/tabs.svelte';
import type { WslDistro } from '$lib/types/wsl';

class WslState {
  distros = $state<WslDistro[]>([]);
  loaded = $state(false);
  /** the distro whose home is being looked up right now — "Starting Ubuntu…" in the list */
  starting = $state<string | null>(null);

  async load() {
    if (this.loaded) return;
    this.distros = await wslDistros();
    this.loaded = true;
  }

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
    }
  };
}

export const wsl = new WslState();

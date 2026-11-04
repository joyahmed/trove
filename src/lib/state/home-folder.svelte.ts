// The user's home folder, from the OS (`USERPROFILE` on Windows, `HOME` elsewhere), for the
// places that print a path with home as `~` (utils/path-display). Asked once per window, on first
// read; until it lands (or if it fails) `path` is null and every path shows in full.
import { userProfile } from '$lib/api/shell';
import { logError } from '$lib/api/log';

class HomeFolder {
  #path = $state<string | null>(null);
  #asked = false;

  get path(): string | null {
    if (!this.#asked) {
      this.#asked = true;
      userProfile()
        .then((p) => (this.#path = p))
        .catch((e) => logError('homeFolder.userProfile', e));
    }
    return this.#path;
  }
}

export const homeFolder = new HomeFolder();

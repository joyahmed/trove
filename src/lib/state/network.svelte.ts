// The Network group's state (plan 05 5.3b, plan 08 D3): which drive letters are mapped to a
// share, and which places missed a deadline lately so the sidebar draws them greyed. A miss is
// learned from a listing that "did not answer in" time and forgotten as soon as that place
// answers; nothing here touches the network itself.
import { SvelteSet } from 'svelte/reactivity';
import { mappedDrives } from '$lib/api/fs';
import { logError } from '$lib/api/log';
import { isUnreachableError, shareRootOf, unreachablePlaceOf } from '$lib/utils/network';

/** A share root or a drive letter, compared without case or a trailing separator. */
const placeKey = (path: string): string => {
  const share = shareRootOf(path);
  if (share) return share.toLowerCase();
  const letter = /^([a-z]):/i.exec(path);
  return letter ? `${letter[1].toLowerCase()}:` : path.toLowerCase();
};

class NetworkState {
  /** `Z:\` for every letter mapped to a share; empty off Windows */
  mapped = $state<string[]>([]);
  #missed = new SvelteSet<string>();

  async loadMapped() {
    try {
      this.mapped = await mappedDrives();
    } catch (e) {
      logError('network.mapped', e);
    }
  }

  /** A listing failed: if it was the deadline, its place reads greyed until it answers. */
  failed(err: unknown) {
    const text = String(err);
    if (!isUnreachableError(text)) return;
    const place = unreachablePlaceOf(text);
    if (place) this.#missed.add(placeKey(place));
  }

  /** A listing under `path` answered: its place is reachable again. */
  answered(path: string) {
    if (this.#missed.size > 0) this.#missed.delete(placeKey(path));
  }

  /** Whether the share or letter holding `path` missed its last deadline. */
  isMissed(path: string): boolean {
    return this.#missed.has(placeKey(path));
  }
}

export const network = new NetworkState();

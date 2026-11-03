// The palette footer's index line (plan 21C.2a). While a root is still on its first walk the
// count asks again every second, so "N so far" climbs without a keystroke; once nothing is
// filling it stops asking.
import { indexProgress as askProgress } from '$lib/api/palette';
import { logError } from '$lib/api/log';
import { indexProgress } from '$lib/state/index-progress.svelte';

export const INDEX_POLL_MS = 1000;

export const useIndexFooter = () => {
  // a boolean, so each new count does not restart the timer
  const filling = $derived(indexProgress.filling.length > 0);
  $effect(() => {
    if (!filling) return;
    const timer = setInterval(() => {
      askProgress()
        .then((filling) => indexProgress.set(filling))
        .catch((e: unknown) => logError('palette.indexProgress', e));
    }, INDEX_POLL_MS);
    return () => clearInterval(timer);
  });

  return {
    /** "indexing D: — 412,000 so far", or null when the index holds every root */
    get indexing() {
      return indexProgress.label;
    },
  };
};

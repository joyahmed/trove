// The list's empty / error / starting / searching states, read from the active tab and the
// search. A stopped WSL distro
// takes seconds to start on its first read, so that wait says which distro instead of nothing.
import { listing } from '$lib/state/listing.svelte';
import { search } from '$lib/state/search.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { wsl } from '$lib/state/wsl.svelte';
import { wslDistroOf } from '$lib/utils/path';

export const useListStatus = () => {
  const starting = $derived.by(() => {
    if (wsl.starting !== null) return wsl.starting;
    return tabs.active.loading ? wslDistroOf(tabs.active.path) : null;
  });
  const empty = $derived(!tabs.active.loading && !search.running && listing.rows.length === 0);
  /** "Searching… 12,340 items" while the recursive search runs */
  const searching = $derived(
    search.active && search.running ? `Searching… ${search.scanned.toLocaleString()} items` : null,
  );

  return {
    get error() {
      return tabs.active.error;
    },
    /** the distro being started, or null */
    get starting() {
      return starting;
    },
    get empty() {
      return empty;
    },
    get searching() {
      return searching;
    },
    /** the empty line differs: a folder is empty, a search has no match */
    get emptyText() {
      return search.active
        ? 'No items match your search.'
        : tabs.active.filter
          ? 'No items match the filter.'
          : 'This folder is empty.';
    },
  };
};

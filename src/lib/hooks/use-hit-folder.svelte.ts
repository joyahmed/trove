// The folder line of a search hit on a grid / list tile: null outside a search, so a plain folder
// listing keeps its tiles as they were. Reads the search's own root to shorten the path.
import { listing } from '$lib/state/listing.svelte';
import { search } from '$lib/state/search.svelte';
import type { FileEntry } from '$lib/types/fs';
import { hitFolder } from '$lib/utils/hit-folder';
import { homeFolder } from '$lib/state/home-folder.svelte';

export const useHitFolder = (entry: () => FileEntry) => {
  const root = $derived(search.location.kind === 'path' ? search.location.path : null);
  const hit = $derived(hitFolder(entry().path, listing.isSearch, root, homeFolder.path));
  return {
    get hit() {
      return hit;
    },
  };
};

// The line above search results: where the search ran, how many hits, and a way out — plus, on a
// Mac, a quiet line naming the personal folders it left out, with Allow.
import { guardedFolders } from '$lib/state/guarded-folders.svelte';
import { listing } from '$lib/state/listing.svelte';
import { search } from '$lib/state/search.svelte';
import { notSearchedTitle } from '$lib/utils/guarded-folders';
import { locationLabel } from '$lib/utils/location';

export const useSearchHeader = () => {
  const title = $derived(`Search results in ${locationLabel(search.location)}`);
  const count = $derived(listing.rows.length);
  /** Mac: "Not searched: Desktop, Documents…" when the search left personal folders out */
  const notSearched = $derived(
    search.skippedGuarded.length > 0 ? notSearchedTitle(search.skippedGuarded) : null,
  );

  return {
    get title() {
      return title;
    },
    get count() {
      return count;
    },
    get running() {
      return search.running;
    },
    get error() {
      return search.error;
    },
    get notSearched() {
      return notSearched;
    },
    get allowing() {
      return guardedFolders.busy;
    },
    allow: () => void search.allowGuarded(),
    close: () => search.clear(),
    cancel: () => void search.cancel(),
  };
};

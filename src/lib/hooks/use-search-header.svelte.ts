// The line above search results: where the search ran, how many hits, and a way out.
import { listing } from '$lib/state/listing.svelte';
import { search } from '$lib/state/search.svelte';
import { locationLabel } from '$lib/utils/location';

export const useSearchHeader = () => {
  const title = $derived(`Search results in ${locationLabel(search.location)}`);
  const count = $derived(listing.rows.length);

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
    close: () => search.clear(),
    cancel: () => void search.cancel(),
  };
};

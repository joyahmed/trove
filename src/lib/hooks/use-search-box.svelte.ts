// The search box: typing filters the folder instantly, Enter searches it recursively, Escape
// or the × clears both. Returns getters so the component stays live (CONTRIBUTING.md § 1).
import { search } from '$lib/state/search.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { locationLabel } from '$lib/utils/location';

export const useSearchBox = () => {
  const placeholder = $derived(`Search ${locationLabel(tabs.active.location)}`);
  /** what the field shows: the running search's text, else the instant filter */
  const value = $derived(search.active ? search.text : tabs.active.filter);
  const nonEmpty = $derived(value !== '');

  const clear = () => {
    tabs.active.filter = '';
    search.clear();
  };

  const oninput = (e: Event) => {
    const text = (e.currentTarget as HTMLInputElement).value;
    if (search.active && text === '') return clear();
    if (search.active)
      search.text = text; // edited but not yet searched again
    else tabs.active.filter = text;
  };

  const onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      const text = (e.currentTarget as HTMLInputElement).value.trim();
      if (!text) return;
      tabs.active.filter = '';
      void search.start(text);
    } else if (e.key === 'Escape') {
      clear();
      (e.currentTarget as HTMLInputElement).blur();
    } else return;
    e.preventDefault();
  };

  return {
    get placeholder() {
      return placeholder;
    },
    get value() {
      return value;
    },
    get nonEmpty() {
      return nonEmpty;
    },
    /** a place searches every drive; only an empty tab (no launch yet) has nothing to search */
    get enabled() {
      return tabs.active.isFolder ? tabs.active.path !== '' : true;
    },
    oninput,
    onkeydown,
    clear,
  };
};

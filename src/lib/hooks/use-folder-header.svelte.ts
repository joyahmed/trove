// The folder title block's reactivity: its three texts, and the Group / Sort pills, which open
// the same menu items the command bar's Sort button does (data/menus.ts).
import { tabs } from '$lib/state/tabs.svelte';
import { listing } from '$lib/state/listing.svelte';
import { groupKeyItems, sortMenu } from '$lib/data/menus';
import { locationLabel } from '$lib/utils/location';
import { folderCounts, folderMeta } from '$lib/utils/folder-header';
import { useMenu, type MenuItem } from '$lib/hooks/use-menu.svelte';

export const useFolderHeader = () => {
  const menu = useMenu();
  let items = $state<MenuItem[]>([]);

  let openKey = $state<'group' | 'sort' | null>(null);

  const openAs = (key: 'group' | 'sort', set: MenuItem[], e: MouseEvent) => {
    items = set;
    openKey = key;
    menu.openBelow(e.currentTarget as HTMLElement);
  };

  return {
    menu,
    /** the Group pill's / the Sort pill's menu is the one showing (their `aria-expanded`) */
    get groupExpanded() {
      return menu.open && openKey === 'group';
    },
    get sortExpanded() {
      return menu.open && openKey === 'sort';
    },
    get items() {
      return items;
    },
    /** only a real folder, and not while a search has taken over the list */
    get visible() {
      return tabs.active.isFolder && !listing.isSearch;
    },
    get title() {
      return locationLabel(tabs.active.location);
    },
    get path() {
      return tabs.active.path;
    },
    get counts() {
      return folderCounts(listing.rows);
    },
    get meta() {
      return folderMeta(tabs.active.path, listing.rows);
    },
    openGroup: (e: MouseEvent) => openAs('group', groupKeyItems, e),
    openSort: (e: MouseEvent) => openAs('sort', sortMenu, e),
  };
};

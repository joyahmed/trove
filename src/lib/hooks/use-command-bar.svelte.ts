// The toolbar's command buttons' reactivity (+ New, Filters, Details, Settings): one popup menu
// shared by every dropdown item.
import { type CommandItem, isEnabled } from '$lib/data/command-actions';
import { useMenu, type MenuItem } from '$lib/hooks/use-menu.svelte';

export const useCommandBar = () => {
  const menu = useMenu();
  let items = $state<MenuItem[]>([]);
  let openKey = $state<string | null>(null);

  /** A click on any command item: run it, or open its menu under the button. */
  const activate = (item: CommandItem, e: MouseEvent) => {
    if (item.kind === 'divider' || !isEnabled(item)) return;
    if (item.menu) {
      items = item.menu;
      openKey = item.key;
      menu.openBelow(e.currentTarget as HTMLElement);
    } else {
      void item.run?.();
    }
  };

  /** this item's menu is the one showing */
  const isExpanded = (item: CommandItem) =>
    item.kind !== 'divider' && item.menu !== undefined && menu.open && openKey === item.key;

  return {
    menu,
    isExpanded,
    get items() {
      return items;
    },
    activate,
  };
};

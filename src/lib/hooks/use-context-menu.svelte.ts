// The list's right-click menu: which item set (row or background), opened at the pointer,
// with Explorer's select-on-right-click rule. One instance per list; `useMenu` owns
// open/close (outside click, Escape) and the on-screen clamp.
import { backgroundMenuFor, rowMenuFor } from '$lib/data/context-menus';
import { columnsMenu } from '$lib/data/menus';
import { useMenu, type MenuItem } from '$lib/hooks/use-menu.svelte';
import { selection } from '$lib/state/selection.svelte';
import type { FileEntry } from '$lib/types/fs';

export const useContextMenu = () => {
  const menu = useMenu();
  let items = $state<MenuItem[]>([]);

  const openAtPointer = (set: MenuItem[], e: MouseEvent) => {
    e.preventDefault(); // never WebView2's own menu
    items = set;
    menu.openAt(e.clientX, e.clientY);
  };

  const onRow = (entry: FileEntry, e: MouseEvent) => {
    e.stopPropagation();
    if (e.target instanceof HTMLInputElement) return e.preventDefault(); // the rename box
    selection.contextClick(entry.path);
    openAtPointer(rowMenuFor(entry), e);
  };

  const onBackground = (e: MouseEvent) => openAtPointer(backgroundMenuFor(), e);

  /** The details header: Explorer's column picker. */
  const onHeader = (e: MouseEvent) => {
    e.stopPropagation();
    openAtPointer(columnsMenu, e);
  };

  return {
    menu,
    get items() {
      return items;
    },
    onRow,
    onBackground,
    onHeader,
  };
};

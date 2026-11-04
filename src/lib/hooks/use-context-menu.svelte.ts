// The list's right-click menu: which item set (row or background), opened at the pointer,
// with Explorer's select-on-right-click rule. One instance per list; `useMenu` owns
// open/close (outside click, Escape) and the on-screen clamp. On Windows the menu opens with
// Trove's items at once and Windows' own arrive into the same menu (plan 08 D.1).
import { backgroundMenuFor, rowMenuFor } from '$lib/data/context-menus';
import { columnsMenu } from '$lib/data/menus';
import { SHELL_SLOT, fillSlot } from '$lib/data/shell-menu';
import { useMenu, type MenuItem } from '$lib/hooks/use-menu.svelte';
import { listing } from '$lib/state/listing.svelte';
import { selection } from '$lib/state/selection.svelte';
import { shellVerbs } from '$lib/state/shell-verbs.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { FileEntry } from '$lib/types/fs';
import { parentOf } from '$lib/utils/path';

type ShellTarget = { paths: string[]; background: boolean; dir: string };

export const useContextMenu = () => {
  const menu = useMenu();
  let items = $state<MenuItem[]>([]);
  /** which open the pending shell answer belongs to; a newer open makes it stale */
  let opened = 0;

  /** Ask the shell for the slot's rows; drop them if this menu closed or another opened. */
  const fillShell = async (mine: number, target: ShellTarget, extended: boolean) => {
    const rows = await shellVerbs.menuRows(target, extended, items);
    if (mine !== opened || !menu.open) return;
    items = fillSlot(items, rows);
  };

  const openAtPointer = (set: MenuItem[], e: MouseEvent, target?: ShellTarget) => {
    e.preventDefault(); // never WebView2's own menu
    items = set;
    opened += 1;
    menu.openAt(e.clientX, e.clientY);
    if (target && set.some((i) => i.key === SHELL_SLOT)) void fillShell(opened, target, e.shiftKey);
  };

  const onRow = (entry: FileEntry, e: MouseEvent) => {
    e.stopPropagation();
    if (e.target instanceof HTMLInputElement) return e.preventDefault(); // the rename box
    selection.contextClick(entry.path);
    const chosen = listing.rows.filter((r) => selection.has(r.path)).map((r) => r.path);
    const paths = chosen.includes(entry.path) ? chosen : [entry.path];
    const dir = parentOf(entry.path) ?? entry.path;
    openAtPointer(rowMenuFor(entry), e, { paths, background: false, dir });
  };

  const onBackground = (e: MouseEvent) => {
    const here = tabs.active.path;
    openAtPointer(backgroundMenuFor(), e, { paths: [here], background: true, dir: here });
  };

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

// The Recycle Bin view's reactivity: read the bin on every entry and every 2 s while open,
// select rows, restore / purge / empty with Explorer's confirmations, F5 reloads, Delete
// purges, one right-click menu for every row.
import { untrack } from 'svelte';
import { recycleHeaderActions, recycleMenuFor } from '$lib/data/recycle-menu';
import { useMenu, type MenuItem } from '$lib/hooks/use-menu.svelte';
import { confirm } from '$lib/state/confirm.svelte';
import { recycle } from '$lib/state/recycle.svelte';
import { heldByDialog } from '$lib/state/modal.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { RecycleItem } from '$lib/types/recycle';
import { keyedIcon, type KeyedIcon } from '$lib/utils/file-icon';
import { logInfo } from '$lib/api/log';
import { startBinPoll } from '$lib/utils/bin-poll';
import { fmtDate } from '$lib/utils/format';
import { isFinderPurgeKey, isSelectAllKey } from '$lib/utils/key-label';
import { tildeHome } from '$lib/utils/path-display';
import { homeFolder } from '$lib/state/home-folder.svelte';
import { inBinWords, onMac } from '$lib/utils/platform';
import {
  canRestore,
  kindText,
  originText,
  recycleLayout,
  sizeText,
  withoutRestore,
} from '$lib/components/places/recycle-parts/recycle-columns';

export interface RecycleRowView {
  item: RecycleItem;
  /** the shell's icon for the name's extension (folders are not told apart by trash 5.2); off
   *  Windows the category glyph of the name */
  icon: KeyedIcon;
  deleted: string;
  /** where it came from, or "—" (the macOS Trash does not record it) */
  origin: string;
  /** "Folder", "PDF file" — shown in the macOS Trash layout */
  kind: string;
  /** "12 KB", or "—" — shown in the macOS Trash layout */
  size: string;
  selected: boolean;
}

const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

export const useRecycleView = () => {
  const menu = useMenu();
  let items = $state<MenuItem[]>([]);
  // ⛔ The macOS Trash keeps no original location, so there is nothing to restore to: Restore,
  // Restore all and Open original location are not offered there (S1).
  const mac = onMac();
  const layout = recycleLayout(mac);

  // Entering the bin re-reads it: this view is mounted afresh on every arrival, and the bin
  // fills up while it is away. Untracked so the read's own writes cannot re-run this — one
  // read per entry. While the view stays open a timer re-reads it quietly, so a file binned
  // from Explorer shows up without F5 (plan 15 E.2.6); leaving the view stops the timer.
  $effect(() => {
    untrack(() => void recycle.load());
    return startBinPoll(() => recycle.poll());
  });

  const rows = $derived<RecycleRowView[]>(
    recycle.items.map((item) => ({
      item,
      icon: keyedIcon(item.isDir ? 'folder' : `ext/${extOf(item.name)}`, 16, item.name),
      deleted: fmtDate(item.deletedMs),
      origin: tildeHome(originText(item), homeFolder.path), // home as `~` (display only)
      kind: kindText(item),
      size: sizeText(item),
      selected: recycle.isSelected(item.id),
    })),
  );

  const selectedIds = () => [...recycle.selected];

  const restoreSelected = () => recycle.restore(selectedIds());

  const purgeSelected = async () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    const one = ids.length === 1;
    const isDir = one && recycle.items.find((i) => i.id === ids[0])?.isDir === true;
    const ok = await confirm.ask({
      title: !one ? 'Delete Multiple Items' : isDir ? 'Delete Folder' : 'Delete File',
      message: `Are you sure you want to permanently delete ${one ? 'this item' : `these ${ids.length} items`}?`,
      okLabel: 'Delete',
      danger: true,
    });
    if (ok) await recycle.purge(ids);
  };

  const empty = async () => {
    // ⭐ The count is read again here, not taken from the last listing. `recycle.empty()` purges
    // whatever is in the bin when it runs, and the bin grows from every delete elsewhere in the
    // app while this view is away — so a stale number would have the person agree to less than
    // gets destroyed. Explorer counts at the moment it asks; so does Trove.
    const count = await recycle.countNow();
    if (count === 0) return;
    logInfo(`frontend: recycle empty confirming ${count} item(s)`);
    const ok = await confirm.ask({
      title: 'Delete Multiple Items',
      message: `Are you sure you want to permanently delete all ${count} items?`,
      okLabel: 'Yes',
      danger: true,
    });
    if (!ok) return;
    await recycle.empty();
    logInfo(`frontend: recycle empty returned, ${recycle.count} item(s) left`);
  };

  const restoreAll = () => recycle.restore(recycle.items.map((i) => i.id));

  /** Navigate the tab to the folder the one selected item was deleted from. */
  const openLocation = () => {
    const [id] = selectedIds();
    const item = recycle.items.find((i) => i.id === id);
    if (item?.originalParent) void tabs.active.navigate(item.originalParent);
  };

  // Derived, not built once: the "Empty Recycle Bin" / "Empty Trash" label reads `binName()`,
  // which follows the "I'm coming from" style live (plan 19, 1.4) while the bin stays open.
  const headerActions = $derived(withoutRestore(recycleHeaderActions({ empty, restoreAll }), !mac));

  const onRowClick = (item: RecycleItem, e: MouseEvent) => {
    e.stopPropagation();
    recycle.select(item.id, { ctrl: e.ctrlKey });
  };

  const onBackgroundClick = () => recycle.clearSelection();

  const oncontextmenu = (item: RecycleItem, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!recycle.isSelected(item.id)) recycle.select(item.id);
    const chosen = recycle.items.filter((i) => recycle.isSelected(i.id));
    items = withoutRestore(
      recycleMenuFor(recycle.selected.size, {
        restore: restoreSelected,
        purge: purgeSelected,
        openLocation,
      }),
      canRestore(mac, chosen),
    );
    menu.openAt(e.clientX, e.clientY);
  };

  const onkeydown = (e: KeyboardEvent) => {
    if (heldByDialog(e)) return; // Delete here would purge behind "Empty the Recycle Bin?"
    // ⌥⌘⌫ purges on a Mac (Ctrl+Alt+Backspace on Windows coming from Mac, never on Linux), as
    // Finder's Delete Immediately (exact modifiers; the same Confirm as Delete)
    if (isFinderPurgeKey(e)) {
      void purgeSelected();
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'F5':
        void recycle.reload();
        break;
      case 'Delete':
        void purgeSelected();
        break;
      case 'Escape':
        recycle.clearSelection();
        break;
      case 'a':
      case 'A':
        if (!isSelectAllKey(e)) return;
        recycle.selectAll();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return {
    menu,
    get headerActions() {
      return headerActions;
    },
    /** `bin`: Original location + Date deleted; `trash` (macOS): Kind + Size + Date modified */
    layout,
    get items() {
      return items;
    },
    get rows() {
      return rows;
    },
    get count() {
      return recycle.count;
    },
    get loading() {
      return recycle.loading;
    },
    // Rust's sentence names the host's bin; show it in the chosen style's word (plan 19 Q3)
    get error() {
      return recycle.error === null ? null : inBinWords(recycle.error);
    },
    onRowClick,
    onBackgroundClick,
    oncontextmenu,
    onkeydown,
  };
};

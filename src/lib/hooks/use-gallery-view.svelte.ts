// The Gallery view's reactivity: load on mount, open a thumbnail with its app, reveal it in
// its folder, F5 reloads, one right-click menu for every thumbnail. The grid reads a
// `GallerySource`: the Pictures listing (the Gallery place) or one folder's own files (a folder
// in Gallery view, plan 15 G.52).
import { galleryMenuFor } from '$lib/data/gallery-menu';
import { useMenu, type MenuItem } from '$lib/hooks/use-menu.svelte';
import { actions } from '$lib/state/actions.svelte';
import {
  columnsFor,
  folderGalleryGroups,
  linesInView,
  planGallery,
  type GallerySource,
} from '$lib/state/gallery.svelte';
import { heldByDialog } from '$lib/state/modal.svelte';
import { selection } from '$lib/state/selection.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { FileEntry } from '$lib/types/fs';
import { locationLabel } from '$lib/utils/location';
import { parentOf } from '$lib/utils/path';

/** The scroller's horizontal padding (`px-5` on both sides); thumbnails wrap inside the rest. */
const SIDE_PADDING_PX = 40;

/** The folder on screen as a Gallery feed: its files as listed, F5 re-reads the folder. */
export const folderGallerySource: GallerySource = {
  get label() {
    return `Gallery of ${locationLabel(tabs.active.location)}`;
  },
  get groups() {
    return folderGalleryGroups(tabs.active.visible);
  },
  get count() {
    return tabs.active.visible.length;
  },
  get loading() {
    return tabs.active.loading;
  },
  get error() {
    return tabs.active.error;
  },
  get loadingText() {
    return tabs.active.loadingText;
  },
  emptyText: 'This folder is empty.',
  reveal: false,
  // the tab lists its folder on navigation; nothing more to ask for on mount
  load: () => {},
  reload: () => void tabs.active.refresh(),
};

export const useGalleryView = (source: () => GallerySource) => {
  const menu = useMenu();
  let items = $state<MenuItem[]>([]);

  // Where the scroller is and how big: enough to know which lines are near the viewport.
  let scrollTop = $state(0);
  let viewport = $state(800);
  let width = $state(1000);
  const src = $derived(source());
  const plan = $derived(planGallery(src.groups, columnsFor(width - SIDE_PADDING_PX)));
  const visible = $derived(linesInView(plan.lines, scrollTop, viewport));

  /** A Svelte action for the scroller: feeds scroll position and size into the window above. */
  const track = (node: HTMLElement) => {
    const sync = () => {
      scrollTop = node.scrollTop;
      viewport = node.clientHeight;
      width = node.clientWidth;
    };
    sync();
    node.addEventListener('scroll', sync, { passive: true });
    const resize = new ResizeObserver(sync);
    resize.observe(node);
    return {
      destroy() {
        node.removeEventListener('scroll', sync);
        resize.disconnect();
      },
    };
  };

  $effect(() => {
    const shown = src;
    shown.load();
    return () => shown.unload?.();
  });

  const open = (entry: FileEntry) => void actions.open(entry);

  /** Navigate the tab to the item's folder and select it there. */
  const reveal = async (entry: FileEntry) => {
    const parent = parentOf(entry.path);
    if (!parent) return;
    await tabs.active.navigate(parent);
    selection.reveal(entry.path);
  };

  const oncontextmenu = (entry: FileEntry, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    items = galleryMenuFor(entry, src.reveal ? { open, reveal } : { open });
    menu.openAt(e.clientX, e.clientY);
  };

  const onkeydown = (e: KeyboardEvent) => {
    if (heldByDialog(e) || e.key !== 'F5') return;
    e.preventDefault();
    src.reload();
  };

  return {
    menu,
    get items() {
      return items;
    },
    track,
    /** the lines worth mounting now, each with its `top` */
    get visible() {
      return visible;
    },
    /** the height of the whole gallery, so the scrollbar is the size of all of it */
    get height() {
      return plan.height;
    },
    get count() {
      return src.count;
    },
    get loading() {
      return src.loading;
    },
    get error() {
      return src.error;
    },
    get label() {
      return src.label;
    },
    get loadingText() {
      return src.loadingText;
    },
    get emptyText() {
      return src.emptyText;
    },
    open,
    reveal,
    oncontextmenu,
    onkeydown,
  };
};

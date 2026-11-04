// The file list's reactivity: row clicks, keyboard navigation, open, the context menu, and
// the virtual window over the rows (the folder's, or a search's — `state/listing`).
import { tick, untrack } from 'svelte';
import { useContextMenu } from '$lib/hooks/use-context-menu.svelte';
import { useDrag } from '$lib/hooks/use-drag.svelte';
import { drag } from '$lib/state/drag.svelte';
import { folderSizes } from '$lib/state/folder-sizes.svelte';
import { useRubberBand } from '$lib/hooks/use-rubber-band.svelte';
import { useVirtualRows } from '$lib/hooks/use-virtual-rows.svelte';
import { actions } from '$lib/state/actions.svelte';
import { heldByDialog } from '$lib/state/modal.svelte';
import { clipboard } from '$lib/state/clipboard.svelte';
import { isHeader, listing } from '$lib/state/listing.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { search } from '$lib/state/search.svelte';
import { selection, type Modifiers } from '$lib/state/selection.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { FileEntry } from '$lib/types/fs';
import {
  TYPE_AHEAD_RESET_MS,
  isTypeAheadKey,
  nextMatch,
  typeAheadStep,
} from '$lib/utils/type-ahead';
import { stepAcrossChunks } from '$lib/utils/chunk-step';
import { stepIconSize, stepView } from '$lib/utils/view-steps';
import { arrowAxis, detailsRowPx } from '$lib/data/view-layouts';
import { onMac } from '$lib/utils/platform';
import { propertiesShortcut } from '$lib/data/shortcuts';
import { finderDeleteKey, isFinderOpenKey, isReturnRenameKey } from '$lib/utils/key-label';
import { KEY_MENU_ECHO_MS, isMenuKey, menuAnchor, menuTarget } from '$lib/utils/key-menu';

/** Ctrl on Windows and Linux, ⌘ on a Mac: the key that adds to a selection and copies. */
const mods = (e: MouseEvent | KeyboardEvent): Modifiers => ({
  ctrl: onMac() ? e.metaKey : e.ctrlKey,
  shift: e.shiftKey,
});

/**
 * Where each tab's keyboard focus last was, as an index into the list. A delete (or a paste)
 * clears `selection.focused`; without this, the first arrow after it started over at the top
 * row — which, when that row is the one already showing, looked like the key was ignored
 * (the Mac check). Keyed by tab, weakly (a closed tab takes its entry with it), and good only
 * in the folder it was taken in.
 */
const lastFocusIndex = new WeakMap<object, { folder: string; at: number }>();

const FORWARD = new Set(['ArrowDown', 'ArrowRight']);

export const useFileList = () => {
  /** What the keyboard and a click-range walk: the rows on screen, folded buckets left out. */
  const order = $derived(listing.shown.map((e) => e.path));
  /**
   * The path at each *rendered* position, which a group heading leaves empty. The band and the
   * scroll-into-view both count lines on screen, not rows; ungrouped the two are the same list
   * and this is `order` itself.
   */
  const positions = $derived<(string | undefined)[]>(
    listing.groupKey === null
      ? order
      : listing.items.map((i) => (isHeader(i) ? undefined : i.path)),
  );
  const menus = useContextMenu();
  /** when the keyboard last opened the menu — the browser's own keyboard `contextmenu` follows */
  let keyMenuAt = -Infinity;
  const contextMenu = {
    get menu() {
      return menus.menu;
    },
    get items() {
      return menus.items;
    },
    onRow: menus.onRow,
    onHeader: menus.onHeader,
    onBackground: (e: MouseEvent) => {
      // the Menu key / Shift+F10 already opened the item's menu: its echo must not replace it
      if (performance.now() - keyMenuAt < KEY_MENU_ECHO_MS) return e.preventDefault();
      menus.onBackground(e);
    },
  };
  const dragging = useDrag();
  const virtual = useVirtualRows(() => listing.items, {
    grouped: () => listing.groupKey !== null,
    isHeader,
  });
  const band = useRubberBand(() => ({
    layout: {
      horizontal: virtual.layout.horizontal,
      chunkSize: virtual.layout.chunkSize,
      perChunk: virtual.perChunk,
      itemSpan: virtual.layout.itemSpan,
      paddingStart: virtual.layout.paddingStart,
      total: positions.length,
      plan: virtual.plan,
    },
    order: positions,
    element: virtual.element,
  }));

  // type-to-select: the letters typed within a second of each other
  let prefix = '';
  let prefixTimer: ReturnType<typeof setTimeout> | null = null;
  const typeAhead = (key: string) => {
    if (prefixTimer !== null) clearTimeout(prefixTimer);
    prefixTimer = setTimeout(() => (prefix = ''), TYPE_AHEAD_RESET_MS);
    // a repeated single letter walks the matches instead of narrowing to `dd`
    const step = typeAheadStep(prefix, key);
    prefix = step.prefix;
    const from = selection.focused === null ? -1 : order.indexOf(selection.focused);
    const i = nextMatch(
      listing.shown.map((r) => r.name),
      from,
      prefix,
      step.grew,
    );
    if (i >= 0) selection.move(order, 0, { ctrl: false, shift: false }, i);
  };

  // A navigation or refresh drops selections that point at rows no longer listed. Against
  // every row the folder has, not the ones on screen: folding a heading shut hides its rows,
  // it does not deselect them.
  $effect(() => {
    selection.retain(listing.rows.map((e) => e.path));
  });

  const open = (entry: FileEntry) => void actions.open(entry);

  const onRowClick = (entry: FileEntry, e: MouseEvent) => {
    e.stopPropagation();
    if (drag.swallowClick()) return; // the click that ends a drag is not a selection click
    // Item check boxes: a click on the box toggles the row as Ctrl would, without the key
    if (settings.itemCheckboxes && (e.target as Element | null)?.closest('[data-check]')) {
      selection.check(entry.path, order, e.shiftKey);
      return;
    }
    selection.click(entry.path, mods(e), order);
  };

  const onBackgroundClick = () => {
    if (bandEnded) {
      bandEnded = false; // the click that ends a band keeps what the band selected
      return;
    }
    selection.clear();
  };
  let bandEnded = false;
  const onBackgroundPointerUp = () => {
    if (band.onpointerup()) bandEnded = true;
  };

  /** Middle-click on a folder row opens it in a new tab. */
  /** Ctrl+wheel steps the view size the way Explorer does: up = bigger, down = smaller. */
  const onZoomWheel = (e: WheelEvent) => {
    if (!e.ctrlKey || e.deltaY === 0) return;
    e.preventDefault();
    const next = stepView(
      { view: tabs.active.view, iconSize: tabs.active.iconSize },
      e.deltaY < 0 ? 1 : -1,
    );
    tabs.active.setView(next.view, stepIconSize(next));
  };

  const onRowAuxClick = (entry: FileEntry, e: MouseEvent) => {
    if (e.button !== 1 || !entry.isDir) return;
    e.preventDefault();
    actions.openInNewTab(entry);
  };

  /**
   * Move across chunks — a row down/up in grid view, a column right/left in list view. Grouped,
   * the plan says where the next row really is (short last rows, headings between groups);
   * ungrouped it is a flat step of `perChunk`.
   */
  const stepChunks = (dir: 1 | -1, m: Modifiers) => {
    // nothing focused yet: the first press lands on the first (or last) row, as in Explorer
    if (selection.focused === null)
      return selection.move(order, 0, m, dir > 0 ? 0 : order.length - 1);
    const plan = virtual.plan;
    const to = plan ? stepAcrossChunks(plan, positions, order, selection.focused, dir) : null;
    if (to !== null) selection.move(order, 0, m, to);
    // nothing further that way on a grouped list: stay, rather than jump by a flat stride
    else if (plan && order.includes(selection.focused)) selection.move(order, 0, m);
    else selection.move(order, dir * virtual.perChunk, m);
  };

  /** What each arrow does in the current view: a step of one, a hop across chunks, or nothing. */
  const arrows = (): Record<string, (m: Modifiers) => void> | null => {
    const one = (delta: number) => (m: Modifiers) => selection.move(order, delta, m);
    const hop = (dir: 1 | -1) => (m: Modifiers) => stepChunks(dir, m);
    const axis = arrowAxis(virtual.layout);
    if (axis === 'rows')
      return { ArrowDown: hop(1), ArrowUp: hop(-1), ArrowRight: one(1), ArrowLeft: one(-1) };
    if (axis === 'columns')
      return { ArrowDown: one(1), ArrowUp: one(-1), ArrowRight: hop(1), ArrowLeft: hop(-1) };
    return { ArrowDown: one(1), ArrowUp: one(-1) };
  };

  /** A menu event at a point on screen, for the existing right-click handlers. */
  const pointAt = ({ x, y }: { x: number; y: number }) =>
    new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: false, cancelable: true });

  /**
   * The Menu key / Shift+F10: the selected item's menu at the item (scrolled into view first,
   * as the row may not be rendered), or the folder's menu when nothing is selected.
   */
  const openMenuFromKeyboard = async () => {
    const grid = virtual.element;
    if (!grid) return;
    keyMenuAt = performance.now();
    const path = menuTarget(selection.focused, selection.has, order);
    const entry = path === null ? undefined : listing.shown.find((x) => x.path === path);
    if (!entry) return menus.onBackground(pointAt(menuAnchor(grid.getBoundingClientRect(), false)));
    const index = positions.indexOf(entry.path);
    if (index >= 0) {
      virtual.scrollToItem(index);
      await tick();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const row = index >= 0 ? grid.querySelector(`[aria-rowindex="${index + 1}"]`) : null;
    const rect = (row ?? grid).getBoundingClientRect();
    keyMenuAt = performance.now();
    menus.onRow(entry, pointAt(menuAnchor(rect, row !== null)));
  };

  /** Return (and ⌘O, ⌘↓ on a Mac): open the focused item; with Shift, a folder in a new window. */
  const openFocused = (newWindow: boolean) => {
    const focused = listing.shown.find((x) => x.path === selection.focused);
    if (!focused) return;
    if (newWindow && focused.isDir) actions.openInNewWindow(focused);
    else open(focused);
  };

  const rememberFocus = () => {
    const at = selection.focused === null ? -1 : order.indexOf(selection.focused);
    if (at >= 0) lastFocusIndex.set(tabs.active, { folder: tabs.active.path, at });
  };

  /**
   * The first arrow after a paste or a delete, which leave no focused row: carry on from what
   * is selected (the pasted items), or else from where the focus was (the row that took the
   * deleted one's place is the first stop going forward).
   */
  const resumeFocus = (forward: boolean, m: Modifiers): boolean => {
    if (selection.focused !== null || order.length === 0) return false;
    const picked = order.filter((p) => selection.has(p));
    if (picked.length > 0) {
      selection.focused = forward ? picked[picked.length - 1] : picked[0];
      return false;
    }
    const last = lastFocusIndex.get(tabs.active);
    if (last === undefined || last.folder !== tabs.active.path) return false;
    const { at } = last;
    // the row now at `at` took the deleted one's place: forward lands on it, back on the one
    // before it (the last row, when the deleted one was last)
    const target = Math.min(forward ? at : at - 1, order.length - 1);
    if (target < 0) return false; // back from the top: the arrow's own first-row rule
    selection.move(order, 0, m, target);
    return true;
  };

  const onkeydown = (e: KeyboardEvent) => {
    if (heldByDialog(e)) return; // the keys are the dialog's (focus is in it once it mounts)
    if (actions.renaming !== null) return; // the rename box owns the keyboard
    if (dragging.onKeydown(e)) return; // Escape cancels a drag first
    if (band.onkeydown(e)) return; // … or a rubber band
    if (isMenuKey(e)) {
      e.preventDefault();
      void openMenuFromKeyboard();
      return;
    }
    const m = mods(e);
    rememberFocus();
    // Finder's Open: ⌘O, and ⌘↓ ("go into"), the same as Return — checked before the arrows,
    // where ⌘↓ would only move the focus. On a PC coming from Mac it is Ctrl+O / Ctrl+↓, so
    // Explorer's "Ctrl+arrow moves the focus only" is gone for ↓ under that style (plan 19, 2.3.1).
    if (isFinderOpenKey(e)) {
      openFocused(false);
      e.preventDefault();
      return;
    }
    const arrow = arrows()?.[e.key];
    if (arrow) {
      if (!resumeFocus(FORWARD.has(e.key), m)) arrow(m);
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'Home':
        selection.move(order, 0, m, 0);
        break;
      case 'End':
        selection.move(order, 0, m, order.length - 1);
        break;
      case 'PageDown':
        selection.move(order, virtual.viewportItems, m);
        break;
      case 'PageUp':
        selection.move(order, -virtual.viewportItems, m);
        break;
      case ' ':
        // Explorer: Ctrl+Space toggles, Shift+Space extends, plain Space selects if nothing is.
        // On a Mac ⌘Space is Spotlight, so the raw Ctrl key toggles there too (Joy 2026-10-23).
        if (m.ctrl || (onMac() && e.ctrlKey)) selection.toggleFocused();
        else if (m.shift) selection.extendTo(order);
        else if (selection.count === 0 && selection.focused !== null)
          selection.click(selection.focused, m, order);
        break;
      case 'Enter': {
        if (e.altKey) {
          // plain Alt+Enter is Properties, a window shortcut (data/shortcuts.ts): let it bubble
          // there; with Ctrl, ⌘ or Shift as well no window chord matches, so the list runs it
          if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
          void propertiesShortcut.run();
          break;
        }
        // Finder's Return renames under Mac style (⌘O / ⌘↓ open, above); Explorer's opens
        if (isReturnRenameKey(e)) {
          if (selection.focused !== null && selection.has(selection.focused)) actions.startRename();
          break;
        }
        openFocused(e.shiftKey);
        break;
      }
      case 'Escape':
        // Search results: the first Escape drops the selection, the next one (nothing left to
        // drop) closes the results and puts the folder back, as Escape in the search box does.
        if (search.active && selection.count === 0) search.clear();
        else selection.deselect(); // the focused row stays: Space or an arrow goes on from it
        break;
      case 'F2':
        actions.startRename();
        break;
      case 'Delete':
        // Shift+Delete skips the Recycle Bin (after a question), as in Explorer
        if (m.shift) void actions.deletePermanently();
        else void actions.deleteSelected();
        break;
      case 'F5':
        void tabs.active.refresh();
        break;
      case 'Backspace': {
        // ⌘⌫ moves to the Trash and ⌥⌘⌫ deletes permanently, as in Finder (the Mac's "delete"
        // key is Backspace) — Ctrl+Backspace / Ctrl+Alt+Backspace on a PC coming from Mac;
        // plain Backspace stays the window's Back. Exact chords (`finderDeleteKey`): ⌥⌘⌫ must
        // not ALSO match ⌘⌫ (it used to — straight to the Trash, no question asked), ⌃ or ⇧
        // with them is neither, AltGr+Backspace on a PC is neither.
        // ⛔ Only these two routes: deletePermanently() asks first, deleteSelected() goes to the
        // bin (a path with no bin falls to the asked, permanent route there).
        const del = finderDeleteKey(e);
        if (del === 'permanent') void actions.deletePermanently();
        else if (del === 'bin') void actions.deleteSelected();
        break;
      }
      case 'N':
      case 'n':
        // Ctrl+Shift+N (new folder) is a window shortcut now (data/shortcuts.ts), not the list's
        if (m.ctrl) return;
        if (isTypeAheadKey(e)) typeAhead(e.key);
        break;
      case 'a':
      case 'A':
        if (!m.ctrl) {
          if (isTypeAheadKey(e)) typeAhead(e.key);
          break;
        }
        selection.selectAll(order);
        break;
      case 'x':
      case 'X':
        if (!m.ctrl) {
          if (isTypeAheadKey(e)) typeAhead(e.key);
          break;
        }
        actions.cut();
        break;
      case 'c':
      case 'C':
        if (!m.ctrl) {
          if (isTypeAheadKey(e)) typeAhead(e.key);
          break;
        }
        if (m.shift) void actions.copyAsPath();
        else actions.copy();
        break;
      case 'v':
      case 'V':
        if (!m.ctrl) {
          if (isTypeAheadKey(e)) typeAhead(e.key);
          break;
        }
        void actions.paste();
        break;
      default:
        if (!isTypeAheadKey(e)) return;
        typeAhead(e.key);
        break;
    }
    e.preventDefault();
  };

  // Keep the focused row in view as the keyboard moves it. The row may not be in the DOM yet
  // (virtualized), so this goes through the virtualizer rather than `scrollIntoView`. Only a
  // focus change scrolls — a refresh of the listing must not yank the view back.
  $effect(() => {
    const focused = selection.focused;
    if (focused === null) return;
    // `scrollToItem` reads the plan and items-per-chunk, which change on a resize, a regroup or
    // a watcher refresh; tracked here they would re-run this and scroll with no focus change.
    untrack(() => {
      const index = positions.indexOf(focused);
      if (index >= 0) virtual.scrollToItem(index);
    });
  });

  // A reveal ("Open file location") asks for its row to be fully in view. The folder is still
  // being drawn then, and the tab's scroll restore runs a tick after the navigation lands, so
  // this waits for the row to exist (`positions` is tracked) and for that restore, then scrolls.
  $effect(() => {
    const target = selection.scrollTo;
    if (target === null) return;
    const index = positions.indexOf(target);
    if (index < 0) return;
    let stale = false;
    void tick()
      .then(() => new Promise((r) => requestAnimationFrame(r)))
      .then(() => {
        if (stale) return;
        virtual.scrollToItem(index);
        if (selection.scrollTo === target) selection.scrollTo = null;
      });
    return () => {
      stale = true;
    };
  });

  // Remember where the focus is as it moves, so a delete from the menu (which never passes
  // through the key handler) still leaves the first arrow after it a place to start from.
  $effect(() => {
    if (selection.focused !== null) untrack(rememberFocus);
  });

  // Folder sizes belong to the folder on screen: a move elsewhere (or this list going away)
  // cancels the walks still running for the old one.
  $effect(() => {
    const folder = tabs.active.isFolder ? tabs.active.path : null;
    const choice = settings.folderSizes;
    untrack(() => folderSizes.show(folder, choice));
  });
  $effect(() => () => untrack(() => folderSizes.show(null)));

  // A move to another folder can unmount whatever held focus (the row that was double-clicked,
  // an address bar that closed), which leaves it on <body> and the keyboard dead until a click.
  // Put it back on the grid — but only from <body>: a focused address bar, rename box, palette
  // or terminal is left alone.
  $effect(() => {
    void tabs.active.location;
    void tabs.activeIndex;
    const grid = virtual.element;
    if (!grid) return;
    void tick().then(() => {
      const held = document.activeElement;
      if (held === null || held === document.body) grid.focus({ preventScroll: true });
    });
  });

  return {
    /** Compact view's row height for `--spacing-row`, or undefined to leave the token alone */
    get compactRowPx() {
      return settings.compactView ? `${detailsRowPx(onMac(), true)}px` : undefined;
    },
    onZoomWheel,
    contextMenu,
    drag: dragging,
    isRenaming: (path: string) => actions.renaming === path,
    /** cut rows render dimmed until they are pasted */
    isCut: clipboard.isCut,
    isSelected: selection.has,
    isFocused: (path: string) => selection.focused === path,
    open,
    onRowClick,
    onRowAuxClick,
    onBackgroundClick,
    onBackgroundPointerUp,
    band,
    onkeydown,
    virtual,
  };
};

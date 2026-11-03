// The sidebar's reactivity: which item is active, what a click does, expand / collapse of
// nodes and section headers (persisted), which sections are drawn, the right-click menu, and the drag handle on the
// right edge that resizes it (persisted through settings).
import { openTerminal } from '$lib/api/shell';
import { isActiveLocation } from '$lib/data/sidebar-active';
import { sidebarMenuFor } from '$lib/data/sidebar-menu';
import {
  DRIVES_KEY,
  isExpanded,
  sidebarSections,
  type SidebarItem,
  type SidebarSection,
} from '$lib/data/sidebar-sections';
import { useDropTarget } from '$lib/hooks/use-drop-target.svelte';
import { useMenu, type MenuItem } from '$lib/hooks/use-menu.svelte';
import { actions } from '$lib/state/actions.svelte';
import { places } from '$lib/state/places.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tabs } from '$lib/state/tabs.svelte';

export const useSidebar = () => {
  const drop = useDropTarget();
  const menu = useMenu();
  let items = $state<MenuItem[]>([]);
  let dragging = $state(false);
  let startX = 0;
  let startWidth = 0;

  const isActive = (item: SidebarItem) => isActiveLocation(tabs.active.location, item.location);
  const isDragover = (item: SidebarItem) =>
    item.location?.kind === 'path' && drop.isTarget(item.location.path, 'sidebar');

  const select = (item: SidebarItem) => {
    if (item.run) return void item.run();
    if (item.location) void tabs.active.navigate(item.location);
  };

  /** a section header's label: where it points (Drives → This PC) */
  const open = (section: SidebarSection) => {
    if (section.location) void tabs.active.navigate(section.location);
  };

  const toggle = (key: string) => settings.toggleCollapsed(key);

  // a section with no rows is not drawn (no Linux header off Windows), unless it asks to be.
  // ⛔ A folded one is always drawn: its header is the only way to unfold it, and its rows may not
  // be known yet — the drives call waits ~21 s on a dead network letter (plan 15 A.4.9).
  const folded = (s: SidebarSection) => s.title !== undefined && !isExpanded(s.key);
  // ⛔ Unfolded Drives too, while the call is out: no rows yet is not "no drives", and a section
  // that appears only when the slowest letter answers looked like the drives were gone.
  const waiting = (s: SidebarSection) => s.key === DRIVES_KEY && places.drivesLoading;
  const sections = $derived(
    sidebarSections.filter(
      (s) => s.keepWhenEmpty || folded(s) || waiting(s) || s.items().length > 0,
    ),
  );

  const openTerminalAt = async (path: string) => {
    try {
      await openTerminal(path);
    } catch (e) {
      actions.notify(String(e), 'error');
    }
  };

  const oncontextmenu = (item: SidebarItem, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    items = sidebarMenuFor(item, { openTerminal: openTerminalAt });
    menu.openAt(e.clientX, e.clientY);
  };

  /** the row's X: the same Unpin the right-click menu runs */
  const unpin = (item: SidebarItem) => {
    const entry = sidebarMenuFor(item, { openTerminal: openTerminalAt }).find(
      (m) => m.key === 'unpin',
    );
    if (entry?.kind === 'item') entry.run();
  };

  const onHandlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startWidth = settings.sidebarWidth;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHandlePointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    settings.setSidebarWidth(startWidth + (e.clientX - startX));
  };
  const onHandlePointerUp = () => {
    dragging = false;
  };

  return {
    menu,
    get items() {
      return items;
    },
    get width() {
      return settings.sidebarWidth;
    },
    get dragging() {
      return dragging;
    },
    get sections() {
      return sections;
    },
    isActive,
    isDragover,
    isExpanded,
    select,
    open,
    toggle,
    oncontextmenu,
    unpin,
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerUp,
  };
};

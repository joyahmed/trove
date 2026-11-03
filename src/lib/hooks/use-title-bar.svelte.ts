// Caption buttons + drag region for the undecorated window. Tracks maximized state so the
// middle button shows restore vs maximize, like the OS title bar would.
import * as win from '$lib/api/window';
import type { GlyphName } from '$lib/data/glyphs';
import { windowMenuApi, windowMenuFor } from '$lib/data/window-menu';
import { useMenu } from '$lib/hooks/use-menu.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { locationLabel } from '$lib/utils/location';
import { isTauriDragRegion, titleBarDblclickZooms } from '$lib/utils/window-chrome';

export interface CaptionButton {
  key: 'minimize' | 'maximize' | 'close';
  label: string;
  glyph: GlyphName;
  run: () => unknown;
}

export const useTitleBar = () => {
  let maximized = $state(false);

  // Which read of the OS state is the current one. `onResized` fires far faster than the round
  // trip that answers it — every frame of a drag-resize, and again at each end of a snap — so
  // reads overlap as a rule here, not as an exception. Two answers differ exactly when the
  // window was maximized or restored between them, and the stale one landing last leaves the
  // middle caption button offering Maximize on a maximized window until some later resize
  // happens to correct it.
  let generation = 0;

  const sync = async () => {
    const mine = ++generation;
    const now = await win.isMaximized();
    if (mine === generation) maximized = now;
  };

  $effect(() => {
    void sync();
    const unlisten = win.onResized(sync);
    return () => void unlisten.then((f) => f());
  });

  // The OS title follows the active tab — "Downloads - Trove" in the taskbar and Alt+Tab,
  // as Explorer's does; an empty tab is just "Trove".
  $effect(() => {
    const label = locationLabel(tabs.active.location);
    void win.setTitle(label ? `${label} - Trove` : 'Trove');
  });

  const buttons = $derived<CaptionButton[]>([
    { key: 'minimize', label: 'Minimize', glyph: 'minimize', run: win.minimize },
    {
      key: 'maximize',
      label: maximized ? 'Restore' : 'Maximize',
      glyph: maximized ? 'restore' : 'maximize',
      run: win.toggleMaximize,
    },
    { key: 'close', label: 'Close', glyph: 'close', run: win.close },
  ]);

  /** Double-click on the bar toggles maximize, as the OS bar does.
   * ⛔ Not over a drag region, on any OS: there Tauri's own drag script already toggles
   * (tauri `window/scripts/drag.js` — second mousedown on Windows and Linux, mouseup on a Mac),
   * and the webview still delivers the `dblclick` afterwards — a second toggle would undo it. Elsewhere on the bar (a gap in the
   * tab list) the script does nothing, so this zooms. Exactly once either way. */
  const ondblclick = (e: MouseEvent) => {
    if (titleBarDblclickZooms(e.composedPath())) void win.toggleMaximize();
  };

  // The window menu (plan 20.3.2): a right-click on the bar's empty part, the drag region —
  // not on a tab, which has its own menu. use-shell's preventDefault on the shell still runs
  // (bubbling, no stopPropagation), so WebView2's own menu stays hidden either way.
  const menu = useMenu();
  const items = $derived(windowMenuFor(maximized, windowMenuApi));
  const oncontextmenu = (e: MouseEvent) => {
    if (!isTauriDragRegion(e.composedPath())) return;
    e.preventDefault();
    menu.openAt(e.clientX, e.clientY);
  };

  return {
    get maximized() {
      return maximized;
    },
    get buttons() {
      return buttons;
    },
    get items() {
      return items;
    },
    menu,
    ondblclick,
    oncontextmenu,
  };
};

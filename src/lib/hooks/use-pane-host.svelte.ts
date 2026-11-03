// The right-side pane host: which pane is open, its width, and the drag handle on its left
// edge that resizes it (persisted through settings).
import { panes, type PaneKind } from '$lib/state/panes.svelte';

export const usePaneHost = () => {
  let dragging = $state(false);
  let startX = 0;
  let startWidth = 0;

  const onHandlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startWidth = panes.width;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHandlePointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    panes.width = startWidth - (e.clientX - startX);
  };
  const onHandlePointerUp = () => {
    dragging = false;
  };

  return {
    get open(): PaneKind | null {
      return panes.open;
    },
    get width() {
      return panes.width;
    },
    /** the CSS `max-width` that makes the pane give ground before the file list does */
    get maxWidth() {
      return panes.maxWidth;
    },
    get dragging() {
      return dragging;
    },
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerUp,
  };
};

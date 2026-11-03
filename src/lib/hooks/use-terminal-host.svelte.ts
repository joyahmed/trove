// The terminal pane's host: whether it shows, its height, and the drag handle on its top edge.
import { terminal } from '$lib/state/terminal.svelte';

export const useTerminalHost = () => {
  let dragging = $state(false);
  let startY = 0;
  let startHeight = 0;

  const onHandlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startHeight = terminal.height;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHandlePointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    terminal.height = startHeight - (e.clientY - startY);
  };
  const onHandlePointerUp = () => {
    dragging = false;
  };

  return {
    get open() {
      return terminal.open;
    },
    get height() {
      return terminal.height;
    },
    get dragging() {
      return dragging;
    },
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerUp,
  };
};

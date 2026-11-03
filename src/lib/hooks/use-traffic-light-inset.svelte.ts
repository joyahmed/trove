// The room the tab strip leaves for the macOS traffic lights. 0 off a Mac (the strip keeps its
// ordinary padding); on a Mac the inset, except in full screen, where the system hides the
// lights and the room would be an empty gap. Full screen ends in a resize, so `onResized` is
// the signal, as it is for the maximized state in `use-title-bar`.
import * as win from '$lib/api/window';
import { drawsCaptionButtons, tabStripInsetPx } from '$lib/utils/window-chrome';

export const useTrafficLightInset = () => {
  const mac = !drawsCaptionButtons();
  let fullscreen = $state(false);

  $effect(() => {
    if (!mac) return;
    // the newest read wins: resizes fire faster than the round trip answers them
    let generation = 0;
    const sync = async () => {
      const mine = ++generation;
      const now = await win.isFullscreen();
      if (mine === generation) fullscreen = now;
    };
    void sync();
    const unlisten = win.onResized(sync);
    return () => void unlisten.then((f) => f());
  });

  return {
    /** Whether the strip starts with the drag-region room for the lights. */
    get show() {
      return mac;
    },
    /** That room's width in px: the inset, or the ordinary padding in full screen. */
    get px() {
      return tabStripInsetPx(fullscreen);
    },
  };
};

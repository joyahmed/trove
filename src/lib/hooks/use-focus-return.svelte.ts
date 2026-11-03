// A dialog's focus: called while the dialog component initialises, it remembers what had the
// keyboard and hands it back when the dialog unmounts (utils/focus-return). `trap`, put on the
// dialog's panel (`use:dialog.trap`, `tabindex="-1"`), takes focus into the panel as it opens
// and keeps Tab inside it (utils/focus-trap).
import { captureFocus } from '$lib/utils/focus-return';
import { enterTrap, isTopTrap, leaveTrap, wrapTab } from '$lib/utils/focus-trap';

export const useFocusReturn = () => {
  // captured before `trap` moves focus into the panel, so it is still the opener
  const restore = captureFocus();
  // the effect's teardown runs when the component is destroyed — the dialog closing
  $effect(() => restore);

  let mounted: HTMLElement | undefined;

  const trap = (panel: HTMLElement) => {
    mounted = panel;
    enterTrap(panel, document);
    // capture phase: Tab is wrapped before anything inside the panel sees it
    const onkeydown = (e: KeyboardEvent) => void wrapTab(e, panel, document);
    window.addEventListener('keydown', onkeydown, true);
    return {
      destroy() {
        window.removeEventListener('keydown', onkeydown, true);
        leaveTrap(panel);
        mounted = undefined;
      },
    };
  };
  /** is this dialog the topmost one? Only the top dialog's key handler may act (focus-trap). */
  const isTop = () => isTopTrap(mounted);
  return { trap, isTop };
};

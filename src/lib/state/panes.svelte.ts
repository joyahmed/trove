// Which right-side pane is open (Explorer shows one at a time: Details or Preview) and how
// wide it is. Width is persisted through settings, and so is whether Preview is the open pane
// (a new install opens it on a wide window); Details is per session.
import { previewFits } from '$lib/data/panes';
import { notices } from '$lib/state/notices.svelte';
import { settings } from '$lib/state/settings.svelte';

export type PaneKind = 'details' | 'preview';

const MIN_WIDTH = 200;
const MAX_WIDTH = 720;
/**
 * The width the file list is owed before the pane is allowed to take any more. The four default
 * columns cannot all fit at the 800px minimum window, so this is their *minimum* widths — Name
 * 120 + Date modified 80 + Type 60 + Size 50 = 310 (data/file-columns) — plus the list's own
 * `pl-5 pl-1 pr-1` gutters, rounded up. Below it the list is a name-only sliver with Date, Type
 * and Size scrolled out of reach: at a 720px window the pane's 320 left it just 132px.
 */
export const LIST_MIN_WIDTH = 360;

class PanesState {
  #details = $state(false);

  get open(): PaneKind | null {
    return this.#details ? 'details' : settings.previewOpen ? 'preview' : null;
  }
  set open(kind: PaneKind | null) {
    this.#details = kind === 'details';
    settings.previewOpen = kind === 'preview';
  }

  get width() {
    return settings.paneWidth;
  }
  set width(px: number) {
    settings.paneWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));
  }

  /**
   * A CSS length for the pane's `max-width`: the pane is the accessory, so it is what yields
   * when the window gets narrow — down to `MIN_WIDTH` and no further, at which point the list
   * gives ground again. Left as CSS rather than a number so the viewport half stays live
   * without a resize listener; the sidebar half is state, so it is read here.
   */
  get maxWidth() {
    const reserved = settings.sidebarWidth + LIST_MIN_WIDTH;
    return `max(${MIN_WIDTH}px, calc(100vw - ${reserved}px))`;
  }

  isOpen = (kind: PaneKind) => this.open === kind;

  /**
   * Toggle a pane; opening one closes the other. An open Preview the window is too narrow to
   * show is not closed (nothing would visibly change, and previewOpen:false would be saved): the
   * user is told to widen the window instead. The same goes for Details open when Preview was
   * asked for: swapping would close Details and show nothing, so Details stays and the user is told.
   */
  toggle(kind: PaneKind) {
    if (
      kind === 'preview' &&
      this.open !== null &&
      !previewFits(window.innerWidth, settings.sidebarWidth)
    ) {
      // one notice however often the key is pressed: drop the one still showing
      const message = 'Widen the window to see the preview';
      for (const n of notices.list.filter((x) => x.message === message)) notices.dismiss(n.id);
      notices.push({ kind: 'info', message });
      return;
    }
    this.open = this.open === kind ? null : kind;
  }

  close() {
    this.open = null;
  }
}

export const panes = new PanesState();

// The list's pointer-drag: a press on a row becomes a drag after 4 px of travel, the ghost
// follows the pointer, `[data-drop]` elements under it are targets. State lives in
// `state/drag`; this hook owns the DOM side (pointer capture, hit-testing) and the handlers.
import { drag, type DropKind, type DropTarget } from '$lib/state/drag.svelte';
import { selection } from '$lib/state/selection.svelte';
import type { FileEntry } from '$lib/types/fs';
import { logError } from '$lib/api/log';
import { onMac } from '$lib/utils/platform';

const DRAG_THRESHOLD_PX = 4;

interface Press {
  x: number;
  y: number;
  entry: FileEntry;
  el: Element;
  pointerId: number;
}

/** `ctrl` here means "the copy key": Option on a Mac (Finder), Ctrl elsewhere. */
const mods = (e: PointerEvent) => ({ ctrl: onMac() ? e.altKey : e.ctrlKey, shift: e.shiftKey });

/** The drop target under a point: the nearest `[data-drop]` ancestor of what is there. */
const targetAt = (x: number, y: number): DropTarget | null => {
  // the one DOM lookup: pointer capture keeps events on the row, so hit-test by geometry
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop]');
  if (!el) return null;
  const tab = el.dataset.dropTab;
  return {
    path: el.dataset.drop ?? '',
    kind: (el.dataset.dropKind ?? 'row') as DropKind,
    tab: tab === undefined ? null : Number(tab),
  };
};

export const useDrag = () => {
  let press: Press | null = null;
  let captured: { el: Element; pointerId: number } | null = null;
  drag.resolveTarget = targetAt;
  drag.viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
  // when the drag leaves the window the OS takes it; the capture must go first or WebView2
  // keeps eating the mouse the OLE loop needs
  drag.releasePointer = () => {
    if (captured === null) return;
    try {
      captured.el.releasePointerCapture(captured.pointerId);
    } catch (e) {
      logError('drag.releasePointerCapture', e);
      // already released, or the row unmounted
    }
    captured = null;
  };

  const onRowPointerDown = (entry: FileEntry, e: PointerEvent) => {
    if (e.button !== 0 || e.target instanceof HTMLInputElement) return;
    e.stopPropagation(); // a press on a row is never the start of a rubber band
    drag.pressed();
    press = {
      x: e.clientX,
      y: e.clientY,
      entry,
      el: e.currentTarget as Element,
      pointerId: e.pointerId,
    };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (drag.dragging) {
      // the button is up but no pointerup reached us (the OS took it): the drag is over, and
      // a move with the button up must never hand off to the OS — the Mac side trusts this
      if (!(e.buttons & 1)) {
        captured = null;
        drag.cancel();
        return;
      }
      drag.move(e.clientX, e.clientY, mods(e));
      return;
    }
    if (press === null) return;
    if (!(e.buttons & 1)) {
      press = null;
      return;
    }
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX) return;
    const { entry, el, pointerId } = press;
    press = null;
    const paths = selection.has(entry.path) ? [...selection.paths] : [entry.path];
    try {
      el.setPointerCapture(pointerId);
      captured = { el, pointerId };
    } catch (e) {
      logError('drag.setPointerCapture', e);
      // the row may have been unmounted by a virtualizer scroll; window events still arrive
    }
    drag.start(paths, e.clientX, e.clientY, entry);
  };

  const onPointerUp = (e: PointerEvent) => {
    press = null;
    captured = null;
    if (!drag.dragging) return;
    drag.move(e.clientX, e.clientY, mods(e));
    void drag.drop();
  };

  /**
   * The pointer was taken away (`pointercancel`: the OS claimed it for a gesture;
   * `lostpointercapture`: the row's capture ended without our pointerup): a press in flight
   * is forgotten and a drag in progress is cancelled. After a handoff the state is already
   * reset, so the capture release it causes lands here as a no-op.
   *
   * A spring-open swaps the list, and the captured row leaving the DOM takes its capture with
   * it (the browser fires `lostpointercapture` at the document). The button is still down, so
   * that is no loss of the pointer: the drag goes on and the body takes the capture over.
   */
  const onPointerCancel = (e?: PointerEvent) => {
    if (e?.type === 'lostpointercapture' && drag.dragging && captured?.el.isConnected === false) {
      const { pointerId } = captured;
      captured = null;
      try {
        document.body.setPointerCapture(pointerId);
        captured = { el: document.body, pointerId };
      } catch (err) {
        logError('drag.recapture', err);
        // the pointer is already up; window events still arrive, the pointerup ends the drag
      }
      return;
    }
    press = null;
    captured = null;
    if (drag.dragging) drag.cancel();
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !drag.dragging) return false;
    drag.cancel();
    e.preventDefault();
    return true;
  };

  return {
    get dragging() {
      return drag.dragging;
    },
    isTarget: (path: string, surface: DropKind) => drag.isTarget(path, surface),
    isTargetTab: (index: number) => drag.isTargetTab(index),
    onRowPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onKeydown,
  };
};

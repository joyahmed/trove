// The hover infotip on a file-list row: hover a row for the dwell, get a card at the pointer.
// One instance per row component (details, list and grid all mount one), so "only one tip at a
// time" needs no shared state — the pointer is only ever inside one row.
//
// The tip is a passenger, never a participant: it is `pointer-events: none`, and anything that
// makes the list busy takes it down rather than competing with it.
import type { Action } from 'svelte/action';
import { cancelFolderTotals, onFolderTotals, startFolderTotals } from '$lib/api/props';
import { actions } from '$lib/state/actions.svelte';
import { drag } from '$lib/state/drag.svelte';
import { rubberBand } from '$lib/state/rubber-band.svelte';
import type { FileEntry } from '$lib/types/fs';
import type { FolderTotals } from '$lib/types/props';
import { logError } from '$lib/api/log';

/**
 * Windows' own tooltip dwell: `TTDT_INITIAL` defaults to `GetDoubleClickTime()`, 500 ms on a
 * stock machine, and Explorer's infotip inherits it. Long enough that sweeping the pointer down
 * a folder never flashes a card, short enough that stopping on a row feels answered.
 */
export const INFOTIP_DELAY_MS = 500;

/** The card sits this far from the pointer, and never closer than this to a viewport edge. */
const POINTER_GAP = 16;
const EDGE = 8;

export interface InfotipBlockers {
  /** an in-app drag or a drag from another app is over the window */
  dragging: boolean;
  /** a rubber-band rectangle is being pulled */
  banding: boolean;
  /** an inline rename box is open */
  renaming: boolean;
  /** a context menu is up */
  menuOpen: boolean;
}

/** No tip while the list is busy; a card over a drag or a rename box is noise, not help. */
export const isSuppressed = (b: InfotipBlockers): boolean =>
  b.dragging || b.banding || b.renaming || b.menuOpen;

export interface Size {
  width: number;
  height: number;
}

/**
 * Where the card goes. Below-right of the pointer, pulled back inside the viewport exactly as
 * `use-menu`'s popup clamps a flyout, and flipped to sit *above* the pointer when it would run
 * off the bottom — a card that merely slid up would end under the cursor.
 */
export const placeTip = (
  pointer: { x: number; y: number },
  card: Size,
  view: Size,
): { x: number; y: number } => {
  let x = pointer.x + POINTER_GAP;
  let y = pointer.y + POINTER_GAP;
  if (x + card.width > view.width - EDGE) x = Math.max(EDGE, view.width - EDGE - card.width);
  if (y + card.height > view.height - EDGE) {
    y = Math.max(EDGE, pointer.y - POINTER_GAP - card.height);
  }
  return { x, y };
};

/**
 * A context menu is open somewhere. `useMenu`'s `open` is per-instance and a row has no handle
 * on the list's menu, so this reads the same state where it is observable to everyone:
 * `Menu.svelte` renders its `role="menu"` box only while that flag is true. One source of
 * truth, read through its rendering — not a second flag to keep in step.
 */
const menuOpen = () => document.querySelector('[role="menu"]') !== null;

const blockers = (): InfotipBlockers => ({
  dragging: drag.dragging || drag.external,
  banding: rubberBand.active,
  renaming: actions.renaming !== null,
  menuOpen: menuOpen(),
});

/** A folder's running total, as the card's Size row reads it. */
export interface FolderSize {
  /** bytes counted so far; null = the walk has not reported a batch yet */
  bytes: number | null;
  /** the walk finished: the number is final */
  done: boolean;
  /** folders counted as one item and never sized (a Mac media library, ~/Library) */
  notCounted: number;
  /** files + folders walked; 0 with notCounted > 0 = only the protected folder itself */
  items: number;
}

/**
 * The one walk the infotip may have running, across every row. A hover is not a selection: it
 * is started by standing still and ended by moving, so the card that owns the walk changes
 * constantly and two of them must never overlap. `start` takes this over from whoever held it.
 */
let live: FolderSizeJob | null = null;

/** `job` is starting a walk: whoever held the one slot loses it, and its thread with it. */
const takeOver = (job: FolderSizeJob) => {
  if (live && live !== job) live.stop();
  live = job;
};

/** `job`'s walk is over — cancelled or finished — so the slot is free again. */
const release = (job: FolderSizeJob) => {
  if (live === job) live = null;
};

/**
 * The walk behind a folder card's Size row, on the Details pane's protocol
 * (`state/details.svelte.ts`): `startFolderTotals` hands back a job id, every `props:totals`
 * batch carries that id, and `cancelFolderTotals` is the only thing that stops the thread. A
 * batch whose id is not ours belongs to a job we already cancelled and is still draining — it
 * is dropped, never shown, so a walk of `G:\` can never write its number onto a newer card.
 *
 * The pane counts what is selected; this counts what the pointer happens to rest on, so the
 * rules here are stricter: a file never walks, a folder walks only when the dwell elapses, and
 * `stop()` runs on every path that takes the card down.
 */
export class FolderSizeJob {
  /** null = no walk for this card, so the Size row is simply absent */
  size = $state<FolderSize | null>(null);
  #jobId: number | null = null;
  #unlisten: Promise<() => void> | null = null;
  /** batches heard before `startFolderTotals` returned the id; replayed once it is known */
  #early: FolderTotals[] = [];
  /** bumped by `start` and `stop`: an id that arrives after its card is gone is stale */
  #generation = 0;

  /** The dwell elapsed on this entry. A file's size is already in the listing; it starts none. */
  async start(entry: FileEntry) {
    this.stop();
    if (!entry.isDir) return;
    takeOver(this);
    const gen = ++this.#generation;
    this.size = { bytes: null, done: false, notCounted: 0, items: 0 };
    // listen before asking: the first batch can beat the job id back to us
    this.#unlisten = onFolderTotals((t) => this.apply(t));
    let id: number;
    try {
      id = await startFolderTotals(entry.path);
    } catch (e) {
      logError('infotip.startFolderTotals', e);
      if (gen === this.#generation) this.stop();
      return;
    }
    // the card went away while the thread was starting — the id exists, so it must be cancelled
    if (gen !== this.#generation) {
      void cancelFolderTotals(id);
      return;
    }
    this.#jobId = id;
    // a small folder can finish before its id is back: replay what was heard meanwhile
    const early = this.#early;
    this.#early = [];
    for (const t of early) this.apply(t);
  }

  /** One batch. Public because it is the seam a test emits through, as `details.applyTotals` is. */
  apply(t: FolderTotals) {
    if (this.#jobId === null) {
      // listening but no id yet: hold the batch until the id says whose it is
      if (this.#unlisten) this.#early.push(t);
      return;
    }
    if (t.jobId !== this.#jobId) return;
    this.size = {
      bytes: t.bytes,
      done: t.done,
      notCounted: t.notCounted,
      items: t.files + t.folders,
    };
    if (t.done) this.#settle();
  }

  /** Take the walk down: cancel the thread, drop the listener, forget the number. */
  stop() {
    this.#generation++;
    if (this.#jobId !== null) void cancelFolderTotals(this.#jobId);
    this.#settle();
    this.size = null;
  }

  /** Nothing is running any more: no id left to cancel, no event left to hear. */
  #settle() {
    this.#jobId = null;
    this.#early = [];
    const unlisten = this.#unlisten;
    this.#unlisten = null;
    if (unlisten) void unlisten.then((off) => off());
    release(this);
  }
}

export const useInfotip = (entry: () => FileEntry) => {
  /** the dwell is running */
  let pending = $state(false);
  /** the path the card is up for; null = no card */
  let shownPath = $state<string | null>(null);
  let x = $state(0);
  let y = $state(0);
  // the raw pointer point, kept off $state: only `placeTip` reads it, and only once
  let px = 0;
  let py = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const folder = new FolderSizeJob();

  // Every way the card can go — the pointer leaving, a drag or a menu starting, a scroll, the
  // row being recycled, the component unmounting — arrives here, which is why this is where the
  // walk is cancelled. There is no second exit for the card and so none for the job either.
  const hide = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = false;
    shownPath = null;
    folder.stop();
  };

  const onpointerenter = (e: PointerEvent) => {
    hide();
    if (isSuppressed(blockers())) return;
    const hovered = entry();
    px = e.clientX;
    py = e.clientY;
    x = px + POINTER_GAP;
    y = py + POINTER_GAP;
    pending = true;
    timer = setTimeout(() => {
      timer = undefined;
      pending = false;
      // the dwell is long enough for a drag or a menu to have started inside it
      if (isSuppressed(blockers())) return;
      shownPath = hovered.path;
      // A folder's total is the one field the listing cannot carry, and the dwell is the only
      // moment it is affordable: sweeping the pointer down twenty folders walks none of them.
      void folder.start(hovered);
    }, INFOTIP_DELAY_MS);
  };

  /** While the dwell runs the card follows the pointer; once up it stays where it appeared. */
  const onpointermove = (e: PointerEvent) => {
    if (!pending) return;
    px = e.clientX;
    py = e.clientY;
    x = px + POINTER_GAP;
    y = py + POINTER_GAP;
  };

  // Rows are virtualized and recycled: the same component can be handed a different entry.
  // Reading the path makes that a re-run, and the teardown — which also runs on unmount —
  // clears a timer that would otherwise fire for a row that is no longer there, and cancels a
  // walk that would otherwise outlive the card that asked for it.
  $effect(() => {
    void entry().path;
    return hide;
  });

  // A drag, a band or a rename box starting while the tip is up takes it down at once.
  $effect(() => {
    if (!pending && shownPath === null) return;
    if (isSuppressed(blockers())) hide();
  });

  // Scroll moves the row out from under the pointer; a press or a right-click starts something
  // the tip has no business sitting on top of — and both are what close a menu, so this is also
  // how the tip leaves when one opens. Listeners exist only while there is a tip to take down.
  $effect(() => {
    if (!pending && shownPath === null) return;
    const off = () => hide();
    document.addEventListener('scroll', off, true);
    document.addEventListener('pointerdown', off, true);
    document.addEventListener('contextmenu', off, true);
    window.addEventListener('blur', off);
    return () => {
      document.removeEventListener('scroll', off, true);
      document.removeEventListener('pointerdown', off, true);
      document.removeEventListener('contextmenu', off, true);
      window.removeEventListener('blur', off);
    };
  });

  /**
   * `use:` on the card. It is moved to `<body>` first: every row lives inside the virtualizer's
   * translated chunk, and a transformed ancestor becomes the containing block for
   * `position: fixed`, so a card left where it was written would be positioned against the
   * chunk instead of the viewport. Then it is measured and placed, the way `use-menu`'s popup
   * measures itself once rendered.
   */
  const card: Action<HTMLElement> = (el) => {
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    const p = placeTip(
      { x: px, y: py },
      { width: r.width, height: r.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    x = p.x;
    y = p.y;
    return {
      destroy() {
        el.remove();
      },
    };
  };

  return {
    get visible() {
      return shownPath !== null;
    },
    get position() {
      return { x, y };
    },
    /** the running folder total for the card that is up; null for a file and between cards */
    get folderSize() {
      return folder.size;
    },
    onpointerenter,
    onpointermove,
    onpointerleave: hide,
    card,
  };
};

export type Infotip = ReturnType<typeof useInfotip>;

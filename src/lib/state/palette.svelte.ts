// The Spotlight palette's state: the query, the ranked results grouped by category, the
// selection, and how big the window should be — including telling the OS window to be that
// size. Sources are injected so tests run without IPC.
import { logError } from '$lib/api/log';
import { hidePalette, resizePalette } from '$lib/api/palette';
import { paletteCategories } from '$lib/data/palette-categories';
import type { PaletteCategory, PaletteResult, PaletteSource } from '$lib/types/palette';
import { rank, renderOrder } from '$lib/utils/palette-rank';

export const QUERY_DEBOUNCE_MS = 80;
/**
 * How long one paint holds the next one off. Nine sources answer a query, most of them within a
 * few milliseconds of each other; without this each answer was its own re-rank, its own list
 * rebuild and its own OS window resize — "the search is behaving like react re-render with
 * useEffect badly". The first answer still paints immediately (the calculator has to be
 * instant); everything that lands inside the window rides one trailing paint.
 */
export const PAINT_INTERVAL_MS = 60;
/** the input row */
export const COLLAPSED_HEIGHT = 64;
export const ROW_HEIGHT = 44;
export const HEADER_HEIGHT = 24;
export const MAX_HEIGHT = 480;
export const MAX_ROWS = 12;
/**
 * Everything in the results half of the window that is not a header or a row, so the last row is
 * whole instead of sliced: the panel's own 1px border top and bottom, the list's 1px top rule,
 * and its `pt-1 pb-2` padding (Palette.svelte). It used to be a flat 8 and the final row —
 * usually "Search everywhere for …" — lost 7px off its bottom at every result count.
 */
export const LIST_CHROME = 1 + 1 + 1 + 4 + 8;
/**
 * The "↩ Open / Show in folder" footer under the list (Palette.svelte): its 1px top rule, `py-1.5`
 * (6 + 6) and one `text-xs` line (16). It is a sibling of the list, not part of it, so without
 * this the window was exactly as tall as the rows and the last row sat half behind the footer.
 */
export const FOOTER_HEIGHT = 1 + 6 + 16 + 6;

export interface PaletteGroup {
  category: PaletteCategory;
  /** `''` for the trailing block of pinned fallback rows, which is drawn without a header */
  label: string;
  items: PaletteResult[];
}

class PaletteState {
  query = $state('');
  /**
   * The rows in the order they are DRAWN — `groups` flattened. The keyboard walks this and
   * `selected` indexes into it, so the lit row is always the row on screen at that position.
   */
  results = $state.raw<PaletteResult[]>([]);
  /** The same rows, in the same order, cut into the blocks the list draws. */
  groups = $state.raw<PaletteGroup[]>([]);
  selected = $state(0);
  busy = $state(false);
  #sources: PaletteSource[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  /**
   * The person chose this row — arrows, Tab, or the mouse over it. Until they do, the
   * selection belongs to the ranking: a source that answers late re-ranks and the best row is
   * lit again. Once they have chosen, a late source must not move the selection off it.
   */
  #touched = false;
  /**
   * Where the pointer was last seen over the list, or undefined since the rows were last
   * replaced or the pointer left: the first report after that only records where it is.
   */
  #pointer: { x: number; y: number } | undefined;
  /** The keys on screen, in the order they are on screen: what `renderOrder` holds in place. */
  #drawn: string[] = [];
  /** The merge in flight — one slot per source, filled as they answer. */
  #pending: { generation: number; text: string; slots: PaletteResult[][] } | undefined;
  #paintTimer: ReturnType<typeof setTimeout> | undefined;
  /** a paint happened less than `PAINT_INTERVAL_MS` ago */
  #cooling = false;
  /** an answer landed during the cooldown and has not been painted */
  #dirty = false;
  /**
   * The tallest the window has been while this query is in flight. It only ever grows until the
   * query settles, and it does NOT reset when a new query starts — `refresh` clears the rows
   * first (so nothing stale is ever selectable), and without a floor that clearing collapsed the
   * window to the input row and accordioned it back open on every keystroke.
   */
  #floor = $state(COLLAPSED_HEIGHT);
  /** The height the OS window was last asked for; never asked twice for the same one. */
  #sent = -1;
  /**
   * This palette is the Spotlight window, so its height is the window's. False for Find anything:
   * a panel in an explorer window, where a resize would only size the hidden Spotlight window.
   */
  #sizesWindow = true;

  /** The height the window needs for exactly what is on screen: input + headers + rows, capped. */
  get fitHeight() {
    const headers = this.groups.filter((g) => g.label !== '').length;
    return Math.min(
      MAX_HEIGHT,
      COLLAPSED_HEIGHT +
        (this.results.length === 0
          ? 0
          : LIST_CHROME +
            FOOTER_HEIGHT +
            headers * HEADER_HEIGHT +
            this.results.length * ROW_HEIGHT),
    );
  }

  /** What the OS window is asked for: the fit, but never less than it already is mid-query. */
  get height() {
    return Math.max(this.#floor, this.fitHeight);
  }

  configure(sources: PaletteSource[], { sizesWindow = true }: { sizesWindow?: boolean } = {}) {
    this.#sources = sources;
    this.#sizesWindow = sizesWindow;
  }

  /** The palette window is showing this state: make the OS window the size we think it is. */
  syncWindow() {
    this.#sent = -1;
    this.#push();
  }

  /** Grow to fit and tell the OS. Never shrinks — only `#settle` does that. */
  #grow() {
    this.#floor = Math.max(this.#floor, this.fitHeight);
    this.#push();
  }

  /** Nothing is in flight any more: the window may shrink to exactly what is on screen. */
  #settle() {
    this.#floor = this.fitHeight;
    this.#push();
  }

  #push() {
    if (!this.#sizesWindow) return;
    const h = this.height;
    if (h === this.#sent) return;
    this.#sent = h;
    void resizePalette(h).catch((e: unknown) => logError('palette.resize', e));
  }

  /** Typing: debounce, then ask every source and rank the merge; stale answers are dropped. */
  setQuery(text: string) {
    this.query = text;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.refresh(), QUERY_DEBOUNCE_MS);
  }

  /**
   * Ask every source and show each answer the moment it lands.
   *
   * ⛔ **One slow source must never hold the others back, and the rows on screen must always
   * answer the query in the box.** This was a single `Promise.allSettled` that assigned
   * `results` once, at the end — so the palette showed the PREVIOUS query's rows, selectable,
   * for as long as the slowest source took. `filesSource` waits on `places.load()`, whose
   * drive enumeration is measured in *tens of seconds* on a machine with a dead network
   * mapping (`state/places.svelte.ts`), which is both "Spotlight finds nothing on this
   * machine" and — with a stale row still lit under the cursor — how `1+2` opened a log file
   * instead of copying `3`. Clearing first and merging as they arrive is what fixes both: the
   * instant sources (the calculator, the actions) paint in the same tick, the slow ones join.
   *
   * ⛔ A source that rejects is logged, never silently swallowed — "no results" and "the OS
   * call failed" look identical on screen otherwise.
   */
  async refresh() {
    const generation = ++this.#generation;
    const text = this.query;
    this.#stopPaint();
    this.results = [];
    this.groups = [];
    this.#drawn = [];
    this.selected = 0;
    this.#touched = false;
    this.#pointer = undefined;
    if (!text.trim()) {
      this.busy = false;
      this.#settle();
      return;
    }
    this.busy = true;
    // one slot per source, so the merge order stays the source order however they arrive
    const slots: PaletteResult[][] = this.#sources.map(() => []);
    this.#pending = { generation, text, slots };
    await Promise.all(
      this.#sources.map(async (s, i) => {
        try {
          const items = await s.query(text);
          if (generation !== this.#generation) return;
          slots[i] = items;
          this.#schedulePaint();
        } catch (e) {
          logError(`palette.source.${s.key}`, e);
        }
      }),
    );
    if (generation !== this.#generation) return;
    // everything has answered: paint whatever the cooldown was still holding, then let the
    // window settle to exactly what is on screen
    this.#flushPaint();
    this.busy = false;
    this.#settle();
  }

  /**
   * Coalesce the paints. The first answer to a query goes on screen at once — the calculator and
   * the actions answer in the same tick as the keystroke and have to look like it — and every
   * answer that lands within `PAINT_INTERVAL_MS` of it rides a single trailing paint instead of
   * redrawing and resizing the window once per source.
   */
  #schedulePaint() {
    if (this.#cooling) {
      this.#dirty = true;
      return;
    }
    this.#paint();
    // Nothing is on screen yet, so nothing can jump or resize: the next answer paints at once.
    // `calcSource` answers first and answers `[]` for every query that is not arithmetic — it
    // must not spend the window that the sources with rows in them are waiting for.
    if (this.results.length === 0) return;
    this.#cooling = true;
    this.#paintTimer = setTimeout(() => {
      this.#cooling = false;
      if (!this.#dirty) return;
      this.#dirty = false;
      this.#schedulePaint();
    }, PAINT_INTERVAL_MS);
  }

  /** Paint what is held, now: every source has answered, so there is nothing left to wait for. */
  #flushPaint() {
    clearTimeout(this.#paintTimer);
    this.#cooling = false;
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#paint();
  }

  /** A new query, or none: whatever is half-merged is not worth painting. */
  #stopPaint() {
    clearTimeout(this.#paintTimer);
    this.#cooling = false;
    this.#dirty = false;
    this.#pending = undefined;
  }

  /**
   * Rank what has arrived, lay it out in the order it will be drawn, and put it on screen —
   * keeping the person on the row they were on. Sources that took the text themselves (path,
   * files) already match; the ranker filters the rest and orders everything; `renderOrder` turns
   * that order into the blocks the list draws, holds rows that are already on screen in place,
   * and puts the `pinLast` fallbacks under it all, outside the cap.
   */
  #paint() {
    const p = this.#pending;
    if (!p || p.generation !== this.#generation) return;
    const merged = p.slots.flat();
    const ideal = rank(
      merged.filter((r) => !r.pinLast),
      p.text,
    );
    const blocks = renderOrder(
      ideal,
      this.#drawn,
      merged.filter((r) => r.pinLast),
      MAX_ROWS,
    );
    const was = this.#touched ? this.results[this.selected]?.key : undefined;
    this.groups = blocks.map((b) => ({
      category: b.category,
      label: b.pinned ? '' : (paletteCategories.find((c) => c.key === b.category)?.label ?? ''),
      items: b.items,
    }));
    this.results = this.groups.flatMap((g) => g.items);
    this.#drawn = this.results.filter((r) => !r.pinLast).map((r) => r.key);
    const i = was === undefined ? -1 : this.results.findIndex((r) => r.key === was);
    this.selected = i < 0 ? 0 : i;
    this.#grow();
  }

  /** ↑ ↓ wrap around. */
  move(delta: number) {
    const n = this.results.length;
    if (n === 0) return;
    this.select((this.selected + delta + n) % n);
  }

  /**
   * Tab: jump to the first row of the next block. The block is found by the row itself, not by
   * its category — the pinned fallbacks are a block of their own and share `category` with the
   * group they came from.
   */
  nextCategory() {
    if (this.groups.length < 2) return;
    const current = this.current;
    const i = current ? this.groups.findIndex((g) => g.items.includes(current)) : -1;
    const next = this.groups[(i + 1) % this.groups.length];
    this.select(this.results.indexOf(next.items[0]));
  }

  /** The person put the selection here (the mouse over a row, or `move`/`nextCategory`). */
  select(index: number) {
    if (index < 0 || index >= this.results.length) return;
    this.selected = index;
    this.#touched = true;
  }

  /**
   * The pointer is over row `index` at screen point (`x`, `y`). It selects that row only when the
   * pointer has MOVED since it was last seen over the list.
   *
   * ⛔ A row drawn under a still pointer is not the person choosing it. WebKitGTK reports a hover
   * when rows re-render under a resting pointer; that hover used to `select` (and so "touch") the
   * row. Seen on Ubuntu at 82e2ee7: `calc` drew the `/usr/share/doc/gnome-calculator` folder under
   * the pointer, the hover locked the selection on it, the app answered late and was inserted
   * above, and Enter opened the folder while GNOME Calculator sat on the top row.
   */
  hover(index: number, x: number, y: number) {
    const last = this.#pointer;
    this.#pointer = { x, y };
    if (!last || (last.x === x && last.y === y)) return;
    this.select(index);
  }

  /** The pointer left the list: where it comes back in is not a move over a row. */
  pointerLeft() {
    this.#pointer = undefined;
  }

  get current(): PaletteResult | undefined {
    return this.results[this.selected];
  }

  async run() {
    await this.current?.run();
  }

  async reveal() {
    const r = this.current;
    if (r?.reveal) await r.reveal();
    else await r?.run();
  }

  /** Shown again: start clean — and let the window shrink back to the input row. */
  reset() {
    clearTimeout(this.#timer);
    this.#stopPaint();
    this.#generation++;
    this.query = '';
    this.results = [];
    this.groups = [];
    this.#drawn = [];
    this.selected = 0;
    this.#touched = false;
    this.#pointer = undefined;
    this.busy = false;
    this.#settle();
  }

  async hide() {
    this.reset();
    await hidePalette();
  }
}

export const palette = new PaletteState();

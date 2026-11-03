// The address bar at a narrow width: which crumbs fit WHOLE. The row used to scroll to its
// end and lay a "…" over the start, so a crumb cut mid-letter still showed beside it (the
// 800 px look, 2026-10-06). Now the leading crumbs that do not fit are hidden whole and the "…"
// takes their place; every crumb drawn is drawn in full.

/**
 * The index of the first crumb to show. `widths` are each crumb's width (its chevron
 * included), `room` the row's width, `more` the width of the "…" that stands in for the hidden
 * ones. 0 when the whole path fits. The last crumb (where you are) always shows, even alone in
 * a row too narrow for it.
 */
export const firstWholeCrumb = (widths: readonly number[], room: number, more: number): number => {
  let total = widths.reduce((a, w) => a + w, 0);
  if (total <= room) return 0;
  let start = 0;
  while (start < widths.length - 1 && total + more > room) {
    total -= widths[start];
    start++;
  }
  return start;
};

const width = (el: Element | null) => el?.getBoundingClientRect().width ?? 0;

/**
 * Fit one crumb row now: show every crumb, measure, hide the leading ones that do not fit and
 * show the "…" (`[data-crumb-more]`) only then. The row holds `[data-crumb]` groups (chevron +
 * name; none before the first off Windows). A `[data-crumb-tail]` element (Windows only), if
 * present, is reserved room. ⛔ The last crumb may shrink (its name ends in "…"
 * when even it alone is too wide), so every crumb is measured with `flex-shrink: 0`, or the
 * last one would measure squeezed and the leading ones would never be hidden.
 */
export const fitCrumbRow = (row: HTMLElement): void => {
  const more = row.querySelector<HTMLElement>('[data-crumb-more]');
  const groups = Array.from(row.querySelectorAll<HTMLElement>('[data-crumb]'));
  for (const g of groups) {
    g.style.display = '';
    g.style.flexShrink = '0';
  }
  if (more) more.style.display = '';
  const room = width(row) - width(row.querySelector('[data-crumb-tail]'));
  const start = firstWholeCrumb(groups.map(width), room, width(more));
  groups.forEach((g, i) => {
    g.style.flexShrink = '';
    g.style.display = i < start ? 'none' : '';
  });
  if (more) more.style.display = start > 0 ? '' : 'none';
};

/** What `watchCrumbFit` listens to for a late web font: `document.fonts`, or a test's fake. */
export type FontEvents = Pick<FontFaceSet, 'ready' | 'addEventListener' | 'removeEventListener'>;

/**
 * Keep a crumb row fitted: on resize, when its crumbs change, and when a web font lands.
 * ⛔ The fonts matter: `app.css` loads its faces with `font-display: swap` and a
 * `unicode-range`, so a subset can arrive after the first fit and widen every name — the
 * row's size does not change, so no observer would notice. Returns the cleanup.
 * ⛔ `display` is set on the elements, not through Svelte state: the mutation observer
 * watches children and text only, so hiding a crumb does not trigger it again.
 */
export const watchCrumbFit = (
  row: HTMLElement,
  fonts: FontEvents | undefined = typeof document === 'undefined' ? undefined : document.fonts,
): (() => void) => {
  let live = true;
  let frame = 0;
  const fit = () => {
    if (live) fitCrumbRow(row);
  };
  // ⛔ Widening the window (E.6.9, Ubuntu): the first fit can run before the row has taken its new
  // width, leaving the last crumb cut or gone. Fit once more on the next frame; it settles on the
  // final size. It only sets `display`, so neither observer fires again.
  const refit = () => {
    fit();
    if (typeof requestAnimationFrame === 'undefined') return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fit);
  };
  const ro = new ResizeObserver(refit);
  ro.observe(row);
  const mo = new MutationObserver(fit);
  mo.observe(row, { childList: true, subtree: true, characterData: true });
  fonts?.addEventListener('loadingdone', fit);
  void fonts?.ready.then(fit);
  fit();
  return () => {
    live = false;
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame);
    ro.disconnect();
    mo.disconnect();
    fonts?.removeEventListener('loadingdone', fit);
  };
};

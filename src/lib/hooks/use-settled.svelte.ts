// "Has this tile stayed mounted long enough to deserve a request?" Thumbnails are the
// expensive part of the icon protocol (video, PDF and Office files take the shell tens to
// hundreds of ms each, and they serialize), and dragging the scrollbar through a huge folder
// mounts and unmounts thousands of tiles in a second. `loading="lazy"` cannot help — it only
// defers elements that are not yet laid out, and a virtualized tile is in the DOM at once.
// So each tile asks only after it has survived SETTLE_MS: a tile that is scrolled past is
// unmounted before the timer fires and never makes a request at all.
export const SETTLE_MS = 120;

/** Run `fn` after `ms`; the returned function cancels it. Split out so it can be tested bare. */
export const afterSettle = (fn: () => void, ms = SETTLE_MS): (() => void) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export const useSettled = (ms = SETTLE_MS) => {
  let ready = $state(false);
  $effect(() => afterSettle(() => (ready = true), ms));
  return {
    get ready() {
      return ready;
    },
  };
};

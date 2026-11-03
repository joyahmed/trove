// Keeps an open Recycle Bin view current when the bin changes outside Trove (Explorer, another
// app, a script). Windows tells Explorer through the shell; Trove has no hook into that, so the
// open view re-reads the bin on a short timer instead — only while it is open and the window is
// shown, one read at a time. Entering the view already reads it, so the first poll waits.
import type { RecycleItem } from '$lib/types/recycle';

/** How long a file binned elsewhere may take to show up in the open view. */
export const BIN_POLL_MS = 2000;

/** True when two listings would draw the same rows — then the view keeps the old array. */
export const sameListing = (a: readonly RecycleItem[], b: readonly RecycleItem[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.id === b[i].id &&
      x.name === b[i].name &&
      x.deletedMs === b[i].deletedMs &&
      x.originalParent === b[i].originalParent &&
      x.size === b[i].size &&
      x.isDir === b[i].isDir,
  );

const pageShown = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/**
 * Call `read` every `BIN_POLL_MS` until the returned stop runs. The next wait starts only after
 * a read settles, so a slow bin never stacks reads; a hidden window skips its turn.
 */
export const startBinPoll = (
  read: () => Promise<void>,
  { visible = pageShown }: { visible?: () => boolean } = {},
) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    if (visible()) {
      try {
        await read();
      } catch {
        // a failed poll is retried on the next turn; F5 is where a failure is shown
      }
    }
    if (!stopped) timer = setTimeout(tick, BIN_POLL_MS);
  };
  timer = setTimeout(tick, BIN_POLL_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};

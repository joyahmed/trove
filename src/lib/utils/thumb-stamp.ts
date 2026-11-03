// What makes a thumbnail request "the same file": the listing entry's size and mtime. A picture
// still being copied in changes both as it lands, and an F5 relists it, so the URL (the webview's
// HTTP cache key) and the "this failed" memory both move on and the thumbnail is asked again.
// Unchanged files keep one stamp, so the HTTP cache still answers them.

/** The backend (`icons.rs`, Miss::Passing) treats a file younger than this as maybe still arriving. */
export const FRESH_MS = 10_000;
/** How long to wait before the one automatic second ask after a failure on a fresh file. */
export const RETRY_DELAY_MS = 2_000;

interface Stamped {
  size?: number;
  modifiedMs?: number | null;
}

/** `size-mtime` of a listing entry (`0` when the OS has no mtime). */
export const thumbStamp = (entry: Stamped): string => `${entry.size ?? 0}-${entry.modifiedMs ?? 0}`;

/** True when the file was modified less than `FRESH_MS` ago: its failure may be "not there yet". */
export const isFresh = (modifiedMs: number | null | undefined, now: number = Date.now()): boolean =>
  modifiedMs != null && modifiedMs > 0 && now - modifiedMs < FRESH_MS;

/** The key the failure memory and the one-retry memory are filed under. */
export const thumbKey = (path: string, stamp: string): string => `${path}\u0000${stamp}`;

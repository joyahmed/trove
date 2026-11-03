// When the window's first view counts as painted, for the start-time line (plan 21 gap 6).
// Pure, so the rule is tested without a webview; `use-first-paint` waits for the frame.
import type { Location } from '$lib/types/location';

/** What the active tab shows, as far as this rule needs it. */
export interface PaintTab {
  location: Location;
  loading: boolean;
  error: string | null;
  entries: readonly unknown[];
}

/** The line's view kind and row count, or null while the first view is not ready yet. */
export interface FirstPaint {
  what: string;
  rows: number;
}

/**
 * A folder (or archive) counts once its listing is in and not failed. A place — Home, This PC,
 * the default start — counts once `places` has answered, since those tiles are what it draws.
 * The empty starting tab (path '') never counts: nothing has been asked for yet.
 */
export const firstPaintReady = (tab: PaintTab, placesLoaded: boolean): FirstPaint | null => {
  const at = tab.location;
  if (tab.loading || tab.error !== null) return null;
  if (at.kind === 'path') {
    return at.path === '' ? null : { what: 'folder', rows: tab.entries.length };
  }
  if (at.kind === 'archive') return { what: 'archive', rows: tab.entries.length };
  return placesLoaded ? { what: at.kind, rows: 0 } : null;
};

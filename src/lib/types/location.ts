// Where a tab is. A folder is a path; Home, This PC, Gallery and the Recycle Bin are places
// the shell shows in their own views, with no path behind them. An archive is a zip / 7z /
// tar.* browsed like a folder (plan 16, Phase 4): read-only, and it has no real path either.
// Frontend-only — nothing in Rust knows about places.

export type PlaceKind = 'this-pc' | 'home' | 'gallery' | 'applications' | 'recycle-bin';

export type Location =
  | { kind: 'path'; path: string }
  | { kind: PlaceKind }
  /** `inner` is `/`-separated inside the archive; `''` is its top */
  | { kind: 'archive'; archive: string; inner: string };

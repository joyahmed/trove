// Mirrors src-tauri/src/core/spotlight.rs (serde camelCase) for `AppEntry`; the rest is the
// palette's own shape.
import type { GlyphName } from '$lib/data/glyphs';
import type { FileEntry } from '$lib/types/fs';

export interface AppEntry {
  name: string;
  /** The Start-menu shortcut, when the walk found one. `''` for an `AppsFolder`-only app. */
  lnkPath: string;
  /** The resolved exe, when the shortcut had one. `''` for an `AppsFolder`-only app. */
  target: string;
  /** What `shell:AppsFolder\<this>` launches. `''` when only the `.lnk` walk found the app. */
  aumid: string;
  /** What a custom command runs to open files with this app; `null` when it cannot take a file. */
  openWith: { program: string; args: string } | null;
  /** Where the app lives on disk: the exe, the `.app` bundle, the `.desktop` file. `''` for a Store app. */
  path: string;
}

/** Categories in the order the palette groups them; also the tie-break in ranking. */
export type PaletteCategory =
  'calc' | 'ext' | 'actions' | 'path' | 'recent' | 'places' | 'apps' | 'files' | 'web';

export interface PaletteResult {
  key: string;
  category: PaletteCategory;
  title: string;
  detail: string;
  /** what the row IS (a full path), for listing the same thing once; falls back to `key`. Never display text. */
  identity?: string;
  /** a Fluent glyph, or a shell icon key (`ext/…`, `file/…`, `app/…`, `folder`) via `iconUrl` */
  glyph?: GlyphName;
  iconKey?: string;
  /** extra words that also find the row (an action's synonyms); matched only as a last rung */
  keywords?: string;
  /** the source already matched the text itself (path mode); the ranker keeps it as a prefix hit */
  matched?: boolean;
  /** the keyboard chord that runs it without the palette, printed at the row's right (plan 08 A1) */
  hint?: string;
  /** always the last row, outside the ranking — "Search everywhere for …", "Search the web …" */
  pinLast?: boolean;
  /** a file or folder on disk the preview pane can show (plan 04 4.4); absent for apps, actions, … */
  previewPath?: string;
  /** what the listing already knows about it, when the source had a row (size, modified) */
  entry?: FileEntry;
  /** a hint row, not a hit: drawn in the secondary colour ("Not searched: Desktop…") */
  quiet?: boolean;
  /** what Enter does, as a word at the row's right ("Allow") */
  actionLabel?: string;
  /** Enter does not leave the palette: it stays open and asks its sources again afterwards */
  keepsOpen?: boolean;
  /** Enter */
  run: () => Promise<void> | void;
  /** Ctrl+Enter: show it in the explorer window instead of opening it */
  reveal?: () => Promise<void> | void;
}

/** One provider behind the palette: its results for a query, already filtered to matches. */
export interface PaletteSource {
  key: string;
  query: (text: string) => Promise<PaletteResult[]>;
}

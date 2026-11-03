// Mirrors src-tauri/src/core/uninstall.rs (`Uninstallable`, serde camelCase) and
// src-tauri/src/commands/uninstall.rs (`Outcome`).

/** Whether the menu item may act on a row, and if not, why. */
export type Removable =
  | 'yes'
  | 'system'
  | 'trove'
  | 'noUninstaller'
  /** Mac: a symlink or alias, not the bundle itself */
  | 'link'
  /** Mac: not a `.app` bundle */
  | 'notApp'
  /** Mac: on a network volume, or not in /Applications or ~/Applications */
  | 'elsewhere';

/**
 * One program the OS can uninstall. The frontend sends back `id` plus the name, version and
 * program its confirm showed; Rust refuses if the fresh row differs (plan 18, 1.5).
 */
export interface Uninstallable {
  /** opaque and stable — never a path or a command */
  id: string;
  name: string;
  version: string;
  publisher: string;
  /** lower-cased folder the app lives in; `''` when unknown. The join key for tiles. */
  folder: string;
  /** the tile's own file (Ubuntu: the `.desktop` path), joined exactly; `''` on Windows. */
  path: string;
  removable: Removable;
  /** the uninstaller that would run, for the confirm to SHOW only; `''` when none. Never its arguments. */
  program: string;
  /** Mac: a hash of the bundle's device, inode and mtime, sent back so a swapped bundle is refused; `''` on Windows and Ubuntu */
  stamp: string;
  /**
   * Ubuntu without GNOME Software: Trove starts nothing; `program` is typed (no newline) into a
   * fresh terminal shell and Enter is the person's.
   */
  typed: boolean;
}

/**
 * What happened after the uninstaller ended (Windows, Ubuntu) or the move to the Trash (Mac),
 * only as far as Trove can know it. `noTrash`: macOS let neither Trash method run; nothing
 * moved. `typedInTerminal`: Ubuntu, Trove started nothing; the line waits for the person's Enter.
 */
export type UninstallOutcome = 'gone' | 'stillListed' | 'unknown' | 'noTrash' | 'typedInTerminal';

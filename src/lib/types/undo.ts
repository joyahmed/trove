// What an undo entry did, as plain data: the form the undo history is saved in (`undo.json`
// beside settings.json) so Ctrl+Z still works after Trove restarts. A closure dies with the
// window; one of these does not. `utils/undo-records.ts` reads and checks them,
// `state/undo-executor.ts` turns one back into the undo it describes.

/** One item of a move: where it was, and where it landed (a keep-both name can differ). */
export interface MovedPair {
  from: string;
  to: string;
}

export type UndoRecord =
  /** `from` was renamed to `to`; both full paths, in the same folder */
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'newFolder'; path: string }
  /** `baseName` / `ext` as New → asked for them, so a redo makes the same kind of file */
  | { kind: 'newFile'; path: string; baseName: string; ext: string }
  /** `paths` went to the Recycle Bin; their original paths are the handle a restore uses */
  | { kind: 'trash'; paths: string[] }
  | { kind: 'move'; pairs: MovedPair[] }
  /**
   * `created` are what the action made (a copy's copies, a zip, an extracted folder); undo
   * removes them. `sources` + `destination` are what a redo sends again — a copy has them, an
   * archive job does not.
   */
  | { kind: 'copy'; created: string[]; sources?: string[]; destination?: string }
  /** a permanent delete: never undoable, and nothing older is reached past it */
  | { kind: 'deleteForever'; paths: string[] }
  /** an action this file cannot describe (a cancelled job's half copy, a Replace) */
  | { kind: 'other'; reason: string };

export type UndoKind = UndoRecord['kind'];

/** One saved entry: the words the menu and the notice use, and the record. */
export interface SavedUndo {
  label: string;
  what?: string;
  folder?: string;
  /** Unix ms when the action happened */
  at: number;
  record: UndoRecord;
}

/** The file's shape. A file of another version is dropped whole, never half-read. */
export interface SavedUndoLog {
  version: 1;
  entries: SavedUndo[];
}

// File actions on the current selection: open, rename (inline), new folder / file, delete to
// the Recycle Bin or for good (for good, after asking, wherever the backend says there is no
// bin), cut / copy / paste. The command bar, the keyboard and the context menu all come
// through here; every action that changes the disk leaves an entry on the undo stack.
import type { ArchiveFormat } from '$lib/types/archive';
import * as fs from '$lib/api/fs';
import { openTerminal } from '$lib/api/shell';
import { restoreFromTrash } from '$lib/api/transfer';
import { newItemKinds, type NewItemKind } from '$lib/data/new-items';
import { clipboard } from '$lib/state/clipboard.svelte';
import { confirm } from '$lib/state/confirm.svelte';
import { listing } from '$lib/state/listing.svelte';
import { notices, type NoticeKind } from '$lib/state/notices.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { isAppBundle } from '$lib/utils/app-bundle';
import { pathLocation } from '$lib/utils/location';
import { openWindow } from '$lib/api/window';
import { selection } from '$lib/state/selection.svelte';
import { transfers } from '$lib/state/transfers.svelte';
import { steppedText, undo, UndoBarrier, UndoDeclined } from '$lib/state/undo.svelte';
import type { FileEntry } from '$lib/types/fs';
import { nameOf, parentOf, samePath, toLinuxForm } from '$lib/utils/path';
import { clipboardWritePathsText } from '$lib/api/clipboard';
import { logError } from '$lib/api/log';
import { notifyLocked } from '$lib/state/lockers.svelte';
import { noBinQuestion, noRecycleBin } from '$lib/utils/no-bin';
import { archives, canExtract } from '$lib/state/archives.svelte';
import { settings } from '$lib/state/settings.svelte';
import { startOpenInner } from '$lib/api/archive';
import {
  archiveLocation,
  archiveWindowTarget,
  isBrowsableArchive,
  splitArchivePath,
} from '$lib/utils/archive-location';

class ActionsState {
  #renaming = $state<string | null>(null);
  #renamingNow: string | null = null;

  /** path of the row whose name is being edited, if any */
  get renaming() {
    return this.#renaming;
  }
  set renaming(path: string | null) {
    this.#renaming = path;
    this.#renamingNow = path;
  }

  /**
   * The open rename as of this instant, kept outside reactivity. ⛔ Read this, not `renaming`,
   * from an effect's teardown: Svelte 5 hands a teardown the value a state had BEFORE the change
   * that destroyed the effect (runtime.js `is_destroying_effect` → `old_values`). Escape set
   * `renaming` to null, which unmounted the rename box, whose teardown still read the path and
   * committed the half-typed name — cancelling a rename saved it.
   */
  get renamingNow() {
    return this.#renamingNow;
  }
  draft = $state('');

  /** Rows exist only in a folder; on Home / This PC nothing is selectable or creatable. */
  inFolder = $derived(tabs.active.isFolder);
  hasSelection = $derived(this.inFolder && selection.count > 0);
  hasOneSelected = $derived(this.inFolder && selection.count === 1);

  #selectedEntries = () => listing.rows.filter((e) => selection.has(e.path));

  /**
   * Inside an archive: the inner names of the selected rows this listing shows, in this tab's
   * archive. Read from the rows, not `selection.paths` alone: a selection left from another
   * inner folder (or another archive) lives until `selection.retain` runs after the new listing
   * lands, and a Copy in that gap must not take entries the person cannot see.
   */
  #archiveSelection = $derived.by((): { archive: string; entries: string[] } | null => {
    const loc = tabs.active.location;
    if (loc.kind !== 'archive') return null;
    const entries = this.#selectedEntries().flatMap((e) => {
      const at = splitArchivePath(e.path);
      return at && at.archive === loc.archive && at.inner !== '' ? [at.inner] : [];
    });
    return entries.length > 0 ? { archive: loc.archive, entries } : null;
  });

  /** Copy has something to take: a selection in a folder, or selected entries in an archive. */
  canCopy = $derived(this.hasSelection || this.#archiveSelection !== null);

  /** "this file" / "this folder" / "these 3 items", as Explorer's delete prompt says it. */
  #describe = (paths: string[]) =>
    paths.length === 1
      ? `this ${listing.rows.find((e) => e.path === paths[0])?.isDir ? 'folder' : 'file'}`
      : `these ${paths.length} items`;

  /**
   * Undo of something this app created (a new folder, a zip): to the Recycle Bin, or — where
   * the backend says there is none — asked about and then deleted for good. A "no" throws
   * `UndoDeclined`, so the undo stack does not record a removal that did not happen.
   */
  #removeCreated = async (path: string, what: string) => {
    let refused: fs.NoRecycleBin | null;
    try {
      return await fs.trashEntries([path]);
    } catch (e) {
      refused = noRecycleBin(e);
      if (!refused) throw e;
    }
    const ok = await confirm.ask({
      title: what.includes('folder') ? 'Delete Folder' : 'Delete File',
      message: noBinQuestion(refused, what),
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) throw new UndoDeclined(`Undo cancelled — ${what} was not deleted`);
    await fs.deleteEntries([path]);
  };

  /** Show a toast; plain calls are information, `#fail` is an error (other state uses it too). */
  notify = (message: string, kind: NoticeKind = 'info') => notices.push({ kind, message });

  /** The toast fades; the log should not. Every failed action lands in the file too. */
  #fail = (e: unknown) => {
    logError('actions', e);
    this.notify(String(e), 'error');
  };

  /**
   * `#fail`, unless a program has one of `paths` open (os error 32 / 33, plan 21B): then the
   * notice names it — "Microsoft Word has report.docx open" — with Retry (`retry`) and End task.
   */
  #failOrLocked = async (e: unknown, paths: string[], retry: () => unknown) => {
    if (await notifyLocked(paths, e, retry)) logError('actions', e);
    else this.#fail(e);
  };

  /**
   * Where a row opens as a folder: a real folder, a folder inside an archive, or — with the
   * setting on — a zip / 7z / tar itself (plan 16, Phase 4). null: it opens with an app.
   */
  #folderOf = (entry: FileEntry) => {
    const inside = splitArchivePath(entry.path);
    if (inside) return entry.isDir ? archiveLocation(inside.archive, inside.inner) : null;
    if (entry.isDir) return isAppBundle(entry) ? null : pathLocation(entry.path);
    return settings.archivesOpenInside && isBrowsableArchive(entry.name)
      ? archiveLocation(entry.path)
      : null;
  };

  /** Middle-click or the context menu on a folder: a new tab on it, the current one stays. */
  /** A Mac's `X.app` has no inside to show: middle-click / Shift+Enter launch it, as Finder does. */
  openInNewTab = (entry: FileEntry) => {
    const to = this.#folderOf(entry);
    if (to) tabs.open(to);
    else if (isAppBundle(entry)) void this.open(entry);
  };

  /** Shift+Enter or the context menu on a folder: its own window, as Explorer does. */
  openInNewWindow = (entry: FileEntry) => {
    const to = this.#folderOf(entry);
    if (to?.kind === 'archive') void openWindow(archiveWindowTarget(to));
    else if (to) void openWindow(entry.path);
    else if (isAppBundle(entry)) void this.open(entry);
  };

  /**
   * Folder → navigate; file → default app; a Mac's `X.app` folder → launch it, as Finder does.
   * A zip / 7z / tar (setting on) opens inside Trove; a file inside an archive is extracted to
   * a read-only temp copy first, and that copy opens.
   */
  open = async (entry: FileEntry) => {
    const to = this.#folderOf(entry);
    if (to) return tabs.active.navigate(to);
    try {
      const inside = splitArchivePath(entry.path);
      const path = inside ? await startOpenInner(inside.archive, inside.inner) : entry.path;
      await fs.openPath(path);
    } catch (e) {
      this.#fail(e);
    }
  };

  openSelected = () => {
    const [first] = this.#selectedEntries();
    if (first) void this.open(first);
  };

  /**
   * Select what an action just made, but only if the person is still looking at the folder it
   * was made in: the selection API acts on whichever tab is active *now*, and a slow rename or
   * zip must not select a path in a tab or folder that does not list it. True when it selected.
   */
  #reveal = (tab: typeof tabs.active, folder: string, path: string) => {
    if (tabs.active !== tab || tab.path !== folder) return false;
    selection.reveal(path);
    return true;
  };

  // ── rename ─────────────────────────────────────────────────────────────────
  startRename = (path = selection.focused ?? [...selection.paths][0]) => {
    // F2 inside an archive (or on a place) renames nothing: archives are read-only
    if (!this.inFolder) return;
    const entry = listing.rows.find((e) => e.path === path);
    if (!entry) return;
    this.renaming = entry.path;
    this.draft = entry.name;
  };

  cancelRename = () => {
    this.renaming = null;
  };

  commitRename = async () => {
    // not `this.renaming`: this runs from the rename box's teardown too (see `renamingNow`)
    const path = this.renamingNow;
    const name = this.draft.trim();
    this.renaming = null;
    if (!path) return;
    const current = listing.rows.find((e) => e.path === path);
    // an emptied box is a change of mind, not a request for the name '' (which would only fail
    // with a toast and lose the edit)
    if (!current || name === '' || name === current.name) return;
    return this.#rename(path, name, current.name);
  };

  /** The rename itself; a program holding the file names itself, and its Retry comes here. */
  #rename = async (path: string, name: string, oldName: string) => {
    const tab = tabs.active;
    const folder = tab.path;
    try {
      const to = await fs.renameEntry(path, name);
      undo.push({
        label: 'Rename',
        what: `rename of "${oldName}" to "${name}"`,
        folder,
        undo: async () => void (await fs.renameEntry(to, oldName)),
        redo: async () => void (await fs.renameEntry(path, name)),
      });
      await tab.reload();
      this.#reveal(tab, folder, to);
    } catch (e) {
      await this.#failOrLocked(e, [path], () => this.#rename(path, name, oldName));
    }
  };

  // ── new folder / file ──────────────────────────────────────────────────────
  /** New → <kind>: create it, select it, and go straight into rename, as Explorer does. */
  newItem = async (kind: NewItemKind) => {
    if (!this.inFolder) return;
    try {
      const tab = tabs.active;
      const dir = tab.path;
      const create = () =>
        kind.ext === '' ? fs.createFolder(dir) : fs.createFile(dir, kind.baseName, kind.ext);
      const path = await create();
      undo.push({
        label: `New ${kind.label.toLowerCase()}`,
        what: `new ${kind.label.toLowerCase()} "${nameOf(path)}"`,
        folder: dir,
        undo: () => this.#removeCreated(path, `the new ${kind.label.toLowerCase()}`),
        // the same name again, unless something took it meanwhile — then the next free one
        redo: async () => void (await create()),
      });
      await tab.reload();
      if (this.#reveal(tab, dir, path)) this.startRename(path);
    } catch (e) {
      this.#fail(e);
    }
  };

  newFolder = () => this.newItem(newItemKinds[0]);

  // ── terminal ───────────────────────────────────────────────────────────────
  /** Windows Terminal (or a console) in the current folder; a WSL folder opens its distro. */
  openTerminal = async () => {
    if (!this.inFolder) return;
    await this.openTerminalAt(tabs.active.path);
  };

  /** The same terminal, opened in one given folder (a folder's own right-click menu). */
  openTerminalAt = async (path: string) => {
    try {
      await openTerminal(path);
    } catch (e) {
      this.#fail(e);
    }
  };

  // ── delete ─────────────────────────────────────────────────────────────────
  /**
   * Delete: to the Recycle Bin with an undo. Where the backend refuses because some paths have
   * no bin (it then deleted nothing), the rest still go to the bin with their undo, and only the
   * stuck ones are deleted the permanent way: asked first, and no undo.
   */
  deleteSelected = async () => {
    const paths = [...selection.paths];
    if (!this.inFolder || paths.length === 0) return;
    return this.#trash(paths);
  };

  /** Delete's work on `paths`; a locked file's Retry runs it again. */
  #trash = async (paths: string[]): Promise<void> => {
    let refused: fs.NoRecycleBin | null = null;
    try {
      await fs.trashEntries(paths);
    } catch (e) {
      refused = noRecycleBin(e);
      if (!refused) return this.#failOrLocked(e, paths, () => this.#trash(paths));
    }
    if (refused === null) return this.#binned(paths);
    // the backend names the stuck paths; a refusal without them covers the whole batch
    const stuck = refused.paths.length > 0 ? refused.paths : paths;
    const binnable = paths.filter((p) => !stuck.includes(p));
    // `denied` (macOS): the backend already moved the rest before it gave up, so no second try
    if (binnable.length > 0 && refused.reason === 'denied') await this.#binned(binnable);
    else if (binnable.length > 0) {
      try {
        await fs.trashEntries(binnable);
      } catch (e) {
        // refused again (or failed): an error, and nothing is deleted for good
        return this.#fail(e);
      }
      await this.#binned(binnable);
    }
    selection.replaceAll(stuck);
    return this.#deleteForGood(stuck, refused);
  };

  /** `paths` are in the bin: leave the undo that restores them, and show the folder without them. */
  #binned = async (paths: string[]) => {
    try {
      // only now: the files are in the bin, so the undo has something to restore
      undo.push({
        label: 'Delete',
        what: `delete of ${paths.length === 1 ? `"${nameOf(paths[0])}"` : `${paths.length} items`}`,
        folder: parentOf(paths[0]) ?? undefined,
        undo: () => restoreFromTrash(paths),
        redo: () => fs.trashEntries(paths),
      });
      selection.clear();
      await tabs.active.reload();
    } catch (e) {
      this.#fail(e);
    }
  };

  // ── compress ───────────────────────────────────────────────────────────────
  /**
   * Compress to a format (zip by default): the selection into one archive beside it, as a job with a progress
   * row and Cancel (state/archives); when it lands the zip is selected and Undo bins it.
   */
  compress = async (format: ArchiveFormat = 'zip') => {
    const paths = [...selection.paths];
    if (!this.inFolder || paths.length === 0) return;
    try {
      await archives.compress(paths, format);
    } catch (e) {
      this.#fail(e);
    }
  };

  /** The one selected file, when it is an archive this build can extract (`.zip` in Phase 1). */
  #extractable = $derived.by(() => {
    if (!this.hasOneSelected) return null;
    const entry = listing.rows.find((e) => selection.has(e.path));
    return entry && !entry.isDir && canExtract(entry.name) ? entry : null;
  });
  canExtractHere = $derived(this.#extractable !== null);

  /**
   * Extract here: into a new folder beside the archive, named after it (`photos`, then
   * `photos (2)`), so nothing is ever overwritten and no question is asked. There is no
   * "Extract all…" yet: no folder picker exists (plan 16, Phase 1 — it comes with paste).
   */
  extractHere = async () => {
    const entry = this.#extractable;
    if (!entry) return;
    try {
      await archives.extractHere(entry.path);
    } catch (e) {
      this.#fail(e);
    }
  };

  /** Shift+Delete: no Recycle Bin, so ask first (Explorer's wording); nothing to undo after. */
  deletePermanently = async () => {
    const paths = [...selection.paths];
    if (!this.inFolder || paths.length === 0) return;
    return this.#deleteForGood(paths, null);
  };

  /** Ask, then delete for good. `refused` is set when Delete fell back here: it says why. */
  #deleteForGood = async (paths: string[], refused: fs.NoRecycleBin | null) => {
    const what = this.#describe(paths);
    const ok = await confirm.ask({
      title:
        paths.length !== 1
          ? 'Delete Multiple Items'
          : what.includes('folder')
            ? 'Delete Folder'
            : 'Delete File',
      message:
        refused === null
          ? `Are you sure you want to permanently delete ${what}?`
          : noBinQuestion(refused, what),
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    return this.#deleteNow(paths);
  };

  /**
   * The permanent delete, already agreed to; a locked file's Retry runs it again unasked. It leaves
   * a barrier on the undo stack (even when it failed partway: part may be gone), so a Ctrl+Z
   * after it says it cannot undo this rather than undoing something older.
   */
  #deleteNow = async (paths: string[]): Promise<void> => {
    const folder = parentOf(paths[0]) ?? undefined;
    try {
      await fs.deleteEntries(paths);
      undo.pushBarrier(folder);
      selection.clear();
      await tabs.active.reload();
    } catch (e) {
      undo.pushBarrier(folder);
      await this.#failOrLocked(e, paths, () => this.#deleteNow(paths));
      await tabs.active.reload(); // part of the list may be gone
    }
  };

  // ── cut / copy / paste ─────────────────────────────────────────────────────
  cut = () => {
    if (this.hasSelection) clipboard.set([...selection.paths], true);
  };

  copy = () => {
    if (this.hasSelection) return clipboard.set([...selection.paths], false);
    // inside an archive `hasSelection` is false (no real folder): the copy holds the entries,
    // and a paste in a folder extracts them. Nothing selected and shown = nothing copied.
    const picked = this.#archiveSelection;
    if (picked) clipboard.setArchive(picked.archive, picked.entries);
  };

  /**
   * "Copy as path": the selected paths as quoted text, one per line. A selection that is
   * entirely on WSL shares is copied in its `distro:/…` form, the one a shell there wants.
   */
  copyAsPath = async () => {
    if (!this.hasSelection) return;
    const paths = [...selection.paths];
    const linux = paths.map(toLinuxForm);
    const text = linux.every((p) => p !== null) ? (linux as string[]) : paths;
    try {
      await clipboardWritePathsText(text);
      // the text replaced the OS clipboard, so a pending cut is gone: un-dim now, not on focus
      clipboard.clear();
    } catch (e) {
      this.#fail(e);
    }
  };

  /**
   * Paste into the current folder: ours or the OS clipboard's files; a cut becomes a move.
   * Targets that already exist raise the conflict dialog before anything is written.
   */
  paste = async () => {
    if (!this.inFolder) return;
    const destination = tabs.active.path;
    // ⚠️ before `read()`: that returns the OS clipboard whenever our own path list is empty
    const fromArchive = await clipboard.readArchive();
    if (fromArchive) {
      try {
        await archives.extractTo(fromArchive.archive, destination, fromArchive.entries);
      } catch (e) {
        this.#fail(e);
      }
      return;
    }
    const held = await clipboard.read();
    if (!held) return;
    const mode = held.cut ? 'move' : 'copy';
    // a cut pasted back where it came from is a no-op, as in Explorer
    const sources = held.cut
      ? held.paths.filter((p) => !samePath(parentOf(p) ?? '', destination))
      : held.paths;
    // everything was already here: the paste is complete, so the cut stops being pending
    if (held.cut && sources.length === 0) {
      clipboard.clear();
      return;
    }
    try {
      await transfers.request(sources, destination, mode, { fromCut: held.cut });
    } catch (e) {
      this.#fail(e);
    }
  };

  // ── undo / redo ────────────────────────────────────────────────────────────
  // every step names what it did: an undo once reached past a permanent delete and took back an
  // older copy in another folder with nothing on screen to say so
  undo = async () => {
    try {
      const done = await undo.undo();
      if (done) this.notify(steppedText('Undid', done, tabs.active.path));
    } catch (e) {
      if (e instanceof UndoDeclined || e instanceof UndoBarrier) this.notify(e.message);
      else this.#fail(e);
    }
  };

  redo = async () => {
    try {
      const done = await undo.redo();
      if (done) this.notify(steppedText('Redid', done, tabs.active.path));
    } catch (e) {
      this.#fail(e);
    }
  };
}

export const actions = new ActionsState();

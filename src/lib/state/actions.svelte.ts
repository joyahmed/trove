// File actions on the current selection: open, rename (inline), new folder / file, delete to
// the Recycle Bin or for good (for good, after asking, wherever the backend says there is no
// bin), cut / copy / paste. The command bar, the keyboard and the context menu all come
// through here; every action that changes the disk leaves an entry on the undo stack.
import type { ArchiveFormat } from '$lib/types/archive';
import * as fs from '$lib/api/fs';
import { openTerminal } from '$lib/api/shell';
import { newItemKinds, type NewItemKind } from '$lib/data/new-items';
import { clipboard } from '$lib/state/clipboard.svelte';
import { confirm } from '$lib/state/confirm.svelte';
import { listing } from '$lib/state/listing.svelte';
import { notices, type NoticeKind } from '$lib/state/notices.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { terminal } from '$lib/state/terminal.svelte';
import { paneShellFor, pastePathsText } from '$lib/utils/shell-quote';
import { isAppBundle } from '$lib/utils/app-bundle';
import { isAccessDenied, RETRY_AS_ADMIN } from '$lib/utils/elevate';
import { onWindows } from '$lib/utils/platform';
import { stripExtension } from '$lib/utils/file-name';
import { pathLocation } from '$lib/utils/location';
import { openWindow } from '$lib/api/window';
import { selection } from '$lib/state/selection.svelte';
import { transfers } from '$lib/state/transfers.svelte';
import { steppedText, undo, UndoBarrier, UndoDeclined, UndoRefused } from '$lib/state/undo.svelte';
import type { UndoEntry } from '$lib/state/undo.svelte';
import { checkWorld, entryFor } from '$lib/state/undo-executor';
import type { FileEntry } from '$lib/types/fs';
import { destinationProblem } from '$lib/utils/extract-destination';
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

/**
 * The disk check an out-of-order undo runs first (plan 08 F): the entry's own, else `checkWorld`
 * on its record — a live copy or move keeps a job-aware entry with no check of its own.
 */
const world = async (entry: UndoEntry) => {
  if (entry.check) return entry.check('undo');
  const record = entry.toRecord?.();
  if (record) await checkWorld(record, 'undo');
};

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
  /**
   * The extension the rename box leaves out: with "File name extensions" off a file is renamed
   * the way Explorer does it, by its shown name only, and the hidden `.pdf` goes back on at commit.
   * '' when the box holds the whole name.
   */
  #renameSuffix = '';
  /** the box holds the base name only: it selects all of it, not up to the last dot */
  get renameHidesExtension() {
    return this.#renameSuffix !== '';
  }

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
   * Windows refused with access denied: the error notice offers "Retry as administrator", which
   * runs `op` once in a copy of Trove started through UAC (plan 05 5.6) and then `done` with its
   * answer. No undo entry: undoing it would need the same rights. false: not that failure.
   */
  #offerAdmin = (e: unknown, op: fs.ElevatedOp, done: (answer: string) => Promise<void>) => {
    if (!onWindows() || !isAccessDenied(e)) return false;
    logError('actions', e);
    notices.push({
      kind: 'error',
      message: String(e),
      action: {
        label: RETRY_AS_ADMIN,
        run: async () => {
          try {
            await done(await fs.retryElevated(op));
          } catch (again) {
            this.#fail(again);
          }
        },
      },
    });
    return true;
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
    const base = settings.showExtensions || entry.isDir ? entry.name : stripExtension(entry.name);
    this.#renameSuffix = entry.name.slice(base.length);
    this.draft = base;
  };

  cancelRename = () => {
    this.renaming = null;
  };

  commitRename = async () => {
    // not `this.renaming`: this runs from the rename box's teardown too (see `renamingNow`)
    const path = this.renamingNow;
    const typed = this.draft.trim();
    // an emptied box stays empty, so the cancel below still sees it
    const name = typed === '' ? '' : typed + this.#renameSuffix;
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
      undo.push(
        entryFor(
          { label: 'Rename', what: `rename of "${oldName}" to "${name}"`, folder },
          { kind: 'rename', from: path, to },
        ),
      );
      await tab.reload();
      this.#reveal(tab, folder, to);
    } catch (e) {
      const elevated = { kind: 'rename', path, newName: name } as const;
      const done = async (to: string) => {
        await tab.reload();
        this.#reveal(tab, folder, to);
      };
      if (this.#offerAdmin(e, elevated, done)) return;
      await this.#failOrLocked(e, [path], () => this.#rename(path, name, oldName));
    }
  };

  // ── new folder / file ──────────────────────────────────────────────────────
  /** New → <kind>: create it, select it, and go straight into rename, as Explorer does. */
  newItem = async (kind: NewItemKind) => {
    if (!this.inFolder) return;
    const tab = tabs.active;
    const dir = tab.path;
    const folder = kind.ext === '';
    try {
      const path = folder
        ? await fs.createFolder(dir)
        : await fs.createFile(dir, kind.baseName, kind.ext);
      // a redo asks for the same name again, unless something took it meanwhile — then the
      // next free one (`undo-executor` runStep)
      undo.push(
        entryFor(
          {
            label: `New ${kind.label.toLowerCase()}`,
            what: `new ${kind.label.toLowerCase()} "${nameOf(path)}"`,
            folder: dir,
          },
          folder
            ? { kind: 'newFolder', path }
            : { kind: 'newFile', path, baseName: kind.baseName, ext: kind.ext },
        ),
      );
      await tab.reload();
      if (this.#reveal(tab, dir, path)) this.startRename(path);
    } catch (e) {
      // only a folder: a new file's elevated copy would be the administrator's to edit
      const done = async (path: string) => {
        await tab.reload();
        this.#reveal(tab, dir, path);
      };
      if (folder && this.#offerAdmin(e, { kind: 'createFolder', dir }, done)) return;
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
      undo.push(
        entryFor(
          {
            label: 'Delete',
            what: `delete of ${paths.length === 1 ? `"${nameOf(paths[0])}"` : `${paths.length} items`}`,
            folder: parentOf(paths[0]) ?? undefined,
          },
          { kind: 'trash', paths: [...paths] },
        ),
      );
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
   * `photos (2)`), so nothing is ever overwritten and no question is asked.
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

  /**
   * Extract all…: ask for a folder (the app's text prompt; no native picker is in this build),
   * then extract there with the same progress, conflict question and Undo as a paste out of an
   * archive. A path that is not an existing folder asks again, with the reason.
   */
  extractAll = async () => {
    const entry = this.#extractable;
    if (!entry) return;
    try {
      let value = parentOf(entry.path) ?? '';
      for (;;) {
        const typed = await confirm.askText({
          title: 'Extract all…',
          message: `Extract “${entry.name}” into this folder.`,
          okLabel: 'Extract',
          placeholder: 'Folder, like C:\\Backups or /media/stick',
          value,
          validate: destinationProblem,
        });
        if (typed === null) return;
        if ((await fs.pathKind(typed)) === 'dir') {
          await archives.extractTo(entry.path, typed);
          return;
        }
        this.notify(`“${typed}” is not an existing folder`, 'error');
        value = typed;
      }
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
      undo.pushBarrier(folder, paths);
      selection.clear();
      await tabs.active.reload();
    } catch (e) {
      undo.pushBarrier(folder, paths);
      const done = async () => {
        selection.clear();
        await tabs.active.reload();
      };
      if (this.#offerAdmin(e, { kind: 'delete', paths }, done)) {
        await tabs.active.reload(); // part of the list may be gone
        return;
      }
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
  /** The selected rows a cloud provider marked: the only ones the two OneDrive items act on. */
  get cloudSelection(): FileEntry[] {
    return listing.rows.filter((e) => e.cloudState !== undefined && selection.paths.has(e.path));
  }

  /**
   * OneDrive's "Always keep on this device" (`keep`) or "Free up space" for the selected cloud
   * files. The provider downloads or frees the bytes on its own time; the reload shows the new
   * badge as soon as the attribute flips.
   */
  setCloudPin = async (keep: boolean) => {
    const paths = this.cloudSelection.map((e) => e.path);
    if (paths.length === 0) return;
    try {
      await fs.setCloudPin(paths, keep);
    } catch (e) {
      this.#fail(e);
    }
    await tabs.active.reload();
  };

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
   * "Paste paths into terminal" (plan 08 E3): the selected paths, quoted for the pane's shell and
   * space-separated, typed at its prompt with no Enter. Opens the pane when it is closed. Nothing
   * selected = nothing sent and the pane stays as it is.
   */
  pastePathsIntoTerminal = async () => {
    if (!this.hasSelection) return;
    // a live pane's shell was started at `terminal.path`; a closed one will start at the tab
    const shell = paneShellFor(terminal.open ? terminal.path : tabs.active.path);
    const { text, skipped } = pastePathsText([...selection.paths], shell);
    if (skipped > 0) this.notify(`${skipped} not reachable from the terminal's shell, left out`);
    if (!text) return;
    if (!(await terminal.typeIntoPrompt(text)))
      this.notify('The terminal could not take the paths', 'error');
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
  undo = () => this.#undid(undo.undo());

  /**
   * Edit ▸ History's pick (plan 08 F): undo the entry at `index` (oldest first) out of order, the
   * disk checked first. A newer entry on the same files refuses it with a warning naming that one.
   */
  undoAt = (index: number) => this.#undid(undo.undoAt(index, world));

  #undid = async (step: Promise<UndoEntry | undefined>) => {
    try {
      const done = await step;
      if (done) this.notify(steppedText('Undid', done, tabs.active.path));
    } catch (e) {
      if (e instanceof UndoDeclined || e instanceof UndoBarrier) this.notify(e.message);
      else if (e instanceof UndoRefused) this.notify(e.message, 'warning');
      else this.#fail(e);
    }
  };

  redo = async () => {
    try {
      const done = await undo.redo();
      if (done) this.notify(steppedText('Redid', done, tabs.active.path));
    } catch (e) {
      if (e instanceof UndoRefused) this.notify(e.message, 'warning');
      else this.#fail(e);
    }
  };
}

export const actions = new ActionsState();

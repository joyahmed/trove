// The palette's preview pane (plan 04 4.4): what the lit row looks like, and its quick actions —
// Open, Reveal, Copy path (both forms on WSL), Rename. Reuses the explorer pane's preview parts;
// the fetching is its own, since the explorer's `preview` state follows the file list's selection.
import { untrack } from 'svelte';
import { paletteFolderCount, renameEntry } from '$lib/api/fs';
import { previewUrl, readTextHead } from '$lib/api/preview';
import { clipboardWritePathsText } from '$lib/api/clipboard';
import { logError } from '$lib/api/log';
import { previewKindOf } from '$lib/data/preview-kinds';
import { posterThumbSrc } from '$lib/data/preview-poster';
import { clampPalettePreviewWidth, settings } from '$lib/state/settings.svelte';
import type { PaletteResult } from '$lib/types/palette';
import type { PreviewKind, TextHead } from '$lib/types/preview';
import { nameOf } from '$lib/utils/path';
import { fmtDate, fmtSize } from '$lib/utils/format';
import { shortKindOf } from '$lib/utils/short-kind';
import {
  copyPathForms,
  folderCountLabel,
  isPreviewable,
  renameProblem,
  type CopyPathForm,
} from '$lib/utils/palette-preview';
import type { PalettePrefs } from './use-palette.svelte';

/** Arrowing through rows fetches only for the row the keys stop on. */
const FETCH_DELAY_MS = 120;
/** How long "Copied" stays on the button that copied. */
const COPIED_MS = 1200;

export interface PalettePreviewArgs {
  result: () => PaletteResult | undefined;
  savePrefs: (patch: PalettePrefs) => void;
  open: (r: PaletteResult) => void;
  reveal: (r: PaletteResult) => void;
  /** the rename landed: ask the sources again */
  requery: () => void;
}

export const usePalettePreview = (args: PalettePreviewArgs) => {
  const state = $state({
    text: null as TextHead | null,
    textError: null as string | null,
    folderCount: null as number | null,
    renaming: false,
    draft: '',
    renameError: null as string | null,
    copied: null as CopyPathForm['key'] | null,
    /** the width while a drag is under way; the saved one otherwise */
    dragWidth: null as number | null,
  });

  const target = $derived.by(() => {
    const r = args.result();
    return isPreviewable(r) ? r : null;
  });
  const path = $derived(target?.previewPath ?? '');
  const entry = $derived(target?.entry ?? null);
  const isDir = $derived(target !== null && (entry === null || entry.isDir));
  const kind = $derived<PreviewKind>(entry && !entry.isDir ? previewKindOf(entry) : 'none');
  const url = $derived(
    path && entry && !entry.isDir
      ? `${previewUrl(path)}?v=${entry.modifiedMs ?? 0}-${entry.size}`
      : '',
  );

  /** a picture the pane has no renderer for (a Mac HEIC, a video): its 256 px thumbnail */
  const poster = $derived(entry && !entry.isDir ? posterThumbSrc(entry, kind) : '');

  // A new row: forget the last one's text and count and any rename in progress, then fetch what
  // this one needs once the keys stop on it. A late answer for a row since left is dropped.
  $effect(() => {
    const p = path;
    const k = kind;
    const dir = isDir;
    untrack(() => {
      state.text = null;
      state.textError = null;
      state.folderCount = null;
      state.renaming = false;
      state.renameError = null;
      state.copied = null;
    });
    if (!p || (k !== 'text' && !dir)) return;
    let live = true;
    const timer = setTimeout(() => {
      if (dir) {
        // ⛔ not `readDir`: a highlighted ~/Desktop row raised the Mac privacy prompt (Rust side)
        paletteFolderCount(p)
          .then((n) => live && (state.folderCount = n))
          .catch(() => {});
      } else {
        readTextHead(p)
          .then((h) => live && (state.text = h))
          .catch((e: unknown) => live && (state.textError = String(e)));
      }
    }, FETCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  });

  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const copy = async (form: CopyPathForm) => {
    try {
      await clipboardWritePathsText([form.text]);
      state.copied = form.key;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (state.copied = null), COPIED_MS);
    } catch (e) {
      logError('palette.copyPath', e);
    }
  };

  const startRename = () => {
    if (!target) return;
    state.draft = entry?.name ?? nameOf(path);
    state.renameError = null;
    state.renaming = true;
  };

  const commitRename = async () => {
    const old = entry?.name ?? nameOf(path);
    const name = state.draft.trim();
    if (name === old) {
      state.renaming = false;
      return;
    }
    const problem = renameProblem(name);
    if (problem) {
      state.renameError = problem;
      return;
    }
    try {
      await renameEntry(path, name);
      state.renaming = false;
      args.requery();
    } catch (e) {
      state.renameError = String(e);
    }
  };

  /** Keys inside the rename box stay there: Enter commits, Esc cancels, the palette sees neither. */
  const renameKeydown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      state.renaming = false;
    }
  };

  /** `use:` action for the rename box: focus it with the name selected (not the extension). */
  const attachRename = (el: HTMLInputElement) => {
    el.focus();
    const dot = state.draft.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 && !isDir ? dot : state.draft.length);
  };

  // The pane's left edge drags its width; the result is saved once, on release.
  const startResize = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = settings.palettePreviewWidth;
    const move = (m: PointerEvent) => {
      state.dragWidth = clampPalettePreviewWidth(w0 + (x0 - m.clientX));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const w = state.dragWidth;
      state.dragWidth = null;
      if (w !== null && w !== settings.palettePreviewWidth)
        args.savePrefs({ palettePreviewWidth: w });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return {
    state,
    get target() {
      return target;
    },
    get entry() {
      return entry;
    },
    get name() {
      return entry?.name ?? (path ? nameOf(path) : '');
    },
    get isDir() {
      return isDir;
    },
    get kind() {
      return kind;
    },
    get url() {
      return url;
    },
    get poster() {
      return poster;
    },
    get width() {
      return state.dragWidth ?? settings.palettePreviewWidth;
    },
    /** the mono line under the name: kind · size · modified, or for a folder its item count */
    get meta() {
      if (isDir) {
        return [folderCountLabel(state.folderCount), entry ? fmtDate(entry.modifiedMs) : '']
          .filter(Boolean)
          .join(' · ');
      }
      return entry
        ? [shortKindOf(entry), fmtSize(entry.size), fmtDate(entry.modifiedMs)]
            .filter(Boolean)
            .join(' · ')
        : '';
    },
    get copyForms() {
      return path ? copyPathForms(path) : [];
    },
    open: () => target && args.open(target),
    reveal: () => target && args.reveal(target),
    hide: () => args.savePrefs({ palettePreview: false }),
    copy,
    startRename,
    commitRename,
    renameKeydown,
    attachRename,
    startResize,
  };
};

// The Applications place's reactivity: load on mount, type-to-filter, arrows move the
// highlight, Enter or a double-click starts the app, F5 reloads, one right-click menu.
//
// ⛔ Read-only (plan 17, traps). The menu is Start, Reveal and Copy as path — never Delete, Rename,
// Cut or "move to bin": deleting a `.lnk`, a `.desktop` file or an `.app` from here would be a
// fake uninstall. The view is no drop target either (no `data-drop`), so nothing can be moved
// INTO it. `use-applications-view.test.ts` pins both.
import { untrack } from 'svelte';
import { clipboardWritePathsText } from '$lib/api/clipboard';
import { openPath } from '$lib/api/fs';
import { logError } from '$lib/api/log';
import { launchApp } from '$lib/api/palette';
import { useMenu, type MenuItem } from '$lib/hooks/use-menu.svelte';
import { applications } from '$lib/state/applications.svelte';
import { clipboard } from '$lib/state/clipboard.svelte';
import { heldByDialog } from '$lib/state/modal.svelte';
import { notices } from '$lib/state/notices.svelte';
import { selection } from '$lib/state/selection.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { uninstall } from '$lib/state/uninstall.svelte';
import type { AppEntry } from '$lib/types/palette';
import { isFinderOpenKey } from '$lib/utils/key-label';
import { launchLabel, uninstallVerb } from '$lib/utils/platform';
import { parentOf } from '$lib/utils/path';

/** A tile is 112 px wide and tiles sit 4 px apart (`gap-1`); the scroller pads 20 px a side. */
export const TILE_PX = 112;
const GAP_PX = 4;
const SIDE_PADDING_PX = 40;

/** Tiles across `width` px of scroller, so ↑ and ↓ move a whole row. */
export const appColumnsFor = (width: number) =>
  Math.max(1, Math.floor((width - SIDE_PADDING_PX + GAP_PX) / (TILE_PX + GAP_PX)));

/** What Reveal and Copy as path point at: the exe on Windows, the bundle / `.desktop` elsewhere. */
export const appDiskPath = (a: AppEntry): string => a.target || a.path;

/**
 * Start the app — the palette's own rule (`palette-sources` appsSource `run`): the Start-menu
 * shortcut when there is one, else the OS's launcher by id (`launch_app`).
 */
export const startApp = (a: AppEntry): Promise<void> =>
  a.lnkPath ? openPath(a.lnkPath) : launchApp(a.aumid);

export interface ApplicationsMenuHandlers {
  start: (a: AppEntry) => unknown;
  reveal: (a: AppEntry) => unknown;
  copyPath: (a: AppEntry) => unknown;
  /**
   * Plan 18: the last item, after a divider — hands the job to the OS's own uninstaller after a
   * confirm (`state/uninstall.svelte.ts`). Greyed with its reason in the hint column when it
   * cannot act. Trove itself never deletes the app's files from here.
   */
  uninstall?: {
    state: (a: AppEntry) => { enabled: boolean; reason: string };
    run: (a: AppEntry) => unknown;
  };
}

/** The Uninstall item and its divider, or nothing when the caller gave no handler. */
const uninstallItems = (a: AppEntry, on: ApplicationsMenuHandlers): MenuItem[] => {
  const u = on.uninstall;
  if (!u) return [];
  const { enabled, reason } = u.state(a);
  return [
    { kind: 'divider', key: 'uninstall-divider' },
    {
      kind: 'item',
      key: 'uninstall',
      label: uninstallVerb(),
      shortcut: enabled ? undefined : reason,
      enabled: () => enabled,
      run: () => u.run(a),
    },
  ];
};

/** The right-click menu for one app, as data. Reveal and Copy as path only when it lives on disk. */
export const applicationsMenuFor = (a: AppEntry, on: ApplicationsMenuHandlers): MenuItem[] => {
  const onDisk = appDiskPath(a) !== '';
  return [
    { kind: 'item', key: 'start', label: launchLabel(), glyph: 'fileApp', run: () => on.start(a) },
    ...(onDisk
      ? ([
          {
            kind: 'item',
            key: 'reveal',
            label: 'Open file location',
            glyph: 'folder',
            run: () => on.reveal(a),
          },
          { kind: 'item', key: 'copy-path', label: 'Copy as path', run: () => on.copyPath(a) },
        ] satisfies MenuItem[])
      : []),
    ...uninstallItems(a, on),
  ];
};

/** One key on the view: what it does to the filter text and the highlight. Pure, for the tests. */
export type AppKeyAction =
  | { kind: 'move'; to: number }
  | { kind: 'start' }
  | { kind: 'filter'; text: string }
  | { kind: 'reload' }
  | { kind: 'none' };

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

export const appKeyAction = (
  e: KeyLike,
  state: { index: number; count: number; cols: number; filter: string; inInput: boolean },
  mac?: boolean,
): AppKeyAction => {
  const { index, count, cols, filter, inInput } = state;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  if (e.key === 'F5') return { kind: 'reload' };
  // `mac` pins host and style together (tests); left out, the setting's style and the host apply
  const os = mac === undefined ? undefined : mac ? 'mac' : 'windows';
  if (e.key === 'Enter' || isFinderOpenKey(e, os, os))
    return count > 0 ? { kind: 'start' } : { kind: 'none' };
  if (e.key === 'Escape') return filter ? { kind: 'filter', text: '' } : { kind: 'none' };
  if (count > 0) {
    if (e.key === 'ArrowDown') return { kind: 'move', to: clamp(index + cols) };
    if (e.key === 'ArrowUp') return { kind: 'move', to: clamp(index - cols) };
    if (e.key === 'Home') return { kind: 'move', to: 0 };
    if (e.key === 'End') return { kind: 'move', to: count - 1 };
    // in the filter box ← and → move the caret, not the highlight
    if (!inInput && e.key === 'ArrowRight') return { kind: 'move', to: clamp(index + 1) };
    if (!inInput && e.key === 'ArrowLeft') return { kind: 'move', to: clamp(index - 1) };
  }
  // the filter box types for itself; on the grid a printable key starts or extends the filter
  if (inInput || e.ctrlKey || e.metaKey || e.altKey) return { kind: 'none' };
  if (e.key === 'Backspace')
    return filter ? { kind: 'filter', text: filter.slice(0, -1) } : { kind: 'none' };
  if (e.key.length === 1) return { kind: 'filter', text: filter + e.key };
  return { kind: 'none' };
};

/** "Copy as path", as the file list does it: quoted text, and a pending cut is gone. */
export const copyAppPath = async (a: AppEntry) => {
  try {
    await clipboardWritePathsText([appDiskPath(a)]);
    clipboard.clear();
  } catch (e) {
    logError('applications.copyPath', e);
  }
};

export const useApplicationsView = () => {
  const menu = useMenu();
  let items = $state<MenuItem[]>([]);
  let index = $state(0);
  let width = $state(1000);
  const cols = $derived(appColumnsFor(width));

  /** A Svelte action for the scroller: its width says how many tiles make a row. */
  const track = (node: HTMLElement) => {
    const sync = () => (width = node.clientWidth);
    sync();
    const resize = new ResizeObserver(sync);
    resize.observe(node);
    return { destroy: () => resize.disconnect() };
  };

  $effect(() => {
    // untracked: `load` reads `loaded`, and a re-run would drop and re-add every watch
    untrack(() => {
      void applications.load();
      void uninstall.load();
      applications.watch();
    });
    return () => applications.unwatch();
  });

  const start = async (a: AppEntry) => {
    try {
      await startApp(a);
    } catch (e) {
      logError('applications.start', e);
      notices.push({ kind: 'error', message: `Couldn’t start ${a.name}: ${String(e)}` });
    }
  };

  /** Navigate the tab to the folder the app lives in and select it there (as Gallery does). */
  const reveal = async (a: AppEntry) => {
    const path = appDiskPath(a);
    const parent = parentOf(path);
    if (!parent) return;
    await tabs.active.navigate(parent);
    selection.reveal(path);
  };

  const copyPath = (a: AppEntry) => copyAppPath(a);

  const select = (i: number) => (index = i);

  const oncontextmenu = (a: AppEntry, i: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    index = i;
    items = applicationsMenuFor(a, {
      start,
      reveal,
      copyPath,
      uninstall: { state: (x) => uninstall.menuState(x), run: (x) => uninstall.ask(x) },
    });
    menu.openAt(e.clientX, e.clientY);
  };

  const onkeydown = (e: KeyboardEvent) => {
    if (heldByDialog(e)) return;
    const shown = applications.shown;
    const action = appKeyAction(e, {
      index,
      count: shown.length,
      cols,
      filter: applications.filter,
      inInput: e.target instanceof HTMLInputElement,
    });
    if (action.kind === 'none') return;
    e.preventDefault();
    if (action.kind === 'reload') void applications.reload();
    else if (action.kind === 'start') void start(shown[Math.min(index, shown.length - 1)]);
    else if (action.kind === 'move') index = action.to;
    else {
      applications.filter = action.text;
      index = 0;
    }
  };

  /** the filter box changed by itself (typing, paste): the highlight goes back to the first hit */
  const oninput = (text: string) => {
    applications.filter = text;
    index = 0;
  };

  return {
    menu,
    get items() {
      return items;
    },
    track,
    get shown() {
      return applications.shown;
    },
    get count() {
      return applications.items.length;
    },
    get filter() {
      return applications.filter;
    },
    get index() {
      return index;
    },
    get loading() {
      return applications.loading;
    },
    get error() {
      return applications.error;
    },
    retry: () => void applications.reload(),
    select,
    start,
    oncontextmenu,
    onkeydown,
    oninput,
  };
};

// Window-level glue: sidebar places, the first navigation (from argv, else Home), launches
// handed over by a second process, window-wide shortcuts, status text.
import { untrack } from 'svelte';
import { initialLaunch, onLaunch } from '$lib/api/launch';
import { emitSettingsChanged, onSettingsChanged } from '$lib/api/settings';
import {
  currentWindowLabel,
  isMainWindow,
  onCloseRequested,
  onExternalDrag,
  onFocused,
  isWindowVisible,
  setZoom,
  openWindowWithTabs,
  showWindow,
  windowOpenTabs,
  windowOpenTarget,
  type ExternalDragEvent,
} from '$lib/api/window';
import { placeTileCount } from '$lib/data/place-tiles';
import { menuCommandFor, shortcutFor } from '$lib/data/shortcuts';
import { onMenuCommand } from '$lib/api/menu';
import { actions } from '$lib/state/actions.svelte';
import { confirm } from '$lib/state/confirm.svelte';
import { undoHistory } from '$lib/state/undo-history.svelte';
import { modalOpen } from '$lib/state/modal.svelte';
import { customize } from '$lib/state/customize.svelte';
import { settingsDialog } from '$lib/state/settings-dialog.svelte';
import { shellVerbs } from '$lib/state/shell-verbs.svelte';
import { drag } from '$lib/state/drag.svelte';
import { listing } from '$lib/state/listing.svelte';
import { notices } from '$lib/state/notices.svelte';
import { gallery } from '$lib/state/gallery.svelte';
import { applications } from '$lib/state/applications.svelte';
import { recycle } from '$lib/state/recycle.svelte';
import { openInExplorer } from '$lib/api/recycle';
import { classifyLaunchArg } from '$lib/utils/shell-arg';
import { places } from '$lib/state/places.svelte';
import { residency } from '$lib/state/residency.svelte';
import { search } from '$lib/state/search.svelte';
import { selection } from '$lib/state/selection.svelte';
import { MAX_OPEN_TABS, clampZoom, settings } from '$lib/state/settings.svelte';
import { undoLog } from '$lib/state/undo-log.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { terminal } from '$lib/state/terminal.svelte';
import { theme } from '$lib/state/theme.svelte';
import { transfers } from '$lib/state/transfers.svelte';
import { watcher } from '$lib/state/watcher.svelte';
import { wsl } from '$lib/state/wsl.svelte';
import { spotlight } from '$lib/state/spotlight-bridge.svelte';
import type { Launch } from '$lib/types/launch';
import {
  locationLabel,
  parseLocation,
  pathLocation,
  startLocation,
  tabToken,
} from '$lib/utils/location';
import { attachLogConsole, logError, logInfo } from '$lib/api/log';
import { useFirstPaint } from '$lib/hooks/use-first-paint.svelte';
import { filteredItemsText } from '$lib/utils/status-text';
import { selectPlan } from '$lib/utils/launch-select';
import { planRestore, windowTabsOf, type WindowPlan } from '$lib/utils/restore-tabs';
import { openTabsHere } from '$lib/state/tab-restore';
import { holdWindows, saveWindowTabs, takeLastSession, type SavedSession } from '$lib/api/session';
import { createSessionRestore } from '$lib/utils/session-restore';
import { defaultHandler } from '$lib/state/default-handler.svelte';
import { textOnAccent } from '$lib/utils/contrast';
import { onWindows } from '$lib/utils/platform';

/** Files dragged in from another app: light the target under them, then Explorer's move-or-copy rule on drop. */
const applyExternalDrag = (e: ExternalDragEvent) => {
  const scale = window.devicePixelRatio || 1; // Tauri reports physical pixels
  if (e.type === 'leave') drag.cancel();
  else if (e.type === 'drop') void drag.externalDrop(e.paths, e.x / scale, e.y / scale);
  else drag.externalOver(e.x / scale, e.y / scale);
};

/**
 * Show what a launch asked for in `tab`: its folder (or place), then its item selected. A
 * hidden item ("Show in folder" on a dotfile) turns "show hidden" on first, or the selection
 * would land nowhere.
 */
const applyLaunch = async (launch: Launch, tab = tabs.active) => {
  actions.cancelRename(); // a launch mid-rename would commit the box against the wrong folder
  // A shell folder Trove does not show (Control Panel, Network, `shell:AppsFolder`…) goes back
  // to Explorer; the tab stays where it is. This PC and the Recycle Bin are our own places.
  if (launch.path && classifyLaunchArg(launch.path) === 'explorer') {
    try {
      await openInExplorer(launch.path);
    } catch (e) {
      actions.notify(String(e), 'error');
    }
    // Never leave a blank tab behind: a launch that opened nothing shows the start place.
    if (!tab.path) await tab.navigate(startLocation(settings.startPlace), { replace: true });
    return;
  }
  const target = launch.path ? parseLocation(launch.path) : startLocation(settings.startPlace);
  await tab.navigate(target, { replace: true });
  await restoreSession(launch);
  if (!launch.select) return;
  if (selectPlan(launch.select, tab.visible, tab.entries) === 'reveal-hidden') {
    settings.showHidden = true;
    actions.notify(
      `${locationLabel(pathLocation(launch.select))} is hidden — Show hidden items was turned on`,
    );
  }
  selection.reveal(launch.select);
};

/**
 * What the last run left open (`api/session`), read by `main` once at start and used by its
 * first launch only; `null` after, and then a launch falls back to `openTabs` as it always did.
 * A `main` rebuilt by a Mac Dock click gets the window closed last instead, active tab and all.
 */
let lastSession: SavedSession | null = null;

/**
 * The first launch of a session reopens the last session's tabs (a setting, and only
 * when argv asked for nothing): the first replaces the Home tab, the rest open behind it.
 * Every other window the last run had open at quit comes back too, each with its own tabs
 * and active tab (plan 15 G.45).
 */
const restoreSession = (launch: Launch) => {
  const plan = planRestore(launch.path, settings, lastSession);
  lastSession = null;
  return session.restore(plan, startsInTray(launch));
};

/** A `--hidden` start that stays in the tray (see `reveal`): its other windows wait for a show. */
const startsInTray = (launch: Launch) => launch.hidden && residency.wantsResident;

/** The last run's other windows, one after another, each cascaded from the one before. */
const openWindows = async (plans: WindowPlan[]) => {
  let from: string | undefined;
  for (const plan of plans) {
    try {
      from = await openWindowWithTabs(plan.tabs, plan.active, from);
    } catch (e) {
      logError('restore window', e);
    }
  }
};

/** This window's restore and its saves to the session (`utils/session-restore`). */
const session = createSessionRestore({
  openHere: (plan) => void openTabsHere(plan),
  openWindows,
  hold: holdWindows,
  save: (plan) => saveWindowTabs(plan.tabs, plan.active),
  onError: logError,
});

/**
 * Put the window on screen. It is built hidden (`visible: false` in tauri.conf.json) so that
 * nobody watches an empty translucent rectangle while the first folder is read — a window
 * with no content and no decorations is what "it freezes on launch" looked like. Called once
 * the first listing has landed, whether that listing succeeded or not.
 *
 * The one launch that stays off screen is `--hidden` (the "start with Windows" entry) on a
 * build the settings really do say is resident; without a tray there is nothing to come back
 * from, so it is shown anyway. A normal start is also shown by Rust after a few seconds, in
 * case none of this runs; a `--hidden` start has no such backstop, which is one reason the show
 * goes through Rust (`showWindow`): it lands a restored maximize itself, rather than leaving it
 * to a focus event this show may never bring.
 */
export const reveal = (launch: Launch) => {
  if (launch.hidden && residency.wantsResident) return;
  void showWindow();
};

/** The longest a close waits on the settings write (`attachCloseFlush`). */
export const CLOSE_FLUSH_LIMIT_MS = 2000;

/**
 * Ask the window to write out whatever the save debounce is still holding before it goes: the
 * close waits on this promise, so the `invoke` round trip finishes while the webview is still
 * alive. `flush()` is safe with nothing pending, so this needs no condition; a write that fails
 * must not keep the window open, so the rejection dies here (and again inside the subscription).
 * Returns the unlisten function, as the other subscriptions in this file do.
 */
export const attachCloseFlush = () =>
  onCloseRequested(() =>
    Promise.race([
      settings.flush().catch(() => {}),
      // a write that never answers must not hold the window open: every window closes through
      // here now, a second one included, so after this long it goes without the write
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_FLUSH_LIMIT_MS)),
    ]),
  );

export const useShell = () => {
  // the start-time line, `starting → first folder painted` in ms (plan 21 gap 6)
  useFirstPaint();
  $effect(() => {
    // First of all: send this webview's console into the same file as the Rust side, so an
    // error thrown here and an error returned by a command are readable next to each other.
    attachLogConsole();
    // Proves the webview→Rust log path is live, and says the frontend actually booted — the
    // thing `REVEAL_BACKSTOP_MS` in lib.rs exists to paper over when it does not.
    logInfo('frontend: shell mounted');
    // ⚠️ `untrack` is load-bearing, not tidiness. Every one of these `load()` methods *reads*
    // its own `loaded` $state to decide whether to skip (`places.svelte.ts:18`,
    // `wsl:14`, `shell-verbs:16`, `settings:363`) and then *writes* it `true` when done. Read
    // inside an effect, that read is a dependency — so each completed load re-fired this whole
    // effect, and `trove.log` showed the body running 4–5× per launch: every OS-facing
    // subscription below torn down and rebuilt three or four times before the window was up,
    // and `known_folders` / `drives` asked four times over. This is once-on-mount setup and
    // must not be reactive.
    //
    // the Re-apply offer needs both what we did (settings) and what the registry says now
    // settings first: the restored tabs, residency and the hidden start all read them
    const ready = untrack(() => {
      // `places.load()` is contracted never to reject (every failure lands in a per-source
      // error field). This catch is here so a future break in that contract is a log line
      // rather than the unhandled rejection this used to be.
      places.load().catch((e: unknown) => logError('places.load', e));
      void wsl.load();
      void shellVerbs.load();
      void theme.load();
      return settings.load();
    });
    void ready.then(() => defaultHandler.load());
    // A window a detached tab or Ctrl+N opened reads its target from its URL; argv, the
    // restored tabs, the launch event, the chord and the tray belong to `main` alone.
    const main = isMainWindow();
    if (main) {
      // the last run's undo history, under anything done since (plan 08 F2)
      void undoLog.load(main);
      // The Spotlight chord is a setting, so it can only be registered once settings are read.
      void ready.then(() => spotlight.register(settings.spotlightHotkey));
      // asked for even with Restore tabs off: it is handed out once per run either way
      const last = takeLastSession().catch((e: unknown) => {
        logError('takeLastSession', e);
        return null;
      });
      void Promise.all([ready, initialLaunch(), last])
        .then(([, l, s]) => {
          lastSession = s;
          return applyLaunch(l).finally(async () => {
            // a launch handed to Explorer returns before the restore: the windows still return
            if (!session.restored) await restoreSession(l).catch((e) => logError('restore', e));
            reveal(l);
            // shown already (a tray click while starting): the held windows open now
            if (session.pending.length > 0 && (await isWindowVisible().catch(() => false)))
              await session.shown();
          });
        })
        .catch(() => void showWindow());
    } else {
      const target = windowOpenTarget();
      const restored = windowOpenTabs();
      void ready.then(() => {
        // a window the last run had open: all its tabs (`openWindowWithTabs`)
        if (restored.tabs.length > 1) void openTabsHere(restored);
        else
          void tabs.active.navigate(
            target ? parseLocation(target) : startLocation(settings.startPlace),
          );
        // nothing more to restore here: this window's own saves may go out now
        void session.restore({ main: { tabs: [], active: 0 }, others: [] }, false);
      });
    }
    // a second process → a new tab, as Explorer does
    const unlisten = main
      ? onLaunch((l) => void applyLaunch(l, tabs.openForLaunch(l.path ?? undefined) ?? tabs.active))
      : null;
    const detachTransfers = transfers.attach();
    const detachWatcher = watcher.attach();
    const detachSearch = search.attach();
    const detachTerminal = terminal.attach();
    const detachSpotlight = main ? spotlight.attach() : null;
    const detachResidency = main ? residency.attach() : null;
    const unlistenDrag = onExternalDrag(applyExternalDrag);
    // a hidden start's held windows open the first time main is shown
    const unlistenFocus = main ? onFocused(() => void session.shown()) : null;
    // a Mac's File menu (⌘T, ⌘N, ⌘W): the same actions as the chords, and held by a dialog alike
    const unlistenMenu = onMenuCommand((command) => {
      if (!modalOpen()) void menuCommandFor(command)?.();
    });
    // A setting changed in another window (see the persist effect below).
    const unlistenSettings = onSettingsChanged(currentWindowLabel(), (patch) =>
      settings.applyRemote(patch),
    );
    return () => {
      void unlisten?.then((f) => f());
      void unlistenDrag.then((f) => f());
      void unlistenFocus?.then((f) => f()).catch(() => {});
      void unlistenMenu.then((f) => f());
      void unlistenSettings.then((f) => f()).catch(() => {});
      detachTransfers();
      detachWatcher();
      detachSearch();
      detachTerminal();
      detachSpotlight?.();
      detachResidency?.();
    };
  });

  // Residency follows the settings and the default-handler toggle: the tray, hide-on-close
  // and the Run entry are pushed to Rust whenever what is wanted changes (after settings load).
  $effect(() => {
    const wanted = [residency.wantsResident, residency.wantsStartup, settings.loaded];
    if (wanted[2] && isMainWindow()) untrack(() => void residency.sync());
  });

  // Windows reset the default file manager (or the exe moved): offer once, in a toast, and
  // never re-apply silently. The toast is pushed when the condition turns true, not while it
  // stays true.
  let offered = false;
  $effect(() => {
    const needs = defaultHandler.needsReapply;
    if (!needs) {
      offered = false;
      return;
    }
    if (offered || !isMainWindow()) return;
    offered = true;
    untrack(() =>
      notices.push({
        kind: 'warning',
        message: defaultHandler.reapplyText,
        action: { label: 'Re-apply', run: () => void defaultHandler.apply() },
      }),
    );
  });

  // Remember the open folder tabs for the next session: the fallback for a run with no session
  // file, folders only as it always was (the session below keeps the places too).
  $effect(() => {
    const paths = tabs.list.map((t) => t.path).filter((p) => p !== '');
    untrack(() => {
      if (settings.loaded && isMainWindow()) settings.openTabs = paths.slice(0, MAX_OPEN_TABS);
    });
  });
  // …and, for EVERY window, its tabs and active tab in the session Rust keeps (plan 15 G.45):
  // each window speaks only for itself, so no window's save can drop another's. Held back until
  // the restore has run (`session.save`), so a crash during start keeps the last session.
  $effect(() => {
    const plan = windowTabsOf(
      tabs.list.map((t) => tabToken(t.location)),
      tabs.activeIndex,
      MAX_OPEN_TABS,
    );
    untrack(() => session.save(plan));
  });

  // The UI zoom ("text size"): applied whenever it changes; the first run on a machine takes
  // the desktop's own text size (Windows' text size, GNOME's Large Text) so this app grows with it.
  $effect(() => {
    if (!settings.loaded || !theme.loaded) return;
    untrack(() => {
      if (settings.firstRun && theme.textScale !== 1) {
        settings.zoom = clampZoom(theme.textScale);
        settings.firstRun = false;
      }
    });
  });
  $effect(() => {
    if (settings.loaded) void setZoom(settings.zoom).catch(() => {});
  });

  // The accent: sapphire (`app.css`) unless "Match system" is chosen AND Windows gave us an
  // accent (`core/theme.rs` reads DWM only on Windows; elsewhere `theme.accent` is just the
  // token default, so it is not "known"). Then it is set inline, with black or white text by
  // contrast. One accent in both light and dark themes — Windows has a single one.
  $effect(() => {
    if (!settings.loaded || !theme.loaded) return;
    const root = document.documentElement.style;
    if (settings.accentSource === 'system' && onWindows()) {
      root.setProperty('--color-accent', theme.accent);
      root.setProperty('--color-accent-text', textOnAccent(theme.accent));
    } else {
      root.removeProperty('--color-accent');
      root.removeProperty('--color-accent-text');
    }
  });
  // ⛔ `theme.transparency` is deliberately NOT applied here any more. It used to add `no-mica`
  // to `body`, which painted `--color-mica` on the body — and a body background propagates to
  // the viewport canvas, which is square, so that flat fill silently cancelled the window's
  // rounded frame (measured: 10px instead of 14). No Windows/Linux window asks for
  // `windowEffects`, so there the chrome colour is unconditional and lives on the shell root;
  // there is nothing left for the OS transparency flag to switch. (A Mac's explorer windows do
  // have glass, the `sidebar` material; macOS's own Reduce Transparency setting flattens it.) See `app.css`, the html/body rule.

  // The terminal pane follows the active tab's folder (when it is set to); only the path is
  // tracked, the pane's own state is read untracked.
  $effect(() => {
    const path = tabs.active.path;
    untrack(() => terminal.onNavigated(path));
  });

  // Watch exactly the folders open in tabs: reading every tab's path reruns this on any
  // navigation, open or close.
  $effect(() => {
    watcher.sync(tabs.list.map((t) => t.path));
  });

  // A search belongs to where it was started — a folder, or a place whose drives it covers:
  // moving the active tab elsewhere (or switching to a tab on another location) drops it.
  // Only the location is tracked.
  $effect(() => {
    const location = tabs.active.location;
    untrack(() => {
      if (search.active && !search.belongsTo(location)) search.clear();
    });
  });

  // Persist settings: reading every field in snapshot() makes this rerun on any change.
  // `main` writes the whole file. Every window also tells the others which fields IT changed, so
  // they show it and `main` saves it; a second window writes just those fields as well (merged
  // into the file by Rust), so its change is kept even when `main` is already gone. A second
  // window never writes its whole snapshot: it is only as fresh as its own load, and would put
  // back what `main` changed since. A field received from another window is not sent back
  // (`takeChanges` / `applyRemote`), so two windows cannot echo a change between them.
  $effect(() => {
    const snapshot = settings.snapshot();
    untrack(() => {
      const main = isMainWindow();
      const patch = settings.takeChanges(snapshot);
      if (Object.keys(patch).length > 0) {
        void emitSettingsChanged(currentWindowLabel(), patch).catch((e: unknown) =>
          logError('settings.emit', e),
        );
        if (!main) settings.schedulePatch(patch);
      }
      if (main) settings.scheduleSave(snapshot);
    });
  });

  // …and the other half of that debounce. Closing the window destroys the webview and every
  // timer with it, so a tab opened or a column dragged inside the last `SAVE_DELAY_MS` was
  // simply never written — and the shipped defaults (`keepRunning: false`, handler unapplied)
  // are exactly the path that destroys instead of hiding. `onCloseRequested` fires on all three
  // close paths, Alt+F4 and an OS shutdown included, and awaiting inside it holds the window
  // open for the write's round trip; it then hands the close back to Rust (see the ⛔ note on
  // `onCloseRequested` — the frontend is not permitted to destroy a window and must not try).
  // Every window: a second window's own changes wait on the same debounce (`schedulePatch`).
  // Not reactive: this registers once and unlistens on teardown.
  // A registration that fails leaves nothing to unlisten, and must not become an unhandled
  // rejection either — it is a lost flush, not a broken window.
  $effect(() => {
    const unlistenClose = attachCloseFlush().catch(() => () => {});
    return () => void unlistenClose.then((f) => f());
  });

  // The selection is one singleton over whichever list is mounted; a place mounts none
  // (unless a search's results are showing), so rows selected in the folder before it must
  // not linger as targets for Delete or Rename.
  $effect(() => {
    if (!tabs.active.showsList && !search.active) selection.clear();
  });

  /** The window-wide shortcuts from `data/shortcuts.ts` — attached to the window. */
  const onkeydown = (e: KeyboardEvent) => {
    // a text field (rename box, address bar, search) owns its own undo, Backspace and Alt chords,
    // and the terminal its shell's ^L, ^K, ^E, ^F and Alt+D
    const hit = shortcutFor(e, document.activeElement);
    if (hit === null) return;
    // ⚠️ prevented BEFORE the dialog check: WebView2 keeps its own accelerators, so a key we
    // own but skip would reach the browser — Ctrl+R / F5 reload the whole app, Ctrl+F opens
    // its find bar, behind the dialog
    e.preventDefault();
    // under a dialog nothing acts behind it (Backspace = Back, Ctrl+W, Ctrl+Z…): `state/modal`
    if (modalOpen()) return;
    void hit.run();
  };

  /**
   * A lazy dialog's chunk that fails to load would leave its question pending — and with it
   * `state/modal` holding every key in the window — for good. Give the question up instead
   * (Shell.svelte's `{:catch}`); the next open tries the import again.
   */
  const lazyDialog = <T>(load: Promise<T>, giveUp: () => void): Promise<T> =>
    load.catch((err: unknown) => {
      giveUp();
      throw err;
    });
  const giveUp = {
    confirm: () => confirm.answer(false),
    conflict: () => transfers.cancelPending(),
    customize: () => customize.close(),
    settings: () => settingsDialog.close(),
    undoHistory: () => undoHistory.close(),
  };

  /** The mouse's side buttons, as Explorer: 3 = Back, 4 = Forward. Not behind a dialog. The listener
   * in `utils/browser-keys` already cancels the WebView's own history walk. */
  const onmouseup = (e: MouseEvent) => {
    if (e.button !== 3 && e.button !== 4) return;
    if (modalOpen()) return;
    if (e.button === 3) tabs.active.back();
    else tabs.active.forward();
  };

  /** WebView2's own context menu never shows — title bar, sidebar, anywhere. Ours is the list's. */
  const oncontextmenu = (e: MouseEvent) => e.preventDefault();

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const itemCount = $derived(
    tabs.active.location.kind === 'path' || tabs.active.location.kind === 'archive' || search.active
      ? listing.rows.length
      : tabs.active.location.kind === 'gallery'
        ? gallery.items.length
        : tabs.active.location.kind === 'applications'
          ? applications.shown.length
          : tabs.active.location.kind === 'recycle-bin'
            ? recycle.count
            : placeTileCount(tabs.active.location.kind),
  );
  /** what the place holds before its own filter: only Applications filters its tiles */
  const itemTotal = $derived(
    tabs.active.location.kind === 'applications' ? applications.items.length : itemCount,
  );
  const status = $derived(
    tabs.active.loading
      ? tabs.active.loadingText
      : tabs.active.refreshing
        ? 'Refreshing…'
        : search.running
          ? `Searching… ${itemCount} found`
          : filteredItemsText(itemCount, itemTotal),
  );
  const selected = $derived(
    selection.count > 0 ? `${plural(selection.count, 'item')} selected` : '',
  );
  return {
    get status() {
      return status;
    },
    get selected() {
      return selected;
    },
    /**
     * The file list shows for a folder, inside an archive, and for a search's results wherever
     * it was started; Home / This PC / Gallery otherwise show their own view.
     */
    get showList() {
      return tabs.active.showsList || search.active;
    },
    /** Explorer's View ▸ Show ▸ Navigation pane (plan 06 6.3): off, the sidebar is not drawn */
    get navPane() {
      return settings.navPane;
    },
    /** a folder in its Gallery view (plan 15 G.52); a search's results still show as a list */
    get showFolderGallery() {
      return tabs.active.showsGallery && !search.active;
    },
    /** a paste is waiting on Replace / Skip / Keep both — the dialog mounts */
    get conflict() {
      return transfers.pending !== null;
    },
    /** a yes/no question (permanent delete) is open — the confirm dialog mounts */
    get confirm() {
      return confirm.pending !== null;
    },
    /** "Customize context menu…" is open — its dialog mounts */
    get customizing() {
      return customize.open;
    },
    /** Settings… is open — its dialog mounts */
    get settingsOpen() {
      return settingsDialog.open;
    },
    /** Edit ▸ History is open — its panel mounts */
    get undoHistoryOpen() {
      return undoHistory.open;
    },
    onkeydown,
    lazyDialog,
    giveUp,
    oncontextmenu,
    onmouseup,
  };
};

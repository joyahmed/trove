// The editable address bar: shows crumbs until clicked, then a text field; Enter navigates,
// Escape cancels. "This PC" / "Home" typed there go to the place; a file's path opens the file
// and stays put, as Explorer does. Inside the user's home the crumbs start at `~`, and `~/x`
// typed there goes under it (plan 12, D7). Returns getters so the component stays live
// (CONTRIBUTING.md § 1). The ▾ at its end (and F4 / Alt+↓) lists the places this tab has been,
// newest first, as Explorer's does; picking one goes there.
import { openPath, openUrl, pathKind, readDir } from '$lib/api/fs';
import { logError } from '$lib/api/log';
import { userProfile } from '$lib/api/shell';
import type { GlyphName } from '$lib/data/glyphs';
import { useMenu, type MenuItem } from '$lib/hooks/use-menu.svelte';
import { actions } from '$lib/state/actions.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import type { Location, PlaceKind } from '$lib/types/location';
import {
  HOME_MARK,
  crumbsOfLocation,
  locationText,
  parseLocation,
  pathLocation,
  sameLocation,
  urlScheme,
} from '$lib/utils/location';
import { isWslPath } from '$lib/utils/path';
import { crumbMenuItems, NO_SUBFOLDERS } from '$lib/utils/crumb-menu';
import { settings } from '$lib/state/settings.svelte';
import { archiveLocation, isBrowsableArchive } from '$lib/utils/archive-location';
import type { Attachment } from 'svelte/attachments';

/**
 * The home folder, from the OS (`USERPROFILE` on Windows, `HOME` elsewhere) rather than guessed
 * from the path's shape. Asked once per window; until it lands the crumbs are the full path.
 */
let home = $state<string | null>(null);
let homeAsked = false;
const askHome = () => {
  if (homeAsked) return;
  homeAsked = true;
  userProfile()
    .then((p) => (home = p))
    .catch((e) => logError('addressBar.userProfile', e));
};

/** The ribbon's leading icon: where the path lives — home, a WSL distro, a drive, or the place. */
const PLACE_GLYPH: Record<PlaceKind, GlyphName> = {
  home: 'home',
  'this-pc': 'thisPc',
  gallery: 'gallery',
  applications: 'fileApp',
  'recycle-bin': 'delete',
};
const ribbonGlyph = (loc: Location, underHome: boolean): GlyphName => {
  // inside an archive: where the archive itself lives
  if (loc.kind === 'archive') return ribbonGlyph({ kind: 'path', path: loc.archive }, underHome);
  if (loc.kind !== 'path') return PLACE_GLYPH[loc.kind];
  if (underHome) return 'home';
  return isWslPath(loc.path) ? 'linux' : 'drive';
};

/** The links the address bar hands to the browser; Rust `open_url` passes any scheme on, so
 * this list is the gate (an `ssh://` or `vscode://` typed here is refused, not launched). */
const BROWSER_SCHEMES: readonly string[] = ['http', 'https', 'ftp', 'mailto'];

/** The event the bar listens for to open its ▾ list (`historyTarget`); the window's F4 sends it. */
export const ADDRESS_HISTORY_EVENT = 'trove:address-history';

/** Explorer's keys for the address bar's ▾ list: Alt+↓ in the field, F4 (the window's shortcut too). */
export const isHistoryKey = (e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'shiftKey'>) =>
  !e.ctrlKey &&
  !e.shiftKey &&
  ((e.key === 'ArrowDown' && e.altKey) || (e.key === 'F4' && !e.altKey));

/** One row of the ▾ list: the place's full text, its ribbon icon, and a click goes there. */
const historyItem = (loc: Location, underHome: boolean): MenuItem => ({
  kind: 'item',
  key: locationText(loc),
  label: locationText(loc),
  glyph: ribbonGlyph(loc, underHome),
  run: () => tabs.active.navigate(loc),
});

/** What the ▾ list shows on a tab with nowhere behind or ahead of it. */
const NO_HISTORY: MenuItem = {
  kind: 'item',
  key: 'none',
  label: 'No recent locations',
  enabled: () => false,
  run: () => undefined,
};

export const useAddressBar = () => {
  askHome();
  let editing = $state(false);
  let draft = $state('');
  const crumbs = $derived(crumbsOfLocation(tabs.active.location, home));
  const glyph = $derived(ribbonGlyph(tabs.active.location, crumbs[0]?.label === HOME_MARK));
  const historyMenu = useMenu();
  const historyItems = $derived.by((): MenuItem[] => {
    const list = tabs.active.history.map((loc) =>
      historyItem(loc, crumbsOfLocation(loc, home)[0]?.label === HOME_MARK),
    );
    return list.length ? list : [NO_HISTORY];
  });

  // The chevron between two crumbs (and the one after the last) lists the subfolders of the crumb
  // to its left; picking one goes there (plan 06 § 6.4). One menu, shared: it holds the rows of
  // whichever chevron opened it, and `crumbMenuOf` says which, for aria-expanded.
  const crumbMenu = useMenu();
  let crumbItems = $state<MenuItem[]>([NO_SUBFOLDERS]);
  let crumbMenuOf = $state<number | null>(null);
  let crumbAsk = 0;
  /** Whether the chevron after crumb `i` can list anything: only a folder crumb has subfolders. */
  const canListCrumb = (i: number) => crumbs[i]?.location.kind === 'path';
  /**
   * Open the list under the chevron `anchor` that follows crumb `i`. The folder is read first and
   * the list opens once it is known; an unreadable or empty folder shows one quiet "No
   * subfolders" row. A second press on the same chevron closes it.
   */
  const openCrumbMenu = async (i: number, anchor: HTMLElement) => {
    const crumb = crumbs[i];
    if (!crumb || crumb.location.kind !== 'path') return;
    if (crumbMenu.open && crumbMenuOf === i) return crumbMenu.close();
    const ask = ++crumbAsk;
    editing = false;
    let items: MenuItem[];
    try {
      const next = crumbs[i + 1]?.location;
      items = crumbMenuItems((await readDir(crumb.location.path)).entries, {
        showHidden: settings.showHidden,
        current: next?.kind === 'path' ? next.path : null,
        go: (path) => tabs.active.navigate(pathLocation(path)),
      });
    } catch (e) {
      logError('addressBar.crumbMenu', e);
      items = [NO_SUBFOLDERS];
    }
    if (ask !== crumbAsk) return; // a newer press superseded this one while the read ran
    crumbItems = items;
    crumbMenuOf = i;
    crumbMenu.openBelow(anchor);
  };
  const onCrumbChevron = (i: number, e: MouseEvent) => {
    e.stopPropagation();
    if (e.currentTarget instanceof HTMLElement) void openCrumbMenu(i, e.currentTarget);
  };

  const startEdit = () => {
    draft = locationText(tabs.active.location);
    editing = true;
  };
  const cancel = () => {
    editing = false;
  };
  const commit = async () => {
    editing = false;
    if (!draft.trim()) return;
    // a typed link opens in the default browser and the tab stays put, as in Explorer;
    // `file://` is a local path and falls through to navigate like one
    const scheme = urlScheme(draft);
    if (scheme !== null && scheme !== 'file') {
      if (!BROWSER_SCHEMES.includes(scheme))
        return void actions.notify(`Trove does not open ${scheme}: links`, 'error');
      try {
        await openUrl(draft.trim());
      } catch (e) {
        actions.notify(String(e), 'error');
      }
      return;
    }
    const to = parseLocation(draft, home);
    if (sameLocation(to, tabs.active.location)) return;
    if (to.kind === 'path' && (await pathKind(to.path)) === 'file') {
      // a zip / 7z / tar typed by its path opens inside Trove, as a double-click does
      if (settings.archivesOpenInside && isBrowsableArchive(to.path))
        return void (await tabs.active.navigate(archiveLocation(to.path)));
      try {
        await openPath(to.path);
      } catch (e) {
        actions.notify(String(e), 'error');
      }
      return;
    }
    await tabs.active.navigate(to);
  };
  /** Open the ▾ list under the address bar (`anchor`: the bar). A second press closes it. */
  const openHistory = (anchor: HTMLElement) => {
    if (historyMenu.open) return historyMenu.close();
    editing = false;
    historyMenu.openBelow(anchor);
  };
  /** The ▾ button: open the list under the bar the button sits in. */
  const onHistoryClick = (e: MouseEvent) => {
    const btn = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    const bar = btn?.closest<HTMLElement>('[data-address-bar]');
    if (bar) openHistory(bar);
  };
  /**
   * `{@attach}` on the bar: it opens the list when the window's F4 asks (`openAddressHistory`
   * in data/shortcuts.ts dispatches the event on it, as Ctrl+L clicks its crumb row).
   */
  const historyTarget: Attachment<HTMLElement> = (el) => {
    const onAsk = () => openHistory(el);
    el.addEventListener(ADDRESS_HISTORY_EVENT, onAsk);
    return () => el.removeEventListener(ADDRESS_HISTORY_EVENT, onAsk);
  };
  const onkeydown = (e: KeyboardEvent) => {
    if (isHistoryKey(e)) {
      e.preventDefault();
      const field = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
      const bar = field?.closest<HTMLElement>('[data-address-bar]');
      if (bar) openHistory(bar);
    } else if (e.key === 'Enter') void commit();
    else if (e.key === 'Escape') cancel();
  };
  /** `use:` action: focus and select the whole path when the field appears */
  const focus = (el: HTMLInputElement) => {
    el.focus();
    el.select();
  };

  return {
    get editing() {
      return editing;
    },
    get draft() {
      return draft;
    },
    set draft(v: string) {
      draft = v;
    },
    get crumbs() {
      return crumbs;
    },
    get glyph() {
      return glyph;
    },
    startEdit,
    cancel,
    commit,
    onkeydown,
    focus,
    go: (to: Location) => tabs.active.navigate(to),
    crumbMenu,
    get crumbItems() {
      return crumbItems;
    },
    /** the crumb index whose chevron opened the list, while it is open */
    get crumbMenuOf() {
      return crumbMenu.open ? crumbMenuOf : null;
    },
    canListCrumb,
    openCrumbMenu,
    onCrumbChevron,
    historyMenu,
    get historyItems() {
      return historyItems;
    },
    openHistory,
    onHistoryClick,
    historyTarget,
  };
};

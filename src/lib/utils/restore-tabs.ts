// Which folders a fresh window reopens: the last session's tabs, only when the setting is on
// and the launch itself asked for nothing (a launch with a path is that path, as Explorer).
//
// Since plan 15 G.45 that is every window the last run had open, each with its own tabs and
// active tab (`api/session`); `openTabs` in the settings is the fallback for a run that left no
// session file (the first start after an update from a build without one).
//
// A tab is saved as `tabToken` writes it: a folder's path, or a place's fixed token (Home, This
// PC, Gallery, Applications, the bin); `tabLocation` reads it back.
import type { SavedSession } from '$lib/api/session';
import type { Location } from '$lib/types/location';
import { tabLocation } from '$lib/utils/location';

export interface RestoreSettings {
  restoreTabs: boolean;
  openTabs: string[];
}

/** One window's tabs (`tabToken`s) and the index of the active one among them. */
export interface WindowPlan {
  tabs: string[];
  active: number;
}

/** `main`'s own tabs, and the windows to open beside it. */
export interface RestorePlan {
  main: WindowPlan;
  others: WindowPlan[];
}

export const tabsToRestore = (launchPath: string | null, s: RestoreSettings): string[] => {
  if (launchPath || !s.restoreTabs) return [];
  return s.openTabs.filter((p) => p !== '');
};

/** A saved tab that opens: a folder or a known place; never '' or an unknown token. */
const restorable = (t: unknown): t is string => typeof t === 'string' && tabLocation(t) !== null;

/** The tabs that open, the active index following its tab past the skipped ones (the first
 * when the active one is skipped or out of range). */
const cleanWindow = (tabs: string[], active: number): WindowPlan => {
  const i = Number.isInteger(active) ? active : 0;
  const kept: string[] = [];
  let at = 0;
  tabs.forEach((t, j) => {
    if (!restorable(t)) return;
    if (j === i) at = kept.length;
    kept.push(t);
  });
  return { tabs: kept, active: at };
};

const NOTHING: RestorePlan = { main: { tabs: [], active: 0 }, others: [] };

/**
 * What the first launch of a run reopens. `last` is the session the last run left (`main`'s
 * window first), or `null` when it left none — then `main` alone gets `openTabs`, as before.
 *
 * A launch with a path shows that path in `main`, but the last run's OTHER windows still come
 * back: the session was handed out to this run, and windows it does not reopen are gone for good.
 */
export const planRestore = (
  launchPath: string | null,
  s: RestoreSettings,
  last: SavedSession | null,
): RestorePlan => {
  if (!s.restoreTabs) return NOTHING;
  if (last === null || !Array.isArray(last.windows)) {
    return { main: { tabs: tabsToRestore(launchPath, s), active: 0 }, others: [] };
  }
  const [first, ...rest] = last.windows.map((w) => cleanWindow(w.tabs ?? [], w.active ?? 0));
  return { main: launchPath ? NOTHING.main : (first ?? NOTHING.main), others: rest };
};

/**
 * What a window reports as its tabs, given each tab's `tabToken`: the saved ones (an archive or
 * empty tab, '', is not restored), at most `max`, and the active one's index among them (the
 * first when the active tab is not saved).
 */
export const windowTabsOf = (tokens: string[], activeIndex: number, max: number): WindowPlan => {
  const active = tokens[activeIndex]
    ? tokens.slice(0, activeIndex).filter((t) => t !== '').length
    : 0;
  return cleanWindow(tokens.filter((t) => t !== '').slice(0, max), active);
};

/** A drive path (`C:\x`, `C:/x`, `C:`) or a UNC / WSL share (`\\host\share`): Windows' kinds of path. */
const WINDOWS_PATH = /^(?:[A-Za-z]:(?:[\\/]|$)|[\\/]{2}[^\\/])/;

/** Whether a saved folder path can exist on this OS at all: an absolute path in this OS's own
 * form. A drive-letter or UNC path (and so a Windows Recycle Bin id such as `C:\$Recycle.Bin\S-1-…`)
 * is foreign on a Mac or Linux; a `/Users/…` or `/home/…` path is foreign on Windows. */
export const pathIsNative = (path: string, windows: boolean): boolean =>
  windows ? WINDOWS_PATH.test(path) : path.startsWith('/');

/**
 * THE one decision for a restored tab: where it really opens. A place (Home, This PC, the bin
 * of this machine…) opens as saved; a folder opens only when it is in this OS's form AND still
 * exists; anything else (another OS's path, a folder that is gone) opens `fallback`, which is
 * what a new tab shows. Never throws and never notifies: a stale tab is no error.
 */
export const resolveRestoredTab = async (
  token: string,
  deps: {
    windows: boolean;
    /** false only when the path is known to be missing (a failed check keeps the tab) */
    exists: (path: string) => Promise<boolean>;
    fallback: Location;
  },
): Promise<Location> => {
  const loc = tabLocation(token);
  if (loc === null) return deps.fallback;
  if (loc.kind !== 'path') return loc;
  if (!pathIsNative(loc.path, deps.windows)) return deps.fallback;
  return (await deps.exists(loc.path).catch(() => true)) ? loc : deps.fallback;
};

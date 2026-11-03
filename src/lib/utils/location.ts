// Pure helpers over `Location`: the parent to go Up to, crumbs for the address bar, the text
// a user types or reads, and equality. Path arithmetic stays in path.ts.
import { comingFrom } from '$lib/state/coming-from.svelte';
import type { Location, PlaceKind } from '$lib/types/location';
import {
  crumbsOf,
  folderKey,
  fromLinuxForm,
  isRootPath,
  parentOf,
  pathSep,
  samePath,
  toLinuxForm,
} from '$lib/utils/path';
import { binName, onWindows, thisPcLabel } from '$lib/utils/platform';
import {
  archiveText,
  crumbsOfArchive,
  labelOfArchive,
  parentOfArchive,
  parseArchiveText,
  sameArchiveLocation,
} from '$lib/utils/archive-location';

export const HOME: Location = { kind: 'home' };
export const THIS_PC: Location = { kind: 'this-pc' };
export const GALLERY: Location = { kind: 'gallery' };
/** The installed apps, the same list on every OS (plan 17, 17.2). */
export const APPLICATIONS: Location = { kind: 'applications' };
export const RECYCLE_BIN: Location = { kind: 'recycle-bin' };

export const pathLocation = (path: string): Location => ({ kind: 'path', path });

/** A place's name, read at call time so the "I'm coming from" words follow live (plan 19, 1.4.1).
 * "This Mac" / "This Computer" outside Windows style; ⛔ the key stays `this-pc` (plan 10, B.2.1). */
const placeLabel = (kind: PlaceKind): string => {
  switch (kind) {
    case 'home':
      return 'Home';
    case 'this-pc':
      return thisPcLabel();
    case 'gallery':
      return 'Gallery';
    case 'applications':
      return 'Applications';
    case 'recycle-bin':
      return binName();
  }
};

/** What the user types for a place, lower-cased; Explorer's own CLSIDs for This PC and the
 * Recycle Bin included (a desktop double-click on the bin passes the latter). ⛔ This PC's three
 * names are accepted on every OS, so a `?open=`, a typed address or a saved tab written on one
 * box still parses on another (plan 10, B.2.2). */
const PLACE_BY_TEXT: Record<string, Location> = {
  home: HOME,
  'this pc': THIS_PC,
  'this mac': THIS_PC,
  'this computer': THIS_PC,
  gallery: GALLERY,
  applications: APPLICATIONS,
  apps: APPLICATIONS,
  '::{20d04fe0-3aea-1069-a2d8-08002b30309d}': THIS_PC,
  'recycle bin': RECYCLE_BIN,
  trash: RECYCLE_BIN,
  '::{645ff040-5081-101b-9f08-00aa002f954e}': RECYCLE_BIN,
  'trove:home': HOME,
  'trove:gallery': GALLERY,
  'trove:applications': APPLICATIONS,
};

/** How a saved session writes a place tab: fixed and language-free, so a session written in one
 * UI language (or coming-from style) reads back in another. Explorer's CLSIDs where it has one. */
const PLACE_TOKEN: Record<PlaceKind, string> = {
  home: 'trove:home',
  'this-pc': '::{20d04fe0-3aea-1069-a2d8-08002b30309d}',
  gallery: 'trove:gallery',
  applications: 'trove:applications',
  'recycle-bin': '::{645ff040-5081-101b-9f08-00aa002f954e}',
};

/** A token this build does not know yet (a newer build's place) starts with this; never a path. */
const TOKEN_PREFIX = 'trove:';

/** A tab as the session saves it (plan 15 G.45): a folder's path, a place's token, or '' for a
 * tab that is not restored (an archive, an empty tab). Inverse of `tabLocation`. */
export const tabToken = (loc: Location): string => {
  if (loc.kind === 'path') return loc.path;
  if (loc.kind === 'archive') return '';
  return PLACE_TOKEN[loc.kind];
};

/** A saved tab → its location; null for '' or an unknown `trove:` token, so it is skipped. A
 * folder is its path as written: a folder saved as `Home` stays a folder, not the place. */
export const tabLocation = (token: string): Location | null => {
  if (token === '') return null;
  const lower = token.toLowerCase();
  const place = Object.values(PLACE_TOKEN).includes(lower) ? PLACE_BY_TEXT[lower] : undefined;
  if (place) return place;
  return lower.startsWith(TOKEN_PREFIX) ? null : pathLocation(token);
};

export interface Crumb {
  /** stable key for the address bar's `{#each}` — the path, or the place kind */
  key: string;
  label: string;
  location: Location;
  /** draw the `›` before this crumb: every crumb in Windows style (Explorer's leading ›), every crumb but the first in Mac and Linux style */
  sepBefore: boolean;
}

/** Paths compare by `samePath`: case-insensitively on Windows, exactly everywhere else. */
export const sameLocation = (a: Location, b: Location): boolean => {
  if (a.kind === 'path' && b.kind === 'path') return samePath(a.path, b.path);
  if (a.kind === 'archive' && b.kind === 'archive') return sameArchiveLocation(a, b);
  return a.kind === b.kind;
};

/** Up: a folder → its parent; a drive root or `/` → This PC; a place (or an empty tab) → nowhere. */
export const parentLocation = (loc: Location): Location | null => {
  if (loc.kind === 'archive') return parentOfArchive(loc);
  if (loc.kind !== 'path' || !loc.path) return null;
  const parent = parentOf(loc.path);
  return parent === null ? THIS_PC : pathLocation(parent);
};

/**
 * The tab title and the sidebar label: "Home", "This PC", the folder name, `C:` for a drive
 * root, the distro name for a WSL root.
 */
export const locationLabel = (loc: Location): string => {
  if (loc.kind === 'archive') return labelOfArchive(loc);
  if (loc.kind !== 'path') return placeLabel(loc.kind);
  // the last crumb: `C:` for a drive root, the distro for a WSL root, else the folder name
  return crumbsOf(loc.path).at(-1)?.label ?? loc.path;
};

/** What the home folder is shown as in the crumbs and accepted as in a typed path (plan 12, D7). */
export const HOME_MARK = '~';

/**
 * The address bar's crumbs: one for a place, one per segment for a path. Given the user's home
 * folder (`userProfile()`: `C:\Users\<name>`, `/Users/<name>`, `/home/<name>`), a path inside it
 * starts at one `~` crumb that goes home, instead of `C:` › `Users` › `<name>`.
 */
export const crumbsOfLocation = (loc: Location, home: string | null = null): Crumb[] =>
  withSeparators(plainCrumbs(loc, home));

/** Explorer's look: a `›` before every crumb (so one follows the icon) plus a tail after the
 * last. Finder and Nautilus: separators only BETWEEN crumbs. Follows the "I'm coming from" STYLE,
 * not the host (plan 19 Q2 / 3.1, Joy 2026-10-19), read at call time so a settings change redraws
 * the crumbs without a restart. */
const explorerCrumbs = (): boolean => comingFrom.style === 'windows';

const withSeparators = (crumbs: Omit<Crumb, 'sepBefore'>[]): Crumb[] =>
  crumbs.map((c, i) => ({ ...c, sepBefore: explorerCrumbs() || i > 0 }));

/** Whether a `›` trails the last crumb: Windows style only (the `data-crumb-tail` element). */
export const crumbTail = (): boolean => explorerCrumbs();

const plainCrumbs = (loc: Location, home: string | null): Omit<Crumb, 'sepBefore'>[] => {
  if (loc.kind === 'archive')
    return crumbsOfArchive(loc, plainCrumbs(pathLocation(loc.archive), home));
  if (loc.kind !== 'path') return [{ key: loc.kind, label: placeLabel(loc.kind), location: loc }];
  const crumbs = crumbsOf(loc.path).map((c) => ({
    key: c.path,
    label: c.label,
    location: pathLocation(c.path),
  }));
  // a root home (HOME=/ for a service account, or C:\) would put ~ on every path of the drive
  if (!home || isRootPath(home)) return crumbs;
  // compared crumb by crumb, so a sibling such as `C:\Users\Alexa` is never "inside" `C:\Users\alex`
  const depth = crumbsOf(home).length;
  const at = crumbs[depth - 1];
  // folderKey on both sides, so a home given with a trailing separator (`/home/alex/`) still matches
  if (depth === 0 || !at || !samePath(folderKey(at.key), folderKey(home))) return crumbs;
  return [{ key: at.key, label: HOME_MARK, location: at.location }, ...crumbs.slice(depth)];
};

/**
 * What the address bar edits: the path (a WSL path as `Ubuntu:/home/alex`), or the place's
 * name. Inverse of `parseLocation`.
 */
export const locationText = (loc: Location): string => {
  if (loc.kind === 'archive') return archiveText(loc, toLinuxForm(loc.archive) ?? loc.archive);
  return loc.kind === 'path' ? (toLinuxForm(loc.path) ?? loc.path) : placeLabel(loc.kind);
};

/** `~`, `~/x` or `~\x` → the same folder under `home`; null for anything else, or no home known. */
const fromHomeForm = (text: string, home: string | null): string | null => {
  if (!home || (text !== HOME_MARK && !/^~[\\/]/.test(text))) return null;
  const rest = text
    .slice(2)
    .split(/[\\/]+/)
    .filter(Boolean);
  return rest.length ? [home.replace(/[\\/]+$/, ''), ...rest].join(pathSep()) : home;
};

/** On Windows a typed drive path (`c:/a/b`, `C:\a/b`) becomes `C:\a\b`, as Explorer shows it. A
 * trailing separator is kept like backslash input; anything not drive-first is left as typed. */
const driveForm = (path: string): string =>
  onWindows() && /^[A-Za-z]:(?:[\\/]|$)/.test(path)
    ? path[0].toUpperCase() + path.slice(1).replaceAll('/', '\\')
    : path;

/** A typed path with its `.` and `..` segments resolved lexically, on every OS: `C:\a\b\..` →
 * `C:\a`, `/x/./y` → `/x/y`. Never climbs above the root (`C:\..` → `C:\`, `/..` → `/`,
 * `\\server\share\..` → `\\server\share\`, WSL shares included). A relative path keeps a
 * `..` it cannot resolve. A path with no dot segment comes back exactly as typed. */
const resolveDots = (path: string): string => {
  const win = onWindows();
  const split = win ? /[\\/]+/ : /\/+/;
  if (!path.split(split).some((s) => s === '.' || s === '..')) return path;
  const unc = win ? /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.exec(path) : null;
  const drive = win ? /^[A-Za-z]:[\\/]?/.exec(path) : null;
  const root = unc?.[0] ?? drive?.[0] ?? (!win && path.startsWith('/') ? '/' : '');
  const sep = win && path.includes('\\') ? '\\' : '/';
  const out: string[] = [];
  for (const seg of path.slice(root.length).split(split)) {
    if (seg === '' || seg === '.') continue;
    if (seg !== '..') out.push(seg);
    else if (out.length && out.at(-1) !== '..') out.pop();
    else if (!root) out.push(seg);
  }
  // a share or bare `C:` root gets its separator; `/` and `C:\` already end in one
  const head = root === '' || /[\\/]$/.test(root) ? root : root.replaceAll('/', sep) + sep;
  const trailing = out.length > 0 && /[\\/]$/.test(path) ? sep : '';
  return head + out.join(sep) + trailing;
};

/**
 * The scheme of typed text that is a link — `https://…`, `file:///…`, `mailto:…` — lower-cased;
 * null for anything else. A WSL distro (`Ubuntu:/home`) has one slash after its colon, never two,
 * and `trove:home` has none, so neither is a link.
 */
export const urlScheme = (text: string): string | null => {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text.trim()) ?? /^(mailto):/i.exec(text.trim());
  return m ? m[1].toLowerCase() : null;
};

/** `file:///C:/a%20b` → `C:/a b`, `file://server/share` → `\\server\share` on Windows,
 * `file:///home/a` → `/home/a` elsewhere; null if the text is no file URL. */
const fromFileUrl = (text: string): string | null => {
  if (urlScheme(text) !== 'file') return null;
  try {
    const url = new URL(text);
    const path = decodeURIComponent(url.pathname);
    const host = url.hostname.toLowerCase() === 'localhost' ? '' : url.hostname;
    if (!onWindows()) return host ? `//${host}${path}` : path;
    if (host) return `\\\\${host}${path.replaceAll('/', '\\')}`;
    return path.replace(/^\/(?=[A-Za-z]:)/, '');
  } catch {
    return null;
  }
};

/**
 * Typed text → a location: "This PC" / "Home" (any case) are places, `<distro>:/…` is a WSL
 * path, `~/…` is under `home` when it is known, `file:///…` the path it names, anything else a
 * Windows path. Any other link stays as typed — never a distro — for the address bar to hand on.
 */
export const parseLocation = (text: string, home: string | null = null): Location => {
  const trimmed = text.trim();
  // a path with an archive's name before its last part goes inside that archive (plan 16, 4.2)
  const asPath = (path: string) => {
    const fixed = resolveDots(driveForm(path));
    return parseArchiveText(fixed) ?? pathLocation(fixed);
  };
  const filePath = fromFileUrl(trimmed);
  if (filePath !== null) return asPath(filePath);
  if (urlScheme(trimmed) !== null) return pathLocation(trimmed);
  const underHome = fromHomeForm(trimmed, home);
  if (underHome !== null) return asPath(underHome);
  const wsl = fromLinuxForm(trimmed);
  if (wsl !== null) return asPath(wsl);
  return PLACE_BY_TEXT[trimmed.toLowerCase()] ?? asPath(trimmed);
};

/** The place a new tab opens, from the person's setting. */
export const startLocation = (place: 'home' | 'this-pc'): Location =>
  place === 'this-pc' ? THIS_PC : HOME;

/** How many places the address bar's history dropdown lists (Explorer's shows about this many). */
export const MAX_ADDRESS_HISTORY = 15;

/**
 * The address bar's ▾ list: the places this tab has been, newest first, each once, without the
 * one on screen. Built from the Back / Forward stacks: `forward[0]` is the latest place left by
 * Back, the top of `back` the one just before the current place. An archive has no text to type,
 * so it is listed too — picking it navigates like Back would.
 */
export const recentLocations = (
  back: readonly Location[],
  current: Location,
  forward: readonly Location[],
  max: number = MAX_ADDRESS_HISTORY,
): Location[] => {
  const out: Location[] = [];
  for (const loc of [...forward, ...[...back].reverse()]) {
    if (out.length >= max) break;
    if (loc.kind === 'path' && loc.path === '') continue;
    if (sameLocation(loc, current) || out.some((l) => sameLocation(l, loc))) continue;
    out.push(loc);
  }
  return out;
};

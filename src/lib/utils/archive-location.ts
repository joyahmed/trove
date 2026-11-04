// An archive browsed like a folder (plan 16, Phase 4): the `archive` Location's Up, crumbs,
// label and typed form. `location.ts` delegates its `archive` kind here. Pure — no state.
//
// The typed / shown form is the archive's path with the inner folders after it, in the
// path's own separator: `C:\x\a.zip\docs`, `/home/j/a.tar.gz/docs`. Reading it back, the first
// segment named like an archive (and followed by more) is where the archive ends — so a real
// FOLDER named `x.zip` cannot be typed into by its path (a rare name; the list still opens it).
import type { Location } from '$lib/types/location';
import { onWindows, readsRar } from '$lib/utils/platform';
import { crumbsOf, parentOf, pathSep, samePath } from '$lib/utils/path';

type Platform = Parameters<typeof onWindows>[0];

export type ArchiveLocation = Extract<Location, { kind: 'archive' }>;

/** Names Trove can browse inside: zip, 7z and the tar family, plus RAR in a build that reads it
 * (`readsRar`). A bare `x.gz` is one compressed file, not a folder, so it is not one of them
 * (it still extracts). */
const BROWSABLE = /\.(zip|7z|tar|tgz|txz|tzst|tar\.gz|tar\.xz|tar\.zst)$/i;
const RAR = /\.rar$/i;

export const isBrowsableArchive = (name: string): boolean =>
  BROWSABLE.test(name) || (RAR.test(name) && readsRar());

/** `inner` without leading/trailing separators, `/`-separated. */
const cleanInner = (inner: string) =>
  inner
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/');

export const archiveLocation = (archive: string, inner = ''): ArchiveLocation => ({
  kind: 'archive',
  archive,
  inner: cleanInner(inner),
});

export const sameArchiveLocation = (a: ArchiveLocation, b: ArchiveLocation, platform?: Platform) =>
  samePath(a.archive, b.archive, platform) && a.inner === b.inner;

/** Up: an inner folder → the one above it; the archive's top → the folder holding the archive. */
export const parentOfArchive = (loc: ArchiveLocation, platform?: Platform): Location | null => {
  if (loc.inner) return archiveLocation(loc.archive, loc.inner.split('/').slice(0, -1).join('/'));
  const parent = parentOf(loc.archive, platform);
  return parent === null ? null : { kind: 'path', path: parent };
};

const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** The tab title: the inner folder's name, or the archive's file name at its top. */
export const labelOfArchive = (loc: ArchiveLocation): string =>
  loc.inner ? (loc.inner.split('/').at(-1) ?? loc.inner) : nameOf(loc.archive);

export interface ArchiveCrumb {
  key: string;
  label: string;
  location: Location;
}

/**
 * `base`: the crumbs of the archive's own path (as `location.ts` builds them, `~` and all). The
 * last of them is the archive file itself, so it goes to the archive's top instead of trying to
 * list a file; then one crumb per inner folder.
 */
export const crumbsOfArchive = (loc: ArchiveLocation, base: ArchiveCrumb[]): ArchiveCrumb[] => {
  const head = base.slice(0, -1);
  const top: ArchiveCrumb = {
    key: loc.archive,
    label: base.at(-1)?.label ?? nameOf(loc.archive),
    location: archiveLocation(loc.archive),
  };
  const parts = loc.inner ? loc.inner.split('/') : [];
  const inner = parts.map((label, i) => {
    const at = parts.slice(0, i + 1).join('/');
    return { key: `${loc.archive}\u0000${at}`, label, location: archiveLocation(loc.archive, at) };
  });
  return [...head, top, ...inner];
};

/** The plain crumbs of a path, for a caller with no home folder in hand. */
export const archivePathCrumbs = (archive: string, platform?: Platform): ArchiveCrumb[] =>
  crumbsOf(archive, platform).map((c) => ({
    key: c.path,
    label: c.label,
    location: { kind: 'path', path: c.path },
  }));

/** What the address bar shows: the archive's path, then the inner folders in its separator. */
export const archiveText = (loc: ArchiveLocation, shownArchive = loc.archive): string => {
  if (!loc.inner) return shownArchive;
  const sep = shownArchive.includes('\\') ? '\\' : shownArchive.includes('/') ? '/' : pathSep();
  return [shownArchive.replace(/[\\/]+$/, ''), ...loc.inner.split('/')].join(sep);
};

/**
 * Typed text → an archive location, when a segment before the last is named like an archive:
 * `C:\x\a.zip\docs` → (`C:\x\a.zip`, `docs`); `C:\x\a.zip\` (a trailing separator) is its
 * top. null for anything else — including the archive's
 * own path with nothing after it, which is a file the address bar decides about.
 */
export const parseArchiveText = (text: string): ArchiveLocation | null => {
  const re = /[\\/]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const head = text.slice(0, m.index);
    const rest = text.slice(m.index + m[0].length);
    // `rest` '' = a trailing separator after the archive's name: its top
    if (head.length > 0 && isBrowsableArchive(nameOf(head))) return archiveLocation(head, rest);
  }
  return null;
};

/** What a new window is opened on (its URL's `?open=`, read back by `parseLocation`): the
 * archive's top carries a trailing separator, or it would read back as the file itself. */
export const archiveWindowTarget = (loc: ArchiveLocation): string => {
  const text = archiveText(loc);
  if (loc.inner) return text;
  const sep = text.includes('\\') ? '\\' : text.includes('/') ? '/' : pathSep();
  return text + sep;
};

/** A row inside an archive: its `path` is `archive + "\0" + inner` (Rust `read_archive_dir`).
 * null for a real path. */
export const splitArchivePath = (path: string): { archive: string; inner: string } | null => {
  const at = path.indexOf('\u0000');
  return at < 0 ? null : { archive: path.slice(0, at), inner: path.slice(at + 1) };
};

/** True for a row path that exists only inside an archive: never hand it to a real-path API. */
export const isArchivePath = (path: string): boolean => path.includes('\u0000');

/** The ` › ` the address bar draws between crumbs, for a Location line inside an archive. */
const CRUMB_SEP = ' › ';

/**
 * Where an archive row sits, as the address bar's crumbs say it: `a.zip › docs › sub` for
 * `…a.zip\0docs/sub/x.txt`, `a.zip` for a top-level row. null for a real path, whose Location is
 * its parent folder. ⛔ `parentOf` on a row cut at the last separator, so a top-level row read
 * as the folder HOLDING the zip.
 */
export const archiveRowWhere = (path: string): string | null => {
  const at = splitArchivePath(path);
  if (!at) return null;
  const folders = at.inner.split('/').filter(Boolean).slice(0, -1);
  return [nameOf(at.archive), ...folders].join(CRUMB_SEP);
};

/** The archive location that lists a row (its inner folder), for Reveal. null for a real path. */
export const archiveRowFolder = (path: string): ArchiveLocation | null => {
  const at = splitArchivePath(path);
  if (!at) return null;
  return archiveLocation(at.archive, at.inner.split('/').filter(Boolean).slice(0, -1).join('/'));
};

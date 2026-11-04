// The second line of a grid/list tile that is a search hit: which folder it lives in. A normal
// folder listing has no such line (every tile is in the same folder). Pure, so the wording is
// tested once and the tiles stay markup.
import { parentOf, nameOf, samePath, toLinuxForm } from './path';
import { tildeHome } from './path-display';

/** Longest relative path shown whole; deeper ones keep the first and last folder around `…`. */
const MAX_SEGMENTS = 3;

const SEGMENT = /[\\/]+/;

export interface HitFolder {
  /** short and readable: relative to the search root where there is one */
  text: string;
  /** the full parent path, for the tooltip */
  title: string;
}

const squeeze = (segments: string[]): string =>
  segments.length > MAX_SEGMENTS
    ? [segments[0], '…', ...segments.slice(-1)].join('/')
    : segments.join('/');

/**
 * Where a search hit lives. `root` is the folder the search started in (null when it started
 * from a place, e.g. This PC, where a root-relative path means nothing: the parent shows whole).
 * Returns null when the list is not a search, so a plain folder gets no second line. `home`
 * (the user's home folder) shortens a whole parent to `~/…` in `text`; `title` stays full.
 */
export const hitFolder = (
  path: string,
  isSearch: boolean,
  root: string | null,
  home: string | null = null,
): HitFolder | null => {
  if (!isSearch) return null;
  const parent = parentOf(path);
  if (parent === null) return null;
  const title = toLinuxForm(parent) ?? parent;
  if (root !== null && root !== '') {
    if (samePath(parent, root)) return { text: nameOf(root) || title, title };
    const stripped = parent.replace(/[\\/]+$/, '');
    const rootStripped = root.replace(/[\\/]+$/, '');
    if (
      stripped.length > rootStripped.length &&
      samePath(stripped.slice(0, rootStripped.length), rootStripped) &&
      /[\\/]/.test(stripped[rootStripped.length])
    ) {
      const rel = stripped.slice(rootStripped.length).split(SEGMENT).filter(Boolean);
      return { text: squeeze(rel), title };
    }
  }
  return { text: tildeHome(title, home), title };
};

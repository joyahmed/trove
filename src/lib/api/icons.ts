// URLs for the shell icons served by the `icon` custom protocol registered in lib.rs. On
// Windows Tauri maps the `icon://` scheme to this origin; nothing outside this file knows.
// Pure URL building, no `invoke` — the webview's <img> does the fetch.
import { protocolOrigin } from '$lib/utils/platform';

export const ICON_ORIGIN = protocolOrigin('icon');

/** The key kinds whose argument is free text and has to be percent-encoded: a path, an app id. */
const ENCODED_PREFIXES = ['file/', 'app/'];

/**
 * `ext/txt` → `http://icon.localhost/ext/txt?size=16`; `file/C:\a.exe` → the path URL-encoded;
 * `app/Microsoft.WindowsCalculator_8wekyb3d8bbwe!App` → the app id URL-encoded (an AUMID
 * carries `!`, and a shell one carries a backslash and braces); `folder` → `''` (folders
 * draw the SVG, not a shell icon).
 */
export const iconUrl = (iconKey: string, size: 16 | 32): string => {
  if (iconKey === 'folder') return '';
  const prefix = ENCODED_PREFIXES.find((p) => iconKey.startsWith(p));
  if (prefix) {
    return `${ICON_ORIGIN}/${prefix}${encodeURIComponent(iconKey.slice(prefix.length))}?size=${size}`;
  }
  return `${ICON_ORIGIN}/${iconKey}?size=${size}`;
};

/** The big sizes the grid and Gallery use (Explorer's Medium / Large / Extra large). */
export type BigIconSize = 48 | 96 | 256;

/**
 * The file's own thumbnail when the shell has one (images, video containers, audio album art,
 * Office, PDF where a reader registers a provider), else its icon — `GetImage` falls back on
 * its own, so asking for a thumbnail is never an error and needs no allow-list. Which entries
 * ask at all: `$lib/utils/tile-icon`, which asks for every file and excludes only folders and
 * the one extension measured to be too slow to ask about.
 *
 * `stamp` (optional, `$lib/utils/thumb-stamp`) rides as `&v=`: the server ignores it, but it is
 * part of the URL, so a file whose size or mtime changed is a new request, not a cached failure.
 */
export const thumbUrl = (path: string, size: BigIconSize, stamp?: string): string =>
  `${ICON_ORIGIN}/thumb/${encodeURIComponent(path)}?size=${size}${
    stamp ? `&v=${encodeURIComponent(stamp)}` : ''
  }`;

/** The item's icon at a big size — folders included, `desktop.ini` honoured — never a thumbnail. */
export const bigIconUrl = (path: string, size: BigIconSize): string =>
  `${ICON_ORIGIN}/big/${encodeURIComponent(path)}?size=${size}`;

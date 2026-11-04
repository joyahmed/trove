// How a path is SHOWN where space is short: the user's home folder as `~`, the way the address
// bar's first crumb already prints it (`crumbsOfLocation`, plan 12 D7). Display only: Copy path,
// drag data, tooltips, the address bar's edit field and every real navigation keep the full path.
import { HOME_MARK } from './location';
import { isRootPath, isWslPath } from './path';
import { onWindows } from './platform';

type Platform = Parameters<typeof onWindows>[0];

/**
 * `path` with a leading `home` written as `~`: `/Users/alex/x` → `~/x`, `C:\Users\alex\x` →
 * `~\x` (the path's own separator is kept), the home itself → `~`. Anything else comes back as
 * given: a look-alike sibling (`/Users/alexa`), a WSL path (`\\wsl$\…`, `Ubuntu:/…`, `/mnt/…`),
 * no home known yet, or a root home (HOME=/ or C:\ would put `~` on every path of the drive).
 * Windows compares case-insensitively and takes `\` and `/` as one separator; elsewhere exactly.
 */
export const tildeHome = (path: string, home: string | null, platform?: Platform): string => {
  if (!home || !path || isRootPath(home, platform) || isWslPath(path)) return path;
  const win = onWindows(platform);
  const base = home.replace(win ? /[\\/]+$/ : /\/+$/, '');
  if (base === '' || path.length < base.length) return path;
  const norm = (s: string) => (win ? s.replaceAll('/', '\\').toLowerCase() : s);
  if (norm(path.slice(0, base.length)) !== norm(base)) return path;
  const rest = path.slice(base.length);
  if (rest === '') return HOME_MARK;
  const isSep = win ? /^[\\/]/ : /^\//;
  if (!isSep.test(rest)) return path;
  // `/Users/alex/` (a trailing separator only) is the home itself
  return rest.replace(win ? /^[\\/]+$/ : /^\/+$/, '') === '' ? HOME_MARK : HOME_MARK + rest;
};

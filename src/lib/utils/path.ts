// Path helpers, one answer per OS. On Windows paths from Rust use backslashes; we keep them as-is
// for display and only normalise where we compute. A WSL distro is reached over
// `\\wsl.localhost\<distro>` and is shown and typed as `<distro>:/…`, with Linux segments in the
// crumbs. Off Windows (macOS, Linux) a path is POSIX: `/` separates, `/` is the one root, and case
// is kept — plan 10, D.1/D.2. Each OS-dependent helper takes the platform `onWindows` takes;
// nothing injected (tests, a plain browser) means Windows, like every switch in platform.ts.
import { onWindows } from '$lib/utils/platform';

type Platform = Parameters<typeof onWindows>[0];

const SEP = '\\';
const TRAILING_SEPS = /[\\/]+$/;
const ANY_SEP = /[\\/]/;
const DRIVE = /^[A-Za-z]:$/;
/** `\\wsl.localhost\<distro>` or the older `\\wsl$\<distro>`, either slash direction */
const WSL = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]+([^\\/]+)/i;
/** `<distro>:/<linux path>` — two or more name chars, so `C:/…` stays a drive */
const LINUX_FORM = /^([A-Za-z0-9._-]{2,}):\/(.*)$/;
const WSL_HOST = `${SEP}${SEP}wsl.localhost${SEP}`;
const POSIX_SEP = '/';
const POSIX_TRAILING = /\/+$/;

/** What joins a folder to its children: `\` on Windows, `/` everywhere else. */
export const pathSep = (platform?: Platform): string => (onWindows(platform) ? SEP : POSIX_SEP);

export const isWslPath = (path: string) => WSL.test(path);

/** `\\wsl.localhost\Ubuntu\home\alex` → `Ubuntu`; null for a Windows path */
export const wslDistroOf = (path: string): string | null => WSL.exec(path)?.[1] ?? null;

/** `\\wsl.localhost\Ubuntu\home\alex` → `\\wsl.localhost\Ubuntu\`; null for a Windows path */
export const wslRootOf = (path: string): string | null => {
  const distro = wslDistroOf(path);
  return distro === null ? null : wslRootFor(distro);
};

/** The share root of a distro by name: `Ubuntu` → `\\wsl.localhost\Ubuntu\` */
export const wslRootFor = (distro: string): string => `${WSL_HOST}${distro}${SEP}`;

/** The segments below the distro root: `\\wsl.localhost\Ubuntu\home\alex` → ['home', 'alex'] */
const wslSegments = (path: string): string[] =>
  path.replace(WSL, '').replace(TRAILING_SEPS, '').split(ANY_SEP).filter(Boolean);

const wslJoin = (distro: string, segments: string[]) =>
  segments.length === 0
    ? `${WSL_HOST}${distro}${SEP}`
    : `${WSL_HOST}${distro}${SEP}${segments.join(SEP)}`;

/** `/a/b` → `/a`; `/a` → `/`; `/` has no parent → null */
const posixParentOf = (path: string): string | null => {
  const trimmed = path.replace(POSIX_TRAILING, '');
  const i = trimmed.lastIndexOf(POSIX_SEP);
  if (i < 0) return null;
  return trimmed.slice(0, i).replace(POSIX_TRAILING, '') || POSIX_SEP;
};

/**
 * `C:\a\b` → `C:\a`; `C:\a` → `C:\`; a drive root or a distro root has no parent → null.
 * Off Windows: `/a/b` → `/a`, `/a` → `/`, `/` → null.
 */
export const parentOf = (path: string, platform?: Platform): string | null => {
  const distro = wslDistroOf(path);
  if (distro !== null) {
    const segments = wslSegments(path);
    return segments.length === 0 ? null : wslJoin(distro, segments.slice(0, -1));
  }
  if (!onWindows(platform)) return posixParentOf(path);
  const trimmed = path.replace(TRAILING_SEPS, '');
  if (DRIVE.test(trimmed)) return null;
  const i = trimmed.lastIndexOf(SEP);
  if (i < 0) return null;
  const head = trimmed.slice(0, i);
  return DRIVE.test(head) ? head + SEP : head;
};

/**
 * The last segment, `parentOf`'s other half: `C:\a\b.txt` → `b.txt`, a WSL path's last Linux
 * segment, `''` for a root. Off Windows only `/` separates: `/tmp/a\b.txt` → `a\b.txt`, since
 * `\` is a legal name character there (splitting on it named that file `b.txt`).
 */
export const nameOf = (path: string, platform?: Platform): string => {
  if (isWslPath(path)) return wslSegments(path).at(-1) ?? '';
  if (!onWindows(platform)) return path.replace(POSIX_TRAILING, '').split(POSIX_SEP).at(-1) ?? '';
  const trimmed = path.replace(TRAILING_SEPS, '');
  return DRIVE.test(trimmed) ? '' : (trimmed.split(ANY_SEP).at(-1) ?? '');
};

/**
 * `C:\a\b` → [{label:'C:', path:'C:\'}, {label:'a', path:'C:\a'}, {label:'b', path:'C:\a\b'}];
 * a WSL path starts at the distro: `Ubuntu` › `home` › `alex`, never a `wsl.localhost` crumb.
 * Off Windows `/a/b` → `/` › `a` › `b`, the root crumb labelled `/` as `C:` labels a drive.
 */
export const crumbsOf = (path: string, platform?: Platform): { label: string; path: string }[] => {
  const distro = wslDistroOf(path);
  if (distro !== null) {
    const segments = wslSegments(path);
    return [
      { label: distro, path: wslJoin(distro, []) },
      ...segments.map((label, i) => ({ label, path: wslJoin(distro, segments.slice(0, i + 1)) })),
    ];
  }
  if (!onWindows(platform)) {
    const parts = path.split(POSIX_SEP).filter(Boolean);
    const rooted = path.startsWith(POSIX_SEP);
    const segments = parts.map((label, i) => {
      const joined = parts.slice(0, i + 1).join(POSIX_SEP);
      return { label, path: rooted ? POSIX_SEP + joined : joined };
    });
    return rooted ? [{ label: POSIX_SEP, path: POSIX_SEP }, ...segments] : segments;
  }
  const parts = path.replace(TRAILING_SEPS, '').split(ANY_SEP).filter(Boolean);
  return parts.map((label, i) => {
    const joined = parts.slice(0, i + 1).join(SEP);
    return { label, path: i === 0 ? joined + SEP : joined };
  });
};

/** A Windows drive root by its shape: `C:`, `C:\` or `C:/`. `/` is a root (`isRootPath`), no drive. */
export const isDriveRoot = (path: string) => /^[A-Za-z]:[\\/]?$/.test(path);

/**
 * The key a per-folder setting is filed under — one string per folder, whatever spelling of it
 * arrived. `''` (a place: Home, This PC) keys to `''`, which owns no folder state.
 *
 * Three things are folded out:
 *  - **Slash direction.** Rust hands back `\`, the address bar accepts `/`; one folder either way.
 *  - **A trailing separator.** `E:\Tainment\` is `E:\Tainment`. A drive root keeps its separator,
 *    because there the separator is all there is (`c:\`, never the bare `c:`).
 *  - **Case — for a Windows path only.** ⚠️ NTFS holds `C:\Users\alex` and `c:\users\alex` as one
 *    folder, so they must key as one. A WSL path is deliberately left cased: a Linux filesystem
 *    really does hold `/home/alex` and `/home/alex` as two folders, and folding them together would
 *    make one folder's remembered view apply to the other.
 *
 * Off Windows only the trailing `/` is folded: `/` is the sole separator (`\` is a legal name
 * character there) and case is kept. ⚠️ macOS is kept cased too, though APFS usually folds: the
 * frontend cannot know the volume, and keying two spellings apart costs a duplicate at worst,
 * where folding two real folders together would lose one.
 */
export const folderKey = (path: string, platform?: Platform): string => {
  if (!onWindows(platform)) {
    const trimmed = path.trim();
    if (trimmed === '') return '';
    return trimmed.replace(POSIX_TRAILING, '') || POSIX_SEP;
  }
  const slashed = path.trim().replace(/\//g, SEP);
  if (slashed === '') return '';
  const cased = isWslPath(slashed) ? slashed : slashed.toLowerCase();
  const trimmed = cased.replace(TRAILING_SEPS, '');
  if (trimmed === '') return SEP;
  return DRIVE.test(trimmed) ? trimmed + SEP : trimmed;
};

/**
 * A drive root, a distro root or `/`: what has no parent and is titled by its own name. `/` is
 * answered on every OS — a remembered `/` from a Linux box is a root wherever it is read.
 */
export const isRootPath = (path: string) =>
  isDriveRoot(path) || path === POSIX_SEP || (isWslPath(path) && wslSegments(path).length === 0);

/**
 * The key two spellings of one path compare equal under: lower-cased on Windows (NTFS, drive
 * letters and the WSL share all fold case), as-is everywhere else (case-sensitive; macOS kept
 * cased for the reason `folderKey` gives). Unlike `folderKey`, nothing else is folded.
 */
export const pathKey = (path: string, platform?: Platform): string =>
  onWindows(platform) ? path.toLowerCase() : path;

/** Whether two paths name the same file or folder, by `pathKey`. */
export const samePath = (a: string, b: string, platform?: Platform): boolean =>
  pathKey(a, platform) === pathKey(b, platform);

/** `\\wsl.localhost\Ubuntu\home\alex` → `Ubuntu:/home/alex`; the root → `Ubuntu:/`; else null */
export const toLinuxForm = (path: string): string | null => {
  const distro = wslDistroOf(path);
  return distro === null ? null : `${distro}:/${wslSegments(path).join('/')}`;
};

/** `Ubuntu:/home/alex` → `\\wsl.localhost\Ubuntu\home\alex`; `Ubuntu:/` → the root; else null */
export const fromLinuxForm = (text: string): string | null => {
  const m = LINUX_FORM.exec(text.trim());
  if (!m) return null;
  return wslJoin(m[1], m[2].split('/').filter(Boolean));
};

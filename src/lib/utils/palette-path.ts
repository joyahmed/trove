// Path mode for the palette: when the text looks like a path, which folder to list and which
// prefix to match its children against. `~` is the profile; `Ubuntu:/…` is the WSL form.
// On a Mac or Linux host (`posix`) a path is `/`-separated: `/home/` is a path, `~/x/` joins the
// profile with `/`, and a backslash is an ordinary name character. Windows keeps `\`.
import { fromLinuxForm } from '$lib/utils/path';
import { onWindows } from '$lib/utils/platform';

export interface PathCompletion {
  /** the folder whose children complete the text */
  parent: string;
  /** what the child's name must start with (lower-cased), '' for all */
  prefix: string;
}

const DRIVE = /^[A-Za-z]:[\\/]/;
const UNC = /^\\\\[^\\]/;
const HOME = /^~([\\/]|$)/;
const LINUX = /^([A-Za-z0-9._-]{2,}):\/(.*)$/;

/** Split at the last separator: `C:\Us` → (`C:\`, `us`); `C:\Users\` → (`C:\Users`, ``). */
const split = (path: string, posix = false): PathCompletion => {
  const i = posix ? path.lastIndexOf('/') : Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  const head = path.slice(0, i + 1);
  const prefix = path.slice(i + 1).toLowerCase();
  // a drive root keeps its separator (`C:\`); anything deeper drops it
  if (posix) return { parent: head === '/' ? '/' : head.replace(/\/+$/, ''), prefix };
  const parent = /^[A-Za-z]:[\\/]$/.test(head) ? head : head.replace(/[\\/]+$/, '');
  return { parent, prefix };
};

/** null when the text is not a path. `profile` resolves `~`; `posix` is a Mac or Linux host. */
export const pathCompletion = (
  text: string,
  profile: string | null,
  posix: boolean = !onWindows(),
): PathCompletion | null => {
  const t = text.trim();
  if (!t) return null;
  if (HOME.test(t)) {
    if (!profile) return null;
    if (posix) return split(profile.replace(/\/+$/, '') + '/' + t.slice(2), true);
    return split(profile.replace(/[\\/]+$/, '') + '\\' + t.slice(2));
  }
  if (posix && t.startsWith('/')) return split(t, true);
  if (DRIVE.test(t) || UNC.test(t)) return split(t);
  const linux = LINUX.exec(t);
  if (linux) {
    const rest = linux[2];
    const i = rest.lastIndexOf('/');
    const parent = fromLinuxForm(`${linux[1]}:/${rest.slice(0, i + 1)}`);
    return parent ? { parent, prefix: rest.slice(i + 1).toLowerCase() } : null;
  }
  return null;
};

// Network places by text: which share a path is on, whether a listing error means "nobody
// answered". Pure and OS-free — the textual mirror of src-tauri/src/core/mounts.rs `share_root`
// and of the `LATE_MARK` error core/workers.rs gives a listing that outlived its deadline.

/** The words Rust's `read_dir` puts in the error of a place that did not answer in time. */
export const LATE_MARK = 'did not answer in';

/** `\\server\share\a\b` → server, share and the segments below. WSL hosts are shares textually. */
export interface ShareParts {
  server: string;
  share: string;
  /** the segments below the share; empty for the share root itself */
  rest: string[];
}

const UNC_PREFIX = /^[\\/]{2}\?[\\/]UNC[\\/]/i;
const LEAD = /^[\\/]{2}/;
const ANY_SEP = /[\\/]+/;
const DEVICE = /^[.?]$/;

/**
 * Split a UNC path. null for anything else: a drive path, a bare `\\server`, `\\.\pipe\x`,
 * `\\?\C:\x`. Either slash direction, and the long `\\?\UNC\` spelling.
 */
export const shareParts = (path: string): ShareParts | null => {
  const body = UNC_PREFIX.test(path)
    ? path.replace(UNC_PREFIX, '')
    : LEAD.test(path)
      ? path.replace(LEAD, '')
      : null;
  if (body === null) return null;
  const [server, share, ...rest] = body.split(ANY_SEP).filter(Boolean);
  if (!server || DEVICE.test(server) || !share) return null;
  return { server, share, rest };
};

/** `\\server\share` for a path on a share (no trailing separator, case kept), else null. */
export const shareRootOf = (path: string): string | null => {
  const p = shareParts(path);
  return p ? `\\\\${p.server}\\${p.share}` : null;
};

/** Whether a UNC host is WSL's own, which is local and never gets a deadline. */
export const isWslHost = (host: string): boolean => /^(wsl\.localhost|wsl\$)$/i.test(host);

/** The server of a share path, or null off a share. */
export const serverOf = (path: string): string | null => shareParts(path)?.server ?? null;

/** A path that lives on another machine and so can stall: a share that is not WSL. */
export const isRemoteShare = (path: string): boolean => {
  const p = shareParts(path);
  return p !== null && !isWslHost(p.server);
};

/** The OS error of a listing a user name and password could fix: access denied (5) or a logon
 * failure (1326), as Rust's io::Error words it (`… (os error 5)`). null for anything else. */
export const signInCodeOf = (err: string): 5 | 1326 | null => {
  const m = /\(os error (5|1326)\)/.exec(String(err));
  return m ? (Number(m[1]) as 5 | 1326) : null;
};

/** Whether a listing error is the "did not answer in <n> s" one. */
export const isUnreachableError = (err: string): boolean => String(err).includes(LATE_MARK);

/** `\\nas\media did not answer in 10 s` → `\\nas\media`; `Z:\ did not answer in 10 s` → `Z:\`. */
export const unreachablePlaceOf = (err: string): string | null => {
  const text = String(err);
  const i = text.indexOf(LATE_MARK);
  if (i < 0) return null;
  const place = text.slice(0, i).trim();
  return place === '' ? null : place;
};

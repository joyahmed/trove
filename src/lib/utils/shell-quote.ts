// Selected paths → the text typed into a terminal prompt (plan 08, E3). Pure: which shell a
// pane runs and how that shell quotes is decided here, nothing is written anywhere.
import { onWindows } from '$lib/utils/platform';
import { toLinuxForm, wslDistroOf } from '$lib/utils/path';

/** The quoting families: POSIX sh/bash/zsh/fish, PowerShell, cmd. */
export type ShellKind = 'posix' | 'powershell' | 'cmd';

/** A shell session as the pane runs it: the host's own shell, or a WSL distro's POSIX shell. */
export type PaneShell = { kind: ShellKind; wslDistro: string | null };

/** `it's` → `'it'\''s'`: single quotes hold everything (`$`, spaces, `"`) literally. */
export const quotePosix = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** `it's` → `'it''s'` */
export const quotePowerShell = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** `a b` → `"a b"`; a path cannot hold `"` on Windows, so no escape is needed. */
export const quoteCmd = (s: string): string => `"${s}"`;

const quoters: Record<ShellKind, (s: string) => string> = {
  posix: quotePosix,
  powershell: quotePowerShell,
  cmd: quoteCmd,
};

/**
 * The shell a pane started at `folder` runs — the same rule as `shell_for` in
 * src-tauri/src/core/pty.rs: on Windows a WSL share starts that distro's shell and anything
 * else PowerShell; elsewhere the user's POSIX shell.
 */
export const paneShellFor = (folder: string, windows: boolean = onWindows()): PaneShell => {
  if (!windows) return { kind: 'posix', wslDistro: null };
  const distro = wslDistroOf(folder);
  return distro === null
    ? { kind: 'powershell', wslDistro: null }
    : { kind: 'posix', wslDistro: distro };
};

/** `C:\Users\a` → `/mnt/c/Users/a`; null for anything that is not a drive path. */
const mntPath = (path: string): string | null => {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(path);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.replace(/\/$/, '') : null;
};

/** One path as the given shell can open it; null when this shell cannot reach it. */
export const pathForShell = (path: string, shell: PaneShell): string | null => {
  if (shell.wslDistro === null) return path;
  const linux = toLinuxForm(path);
  if (linux !== null) {
    const i = linux.indexOf(':');
    // another distro's folder is not reachable from this one
    if (linux.slice(0, i).toLowerCase() !== shell.wslDistro.toLowerCase()) return null;
    return linux.slice(i + 1) || '/';
  }
  return mntPath(path);
};

/**
 * `paths` quoted for the shell and joined by single spaces, with no newline (the person reads the
 * line and presses Enter). `skipped` counts the paths this shell cannot reach.
 */
export const pastePathsText = (
  paths: readonly string[],
  shell: PaneShell,
): { text: string; skipped: number } => {
  const quote = quoters[shell.kind];
  const usable = paths.map((p) => pathForShell(p, shell)).filter((p): p is string => p !== null);
  return { text: usable.map(quote).join(' '), skipped: paths.length - usable.length };
};

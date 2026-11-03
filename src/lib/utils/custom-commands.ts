// A user command's argument line → the argument list for one target. Pure: the placeholders
// come from the selection, the quoting rules are the shell's, nothing here runs anything.
import { onWindows } from '$lib/utils/platform';
import { parentOf, toLinuxForm, wslDistroOf } from '$lib/utils/path';

export interface CommandContext {
  /** the item the menu was opened on (the folder itself for the background) */
  path: string;
  /** every selected path, the target first */
  paths: string[];
}

/** What each placeholder stands for, shown in the customize dialog's legend. */
export const PLACEHOLDERS: { token: string; means: string }[] = [
  { token: '%path%', means: 'the item (Windows form), quoted' },
  { token: '%paths%', means: 'every selected item, quoted, space-separated' },
  { token: '%parent%', means: 'the folder that holds the item' },
  { token: '%name%', means: 'the item\u2019s name' },
  { token: '%linuxpath%', means: '/home/… inside the distro (a WSL path), else the path with /' },
  { token: '%distro%', means: 'the WSL distro name, or empty' },
];

/** Tokens that only mean something with WSL; they still expand off Windows, just aren't advertised. */
const WSL_ONLY_TOKENS = ['%linuxpath%', '%distro%'];

/** The legend for one platform: off Windows there is no "Windows form" and no WSL-only tokens. */
export const placeholdersFor = (
  windows: boolean = onWindows(),
): { token: string; means: string }[] =>
  windows
    ? PLACEHOLDERS
    : PLACEHOLDERS.filter((p) => !WSL_ONLY_TOKENS.includes(p.token)).map((p) =>
        p.token === '%path%' ? { ...p, means: 'the item, quoted' } : p,
      );

/** Example text for the Label field. */
export const labelPlaceholder = (windows: boolean = onWindows()): string =>
  windows ? 'Open with Code (WSL)' : 'Open with Code';

/** Example text for the Arguments field. */
export const argsPlaceholder = (windows: boolean = onWindows()): string =>
  windows ? '--remote wsl+%distro% %linuxpath%' : '--new-window %path%';

/**
 * One argument as `splitArgs` reads it back. Plain text goes bare; anything with a space, a
 * double quote, or a leading single quote is wrapped in double quotes. On Windows the backslashes
 * before a `"` (and before the closing one) are doubled, as CommandLineToArgvW wants, so a path
 * ending in `\` (`C:\Program Files\`) does not swallow its own closing quote.
 */
const quote = (s: string, windows: boolean = onWindows()) => {
  if (!/[\s"]/.test(s) && !s.startsWith("'")) return s;
  const body = windows
    ? s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')
    : s.replace(/"/g, '\\"');
  return `"${body}"`;
};

/** `\\wsl.localhost\Ubuntu\home\alex` → `/home/alex`; a Windows path → `C:/Users/alex`. */
export const linuxPathOf = (path: string): string => {
  const linux = toLinuxForm(path);
  if (linux !== null) return linux.slice(linux.indexOf(':') + 1) || '/';
  return path.replace(/\\/g, '/');
};

const nameOf = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? path;

/** Replace the placeholders in `args`, then split it like a shell (see `splitArgs`). */
export const expandArgs = (
  args: string,
  ctx: CommandContext,
  windows: boolean = onWindows(),
): string[] => {
  const distro = wslDistroOf(ctx.path) ?? '';
  const q = (s: string) => quote(s, windows);
  const table: Record<string, string> = {
    '%path%': q(ctx.path),
    '%paths%': ctx.paths.map(q).join(' '),
    '%parent%': q(parentOf(ctx.path) ?? ctx.path),
    '%name%': q(nameOf(ctx.path)),
    '%linuxpath%': q(linuxPathOf(ctx.path)),
    '%distro%': distro,
  };
  const expanded = args.replace(
    /%(path|paths|parent|name|linuxpath|distro)%/g,
    (m) => table[m] ?? m,
  );
  return splitArgs(expanded, windows);
};

/** The index of the `'` that closes the group opened at `start`, or -1: it must end the argument. */
const singleQuoteEnd = (line: string, start: number): number => {
  for (let j = start + 1; j < line.length; j++)
    if (line[j] === "'" && (j + 1 === line.length || /\s/.test(line[j + 1]))) return j;
  return -1;
};

/**
 * `a "b c" d` → [a, b c, d]. The rules, the same on every OS unless noted:
 * - double quotes group; `\"` is a literal quote. On Windows the backslash rule is
 *   CommandLineToArgvW's: 2n backslashes before a `"` give n and the quote groups, 2n+1 give n
 *   and a literal quote, backslashes anywhere else stay as typed (so `C:\dir\x` is safe).
 *   Elsewhere only `\"` is special.
 * - single quotes group too, on Windows as well (CommandLineToArgvW has none, so this is
 *   Trove's own rule there): `'a b'` is one argument. A `'` opens a group only at the start of
 *   an argument and closes at a `'` that ends it, so `it's` stays `it's`; with no closing `'`
 *   the quote is just a character. Inside a single-quoted group nothing else is special.
 * - `""` and `''` are an empty argument; an empty or blank line is no arguments.
 */
export const splitArgs = (line: string, windows: boolean = onWindows()): string[] => {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  let hadToken = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inQuotes && !hadToken) {
      const end = singleQuoteEnd(line, i);
      if (end > i) {
        cur = line.slice(i + 1, end);
        hadToken = true;
        i = end;
        continue;
      }
    }
    if (c === '\\' && windows) {
      let n = 0;
      while (line[i + n] === '\\') n++;
      if (line[i + n] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else inQuotes = !inQuotes;
        i += n;
      } else {
        cur += '\\'.repeat(n);
        i += n - 1;
      }
      hadToken = true;
    } else if (c === '\\' && line[i + 1] === '"') {
      cur += '"';
      hadToken = true;
      i++;
    } else if (c === '"') {
      inQuotes = !inQuotes;
      hadToken = true;
    } else if (/\s/.test(c) && !inQuotes) {
      if (hadToken) {
        out.push(cur);
        cur = '';
        hadToken = false;
      }
    } else {
      cur += c;
      hadToken = true;
    }
  }
  if (hadToken) out.push(cur);
  return out;
};

/**
 * The command Explorer users of WSL miss most; seeded once on a first run.
 *
 * ⛔ `program: 'code'` is a bare name on purpose, and it is **not** something CreateProcess can
 * start by itself. Rust runs a command through `std::process::Command::new`, i.e. CreateProcess,
 * which appends only `.exe` to a bare name — and VS Code ships no `code.exe` anywhere. Its `bin`
 * folder holds `code` (a POSIX shell script, for WSL and Git Bash) and `code.cmd`, so
 * `Command::new("code")` fails with "The system cannot find the file specified" and the toast in
 * `shell-verbs.svelte.ts` is all you ever see. This was the shipped default for every release
 * that had it: a command that had never once run.
 *
 * ⭐ The fix lives in Rust, not here: `known_apps::resolve_program` turns a bare name into the
 * real executable — `App Paths` first, then `PATH` with the extensions cmd.exe would have tried,
 * the same ladder the detected catalogue walks. `code` comes out as
 * `…\Microsoft VS Code\Code.exe`, which takes the very `--remote`/folder arguments the `.cmd`
 * wrapper forwards. Keeping the bare name here means the seed keeps working when the install
 * moves — and it repairs the entries already sitting in everyone's settings.json, which changing
 * this constant could not.
 */
export const DEFAULT_CUSTOM_COMMANDS = [
  {
    id: 'code-wsl',
    label: 'Open with Code (WSL)',
    program: 'code',
    args: '--remote wsl+%distro% %linuxpath%',
    scope: ['wsl' as const],
  },
];

export const newCommandId = () =>
  `cmd-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

type SeedCommand = (typeof DEFAULT_CUSTOM_COMMANDS)[number];

/** A command that can only ever fire on a WSL path, which exists on Windows alone. */
export const isWslOnly = (c: { scope: readonly string[] }): boolean =>
  c.scope.length > 0 && c.scope.every((s) => s === 'wsl');

/**
 * The commands a first run gets on this OS: never a WSL-scoped one off Windows (no distro to
 * open, and the program name may not exist there either).
 */
export const seedCommandsFor = (windows: boolean = onWindows()): SeedCommand[] =>
  DEFAULT_CUSTOM_COMMANDS.filter((c) => windows || !isWslOnly(c)).map((c) => ({
    ...c,
    scope: [...c.scope],
  }));

/**
 * The commands to show on this OS. A WSL-only command is kept in settings (a file synced from
 * Windows must not lose it) but hidden off Windows; `hidden` counts them for the small note.
 */
export const splitByPlatform = <T extends { scope: readonly string[] }>(
  commands: readonly T[],
  windows: boolean = onWindows(),
): { visible: T[]; hidden: number } => {
  if (windows) return { visible: [...commands], hidden: 0 };
  const visible = commands.filter((c) => !isWslOnly(c));
  return { visible, hidden: commands.length - visible.length };
};

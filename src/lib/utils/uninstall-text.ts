// Every word the uninstall flow shows (plan 18, 2.2). Pure, so `uninstall-text.test.ts` can pin
// the rule: never say "removed", "uninstalled" or "still installed" unless the row left the list.
import type { Removable, UninstallOutcome, Uninstallable } from '$lib/types/uninstall';
import type { NoticeInput } from '$lib/state/notices.svelte';
import { binName, onMac } from '$lib/utils/platform';

/** "7-Zip 24.08 (x64) 24.08 by Igor Pavlov" — the registry row, not the tile's name. */
export const rowLabel = (row: Uninstallable): string => {
  const version = row.version && !row.name.includes(row.version) ? ` ${row.version}` : '';
  const by = row.publisher ? ` by ${row.publisher}` : '';
  return `${row.name}${version}${by}`;
};

/**
 * The confirm names the row AND the program that will run, so a wrong join or a rewritten
 * registry entry shows before anything runs.
 */
export const confirmText = (
  row: Uninstallable,
  linux = false,
  terminalLive = false,
): { title: string; message: string } =>
  onMac()
    ? {
        title: `Move ${row.name} to the ${binName()}?`,
        message: `${row.name} goes to the ${binName()}. To put it back, use Put Back in the ${binName()} in Finder.\nMoves: ${row.program}`,
      }
    : {
        title: `Uninstall ${row.name}?`,
        message: `${rowLabel(row)}. ${how(row, linux, terminalLive)}\nRuns: ${row.program}`,
      };

/** What the yes does, in the words of this OS. Ubuntu never says it removes anything itself. */
const how = (row: Uninstallable, linux: boolean, terminalLive: boolean): string => {
  if (!linux) return 'Its own uninstaller will open.';
  if (!row.typed) return `GNOME Software will open on ${row.name}.`;
  // ⛔ never typed into a live session (vim, a Y/n prompt): copied instead
  return terminalLive
    ? 'The terminal is in use, so the command is copied for you to paste and run.'
    : 'The command is typed in the terminal. Press Enter to run it.';
};

/**
 * Why the item is greyed. `'notYet'`: this OS has no uninstall yet (plan 18 Phases 3-4).
 * `'noMatch'`: no registry row belongs to the tile.
 */
export const reasonText = (
  r: Exclude<Removable, 'yes'> | 'notYet' | 'noMatch',
  linux = false,
): string =>
  ({
    system: onMac() ? 'Part of macOS' : linux ? 'Ubuntu needs this package' : 'Part of Windows',
    // Ubuntu: a snap or Flatpak tile can be this very Trove, and it looks like any other app
    trove: linux ? 'This is Trove — it cannot uninstall itself' : 'This is Trove',
    noUninstaller: 'No uninstaller Trove can run safely',
    link: 'This is a link, not the app',
    notApp: 'Not an app bundle',
    elsewhere: `Only apps in Applications can be moved to the ${binName()}`,
    noMatch: onMac() ? 'Not found in Applications' : 'No uninstaller found',
    notYet: 'Not on this system yet',
  })[r];

export const BUSY_TEXT = 'Another uninstall is still open';

/** The toast after the uninstaller ended. Only `gone` claims anything happened. */
export const outcomeNotice = (row: Uninstallable, outcome: UninstallOutcome): NoticeInput => {
  if (outcome === 'gone')
    return {
      kind: 'success',
      message: onMac()
        ? `${row.name} was moved to the ${binName()}`
        : `${row.name} was uninstalled`,
    };
  // decision: no "delete it for good instead?" - plan 18 forbids a permanent-delete fallback
  if (outcome === 'noTrash')
    return {
      kind: 'warning',
      message: `macOS did not let Trove use the ${binName()}, so ${row.name} was not moved. Drag it to the ${binName()} in Finder.`,
    };
  if (outcome === 'typedInTerminal')
    return {
      kind: 'info',
      message: `The command for ${row.name} is in the terminal. Nothing is removed until you press Enter.`,
    };
  if (outcome === 'stillListed')
    return { kind: 'info', message: `${row.name} is still in the list` };
  return {
    kind: 'info',
    message: `No answer yet from the uninstaller of ${row.name}. Trove checks again when you come back.`,
  };
};

/** Typed hand-off with a live terminal session: nothing was written, the line is on the clipboard. */
export const copiedNotice = (row: Uninstallable, copied: boolean): NoticeInput => ({
  kind: 'info',
  message: `The terminal is in use, so nothing was typed. The command for ${row.name}${copied ? ' is copied' : ''}: ${row.program}`,
});

/** After the row leaves the list on a later focus or F5. */
export const goneLaterNotice = (row: Uninstallable): NoticeInput => ({
  kind: 'success',
  message: onMac() ? `${row.name} was moved to the ${binName()}` : `${row.name} was uninstalled`,
});

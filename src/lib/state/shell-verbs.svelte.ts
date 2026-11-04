// Windows' registered context-menu verbs, read once from the registry through Rust, and the
// person's own commands from settings — both offered on the row and background menus.
import {
  runCustomCommand,
  runShellVerb,
  shellMenu,
  shellMenuInvoke,
  shellVerbs as fetchVerbs,
} from '$lib/api/shell-verbs';
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import { SHELL_DEADLINE_MS, lateRow, shellRows, withDeadline } from '$lib/data/shell-menu';
import { actions } from '$lib/state/actions.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { CommandScope, CustomCommand, ShellVerb, VerbScope } from '$lib/types/shell-verbs';
import { expandArgs, splitByPlatform, type CommandContext } from '$lib/utils/custom-commands';
import { isDriveRoot, isWslPath, parentOf } from '$lib/utils/path';
import { logError, logInfo } from '$lib/api/log';

class ShellVerbsState {
  verbs = $state.raw<ShellVerb[]>([]);
  loaded = $state(false);

  async load() {
    if (this.loaded) return;
    await this.refresh(false);
  }

  /** Re-read the hives (an installer ran); `refresh` is what the customize dialog's button does. */
  async refresh(again = true) {
    try {
      this.verbs = await fetchVerbs(again);
    } catch (e) {
      logError('shellVerbs.fetchVerbs', e);
      this.verbs = [];
    }
    this.loaded = true;
  }

  /** The registered verbs for one target. */
  forScope = (scope: VerbScope): ShellVerb[] => this.verbs.filter((v) => v.scope === scope);

  /**
   * The person's commands for one target.
   *
   * ⚠️ `wsl` is a **filter**, not a fourth location kind. A command whose scope includes it is
   * offered only when the target is inside a distro. It used to be OR-ed in beside the location
   * kinds — `c.scope.includes(scope) || (c.scope.includes('wsl') && isWslPath(path))` — so the
   * scope the dialog produces when someone ticks WSL *on top of* file/folder/background,
   * `['file','folder','wsl','background']`, matched on `folder` alone and the command appeared
   * on every ordinary Windows folder. "Open with Zed WSL" on `D:\proj` is the symptom.
   *
   * ⛔ `['wsl']` on its own still has to work: the shipped Code-over-WSL entry is scoped exactly
   * that way and means "any WSL target". So `wsl` with no location kind beside it passes every
   * kind; `wsl` with kinds narrows to those kinds, inside a distro only. A command without
   * `wsl` is untouched: `['folder']` shows on any folder, Windows or WSL.
   */
  commandsFor = (scope: CommandScope, path: string): CustomCommand[] => {
    const matched = splitByPlatform(settings.customCommands).visible.filter((c) => {
      const wslOnly = c.scope.includes('wsl');
      if (wslOnly && !isWslPath(path)) return false;
      const kinds = c.scope.filter((s): s is CommandScope => s !== 'wsl');
      return kinds.length === 0 ? wslOnly : kinds.includes(scope);
    });
    if (!isWslPath(path)) return matched;
    // ⚠️ On a distro path a plain command gives way to a `wsl` command that runs the SAME
    // program. "Open with Zed" hands Zed the Windows UNC path, Zed rewrites it to its verbatim
    // `UNC` form and opens an empty FILE with that name; "Open with Zed (WSL)" passes
    // `--wsl <distro> <linux path>` and opens the folder. Offering both side by side is how
    // the wrong one got clicked. A program with no `wsl` twin keeps its plain command (VLC
    // on a file in a distro), so nothing is lost.
    const program = (c: CustomCommand) => c.program.trim().toLowerCase();
    const wslPrograms = new Set(matched.filter((c) => c.scope.includes('wsl')).map(program));
    return matched.filter((c) => c.scope.includes('wsl') || !wslPrograms.has(program(c)));
  };

  /**
   * Windows' own items for the slot in `trove` (plan 08 D.1): the shell's menu for `paths`
   * (or the empty space of the folder `paths[0]`), minus what `trove` already shows. Past
   * `SHELL_DEADLINE_MS` the answer is dropped and the slot says so in one greyed row; a shell
   * that refuses (a virtual folder, an unreadable path) leaves nothing behind.
   */
  menuRows = async (
    target: { paths: string[]; background: boolean; dir: string },
    extended: boolean,
    trove: MenuItem[],
  ): Promise<MenuItem[]> => {
    const started = performance.now();
    const got = await withDeadline(
      shellMenu(target.paths, target.background, extended),
      SHELL_DEADLINE_MS,
    );
    if (got.kind === 'late') {
      logInfo(`shellMenu: no answer in ${SHELL_DEADLINE_MS} ms; Windows items dropped`);
      return [lateRow()];
    }
    if (got.kind === 'error') {
      logError('shellVerbs.menuRows', got.error);
      return [];
    }
    const { token, items } = got.value;
    logInfo(`shellMenu: ${items.length} rows in ${Math.round(performance.now() - started)} ms`);
    return shellRows(items, trove, (id) => this.invokeMenu(token, id, target.dir));
  };

  invokeMenu = async (token: number, id: number, dir: string) => {
    try {
      await shellMenuInvoke(token, id, dir);
    } catch (e) {
      actions.notify(String(e), 'error');
    }
  };

  run = async (verb: ShellVerb, path: string) => {
    try {
      await runShellVerb(verb.key, verb.scope, path);
    } catch (e) {
      actions.notify(String(e), 'error');
    }
  };

  runCommand = async (command: CustomCommand, ctx: CommandContext) => {
    const cwd = isDriveRoot(ctx.path) ? ctx.path : (parentOf(ctx.path) ?? ctx.path);
    try {
      await runCustomCommand(command.program, expandArgs(command.args, ctx), cwd);
    } catch (e) {
      // ⛔ a command that would not start used to leave only a log line (Ubuntu C.6.4): say which
      // command, and why, on screen
      logError('shellVerbs.runCommand', e);
      actions.notify(`${command.label} did not start: ${String(e)}`, 'error');
    }
  };
}

export const shellVerbs = new ShellVerbsState();

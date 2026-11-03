// The customize dialog's reactivity: the list or the edit form, Enter saves / Escape backs out,
// and a "Refresh Windows entries" that re-reads the registry verbs.
import { untrack } from 'svelte';
import { customize } from '$lib/state/customize.svelte';
import { settings } from '$lib/state/settings.svelte';
import { shellVerbs } from '$lib/state/shell-verbs.svelte';
import type { AppEntry } from '$lib/types/palette';
import type { CommandScope, DetectedApp } from '$lib/types/shell-verbs';
import { appIcon, appTileSrc } from '$lib/utils/app-icon';
import { BLOCKED_REASON, appWhere, matchApps } from '$lib/utils/app-pick';
import {
  argsPlaceholder,
  labelPlaceholder,
  placeholdersFor,
  splitByPlatform,
} from '$lib/utils/custom-commands';
import { ownsEnter } from '$lib/utils/focus-trap';
import { onWindows } from '$lib/utils/platform';
import { useFocusReturn } from './use-focus-return.svelte';

export const scopeOptions: { key: CommandScope; label: string }[] = [
  { key: 'file', label: 'Files' },
  { key: 'folder', label: 'Folders' },
  { key: 'background', label: 'Folder background' },
  { key: 'wsl', label: 'WSL paths' },
];

/**
 * The "Show on" boxes for one draft. WSL paths exist only on Windows, so elsewhere the box is
 * hidden — unless the command already carries that scope (saved on another machine, synced):
 * then it stays, checked and `readOnly`, so the data is shown and kept, never silently dropped.
 */
export const scopeOptionsFor = (
  scope: readonly CommandScope[],
  windows: boolean = onWindows(),
): { key: CommandScope; label: string; readOnly: boolean }[] =>
  scopeOptions
    .filter((o) => windows || o.key !== 'wsl' || scope.includes('wsl'))
    .map((o) => ({ ...o, readOnly: !windows && o.key === 'wsl' }));

/** What the Program box shows under it: nothing yet, "cannot find", or the line Save would run. */
export type ProgramCheck =
  { kind: 'missing'; message: string } | { kind: 'found'; commandLine: string };

/** One row of the Program box's app list, as the form draws it. */
export interface AppMatch {
  app: AppEntry;
  /** where it lives (exe, bundle, `.desktop`), or "Microsoft Store app" */
  where: string;
  /** the reason it cannot be picked, or null when it can */
  blocked: string | null;
  /** the icon's image URL; '' when it has none */
  icon: string;
}

/** The id the Program box's `aria-controls` points at. */
export const APP_LIST_ID = 'customize-program-apps';

export const useCustomizeDialog = () => {
  const { trap, isTop } = useFocusReturn();

  // look the program up as it is typed (debounced in state); Save waits for the answer
  $effect(() => {
    const draft = customize.draft;
    if (!draft) return;
    const program = draft.program;
    untrack(() => customize.queueResolve(program));
  });
  let refreshing = $state(false);

  const refresh = async () => {
    refreshing = true;
    await shellVerbs.refresh();
    refreshing = false;
  };

  // the highlighted row of the app list, valid only for the program text it was moved under
  let active = $state(-1);
  let activeFor = $state('');

  const appMatches = (): AppMatch[] => {
    const draft = customize.draft;
    if (!draft || customize.apps === null) return [];
    if (customize.pickedProgram === draft.program) return [];
    return matchApps(customize.apps, draft.program).map((app) => {
      const key = appIcon(app).iconKey;
      return {
        app,
        where: appWhere(app),
        blocked: app.openWith ? null : BLOCKED_REASON,
        icon: key ? appTileSrc(key).src : '',
      };
    });
  };
  const activeIndex = () => (activeFor === (customize.draft?.program ?? '') ? active : -1);

  const pickApp = (app: AppEntry) => {
    if (customize.pickApp(app)) active = -1;
  };

  /**
   * Keys on the Program box while its app list is showing: arrows move the highlight, Enter on a
   * highlighted row picks it (on a greyed row it does nothing — and does not save either), Escape
   * shuts the list. Anything else, and every key while no list shows, falls through to `onkeydown`.
   */
  const programKeydown = (e: KeyboardEvent) => {
    const matches = appMatches();
    if (matches.length === 0) return;
    const program = customize.draft?.program ?? '';
    const at = activeIndex();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active =
        at < 0
          ? step > 0
            ? 0
            : matches.length - 1
          : (at + step + matches.length) % matches.length;
      activeFor = program;
    } else if (e.key === 'Enter' && at >= 0) {
      const row = matches[at];
      if (row && !row.blocked) pickApp(row.app);
    } else if (e.key === 'Escape') {
      customize.pickedProgram = program;
      active = -1;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onkeydown = (e: KeyboardEvent) => {
    // a Confirm stacked on top owns the keys: its Enter must not also save this draft
    if (!isTop()) return;
    if (e.key === 'Escape') {
      if (customize.draft) customize.cancelEdit();
      else customize.close();
    } else if (e.key === 'Enter' && customize.draft && !ownsEnter(e.target)) {
      // Enter in a text field saves; on a focused button (Cancel, the header's) that button acts
      customize.save();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return {
    get commands() {
      return splitByPlatform(settings.customCommands).visible;
    },
    /** WSL-only commands kept in settings but not listed off Windows */
    get hiddenCount() {
      return splitByPlatform(settings.customCommands).hidden;
    },
    get draft() {
      return customize.draft;
    },
    get draftValid() {
      return customize.draftValid;
    },
    /** the answer for the program as typed; `null` while it is empty or still being looked up */
    get programCheck(): ProgramCheck | null {
      const name = customize.draft?.program.trim() ?? '';
      if (name === '' || customize.resolvedFor !== name) return null;
      if (customize.resolved === null) {
        const cannotFind = onWindows() ? 'Windows cannot find' : "Can't find";
        return { kind: 'missing', message: `${cannotFind} \`${name}\`` };
      }
      if (typeof customize.resolved === 'string') {
        return { kind: 'found', commandLine: customize.commandLine };
      }
      return null;
    },
    get verbCount() {
      return shellVerbs.verbs.length;
    },
    get refreshing() {
      return refreshing;
    },
    /** the installed apps matching the Program box, greyed ones carrying their reason */
    get appMatches() {
      return appMatches();
    },
    /** the highlighted row of `appMatches`, -1 for none */
    get activeMatch() {
      return activeIndex();
    },
    appListId: APP_LIST_ID,
    pickApp,
    programKeydown,
    get suggestions() {
      return customize.suggestions;
    },
    get detecting() {
      return customize.detecting;
    },
    addDetected: (found: DetectedApp) => customize.addDetected(found),
    placeholders: placeholdersFor(),
    labelPlaceholder: labelPlaceholder(),
    argsPlaceholder: argsPlaceholder(),
    get scopeOptions() {
      return scopeOptionsFor(customize.draft?.scope ?? []);
    },
    hasScope: (scope: CommandScope) => customize.draft?.scope.includes(scope) === true,
    toggleScope: (scope: CommandScope) => customize.toggleScope(scope),
    add: () => customize.add(),
    edit: customize.edit.bind(customize),
    remove: (id: string) => void customize.remove(id),
    save: () => customize.save(),
    cancelEdit: () => customize.cancelEdit(),
    close: () => customize.close(),
    refresh,
    onkeydown,
    /** on the panel: takes focus into the dialog as it opens, keeps Tab inside (utils/focus-trap) */
    trap,
  };
};

// The Customize form's app picker: which installed apps match what is typed in the Program box,
// and what picking one puts in the draft. The list is the one Spotlight and the Applications
// place read (`spotlight_apps`); whether an app can take a file is Rust's call, made per OS when
// the list is built (`AppEntry.openWith`), and this only follows it:
//   Windows — a plain `.exe` shortcut with no arguments: `{ <exe>, %paths% }`
//   Mac     — `{ open, -a "<bundle>" %paths% }`
//   Ubuntu  — the `.desktop` `Exec`, mapped by `apps_linux::exec_to_open_with`; `Terminal=true` → none
// A Store app, or anything else with `openWith: null`, is listed greyed with the reason, never picked.
import type { AppEntry } from '$lib/types/palette';

/** Why a listed app cannot be picked. */
export const BLOCKED_REASON = "This app can't open files from a command";

/**
 * The apps whose name contains `text` (any case): names that START with it first, then the
 * rest, each group in list order. Empty text matches nothing — the list is for narrowing, not
 * for browsing every app on the machine under an empty box.
 */
export const matchApps = (apps: readonly AppEntry[], text: string, limit = 8): AppEntry[] => {
  const q = text.trim().toLowerCase();
  if (q === '') return [];
  const prefix: AppEntry[] = [];
  const inside: AppEntry[] = [];
  for (const app of apps) {
    const name = app.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(app);
    else if (name.includes(q)) inside.push(app);
  }
  return [...prefix, ...inside].slice(0, limit);
};

/** What picking `app` writes into the draft, or why it cannot be picked. */
export const toDraft = (app: AppEntry): { program: string; args: string } | { blocked: string } =>
  app.openWith
    ? { program: app.openWith.program, args: app.openWith.args }
    : { blocked: BLOCKED_REASON };

/** The second line of a row: where the app lives, or what it is when it lives nowhere on disk. */
export const appWhere = (app: AppEntry): string =>
  app.path || app.target || app.lnkPath || 'Microsoft Store app';

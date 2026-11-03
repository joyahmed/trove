// The right-click menus, as data: one for a row, one for the list background. Explorer's items
// in Explorer's order; state is read live through closures.
import { iconUrl, thumbUrl } from '$lib/api/icons'; // a pure URL formatter, not an IPC call
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import {
  compressToFlyout,
  groupByFlyout,
  moreFlyout,
  newFlyout,
  showHiddenItem,
  sortByFlyout,
  viewFlyout,
} from '$lib/data/menus';
import { DRAWN_FILE_ICONS, keyedIcon } from '$lib/utils/file-icon';
import { onMac, onWindows } from '$lib/utils/platform';
import { splitArchivePath } from '$lib/utils/archive-location';
import { comingFrom } from '$lib/state/coming-from.svelte';
import { openWith } from '$lib/state/open-with.svelte';
import type { OpenWithApp } from '$lib/types/open-with';
import { knownKeyOf } from '$lib/data/sidebar-sections';
import { actions } from '$lib/state/actions.svelte';
import { listing } from '$lib/state/listing.svelte';
import { panes } from '$lib/state/panes.svelte';
import { selection } from '$lib/state/selection.svelte';
import { settings } from '$lib/state/settings.svelte';
import { shellVerbs } from '$lib/state/shell-verbs.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { propertiesLabel } from '$lib/utils/platform';
import { isArchivePath } from '$lib/utils/archive-location';
import type { FileEntry } from '$lib/types/fs';
import type { CommandScope, VerbScope } from '$lib/types/shell-verbs';
import { isDriveRoot } from '$lib/utils/path';
import { opensAsFolder } from '$lib/utils/app-bundle';
import { commandHint, keyLabel } from '$lib/utils/key-label';

/** The row that was right-clicked (the hook focuses it before opening). */
const focusedEntry = () => listing.rows.find((e) => e.path === selection.focused);
/** A folder you can go into — not a Mac's `X.app`, which has no new tab, window or pin. */
const focusedIsDir = () => {
  const e = focusedEntry();
  // a folder inside an archive has no real path for the sidebar to pin (its path holds a NUL)
  return e !== undefined && opensAsFolder(e) && !isArchivePath(e.path);
};
const focusedPinned = () => {
  const e = focusedEntry();
  return e !== undefined && settings.pins.includes(e.path);
};
const pinFocused = () => {
  const e = focusedEntry();
  if (e) settings.togglePin(e.path, knownKeyOf(e.path));
};

/** Paste into the current folder — the same item in both menus. */
const pasteItem: MenuItem = {
  kind: 'item',
  key: 'paste',
  label: 'Paste',
  glyph: 'paste',
  shortcut: keyLabel('Ctrl+V'),
  enabled: () => actions.inFolder,
  run: actions.paste,
};

/** The selected files (or the focused one), what "Open with" hands to the chosen app. */
const openWithPaths = (): string[] => {
  const paths = listing.rows.filter((e) => selection.has(e.path)).map((e) => e.path);
  const focused = focusedEntry();
  return paths.length ? paths : focused ? [focused.path] : [];
};

/** "Open with" is for plain files of one kind: not folders, bundles, archive members or a mix. */
export const openWithApplies = (): boolean => {
  const focused = focusedEntry();
  if (!focused || focused.isDir || opensAsFolder(focused) || splitArchivePath(focused.path)) {
    return false;
  }
  const chosen = listing.rows.filter((e) => selection.has(e.path));
  if (chosen.length === 0) return true;
  if (chosen.some((e) => e.isDir || opensAsFolder(e) || splitArchivePath(e.path))) return false;
  const kind = (e: FileEntry) => (e.ext ?? '').toLowerCase();
  return chosen.every((e) => kind(e) === kind(chosen[0]));
};

/**
 * The 16px icon of an app on the flyout; `undefined` leaves the reserved slot blank. Off Windows
 * it is the picture the Applications place draws for the same app (`keyedIcon`): a Mac `.app`
 * is its bundle's thumb, an Ubuntu `.desktop` its theme icon. ⚠️ The Mac answer is `thumb`, not
 * `shell`; taking only `shell` left every Mac row blank (plan 10 B.5).
 */
const appIcon = (
  app: OpenWithApp,
  windows: boolean,
  drawn: boolean,
  mac: boolean,
): string | undefined => {
  if (windows) return shellIcon(verbIconPath(app.icon));
  const icon = keyedIcon(`file/${app.id}`, 16, undefined, drawn, mac);
  if (icon.kind === 'thumb') return thumbUrl(icon.path, 48);
  return icon.kind === 'shell' ? icon.src : undefined;
};

/**
 * The rows of the "Open with" flyout, a pure function of what Rust answered: the default app
 * first and marked, then the rest, then (Windows only) Windows' own chooser. Nothing to show yet
 * is a greyed row, so the flyout is never an empty box.
 */
export const openWithItems = (
  apps: OpenWithApp[],
  loading: boolean,
  path: string,
  paths: string[],
  windows: boolean = onWindows(),
  drawn: boolean = DRAWN_FILE_ICONS,
  mac: boolean = onMac(),
): MenuItem[] => {
  const rows: MenuItem[] = [];
  const ordered = [...apps.filter((a) => a.isDefault), ...apps.filter((a) => !a.isDefault)];
  for (const app of ordered) {
    rows.push({
      kind: 'item',
      key: `open-with:${app.id}`,
      label: app.isDefault ? `${app.name} (default)` : app.name,
      iconSrc: appIcon(app, windows, drawn, mac),
      run: () => openWith.open(app.id, paths),
    });
  }
  if (rows.length === 0) {
    rows.push({
      kind: 'item',
      key: 'open-with-empty',
      label: loading ? 'Loading…' : 'No apps found',
      enabled: () => false,
      run: () => {},
    });
  }
  if (windows) {
    rows.push(
      { kind: 'divider', key: 'open-with-d' },
      {
        kind: 'item',
        key: 'open-with-choose',
        label: 'Choose another app…',
        run: () => openWith.choose(path),
      },
    );
  }
  return rows;
};

export const rowMenu: MenuItem[] = [
  {
    kind: 'item',
    key: 'open',
    label: 'Open',
    get shortcut() {
      return commandHint('open');
    },
    run: actions.openSelected,
  },
  {
    kind: 'submenu',
    key: 'open-with',
    get label() {
      return comingFrom.style === 'mac' ? 'Open With' : 'Open with';
    },
    visible: () => openWithApplies(),
    get items() {
      return openWithItems(openWith.apps, openWith.loading, openWith.path, openWithPaths());
    },
  },
  {
    kind: 'item',
    key: 'open-new-tab',
    label: 'Open in new tab',
    visible: focusedIsDir,
    run: () => {
      const e = focusedEntry();
      if (e) actions.openInNewTab(e);
    },
  },
  {
    kind: 'item',
    key: 'open-new-window',
    label: 'Open in new window',
    shortcut: keyLabel('Shift+Enter'),
    visible: focusedIsDir,
    run: () => {
      const e = focusedEntry();
      if (e) actions.openInNewWindow(e);
    },
  },
  {
    kind: 'item',
    key: 'open-terminal',
    label: 'Open in Terminal',
    glyph: 'terminal',
    // one folder only, not a file and not a selection of several; Explorer's item on a folder
    visible: () => focusedIsDir() && selection.count <= 1,
    run: () => {
      const e = focusedEntry();
      if (e) void actions.openTerminalAt(e.path);
    },
  },
  { kind: 'divider', key: 'd1' },
  {
    kind: 'item',
    key: 'cut',
    label: 'Cut',
    glyph: 'cut',
    shortcut: keyLabel('Ctrl+X'),
    enabled: () => actions.hasSelection,
    run: actions.cut,
  },
  {
    kind: 'item',
    key: 'copy',
    label: 'Copy',
    glyph: 'copy',
    shortcut: keyLabel('Ctrl+C'),
    // inside an archive too: the copy holds the entries and a paste in a folder extracts them
    enabled: () => actions.canCopy,
    run: actions.copy,
  },
  {
    kind: 'item',
    key: 'copy-path',
    label: 'Copy as path',
    shortcut: keyLabel('Ctrl+Shift+C'),
    enabled: () => actions.hasSelection,
    run: actions.copyAsPath,
  },
  compressToFlyout,
  {
    kind: 'item',
    key: 'extract-here',
    label: 'Extract here',
    enabled: () => actions.canExtractHere,
    run: actions.extractHere,
  },
  pasteItem,
  {
    kind: 'item',
    key: 'rename',
    label: 'Rename',
    glyph: 'rename',
    get shortcut() {
      return commandHint('rename');
    },
    enabled: () => actions.hasOneSelected,
    run: () => actions.startRename(),
  },
  {
    kind: 'item',
    key: 'delete',
    label: 'Delete',
    glyph: 'delete',
    get shortcut() {
      return commandHint('delete');
    },
    enabled: () => actions.hasSelection,
    run: actions.deleteSelected,
  },
  {
    kind: 'item',
    key: 'delete-permanently',
    label: 'Delete permanently',
    get shortcut() {
      return commandHint('deletePermanently');
    },
    enabled: () => actions.hasSelection,
    run: actions.deletePermanently,
  },
  { kind: 'divider', key: 'd2', visible: focusedIsDir },
  {
    kind: 'item',
    key: 'pin',
    label: 'Pin to sidebar',
    glyph: 'pinTo',
    visible: () => focusedIsDir() && !focusedPinned(),
    run: pinFocused,
  },
  {
    kind: 'item',
    key: 'unpin',
    label: 'Unpin from sidebar',
    glyph: 'unpin',
    visible: () => focusedIsDir() && focusedPinned(),
    run: pinFocused,
  },
  { kind: 'divider', key: 'd3' },
  {
    kind: 'item',
    key: 'properties',
    get label() {
      return propertiesLabel();
    },
    get shortcut() {
      return commandHint('properties');
    },
    run: () => panes.toggle('details'),
  },
];

const herePinned = () => settings.pins.includes(tabs.active.path);

export const backgroundMenu: MenuItem[] = [
  // Explorer's "New ▸", with every kind the + New button makes (Folder first, Ctrl+Shift+N)
  newFlyout,
  pasteItem,
  {
    kind: 'item',
    key: 'refresh',
    label: 'Refresh',
    glyph: 'refresh',
    get shortcut() {
      return commandHint('refresh');
    },
    run: () => tabs.active.refresh(),
  },
  { kind: 'divider', key: 'd1' },
  viewFlyout,
  showHiddenItem,
  { kind: 'divider', key: 'd-arrange' },
  // ⭐ Explorer's own answer to a right-click on empty space, and the reason it is here: the
  // toolbar's Sort dropdown was the ONLY door to sorting and grouping, and nobody looks in a
  // toolbar for what the right-click has offered since Windows 95. A built, working "Group by
  // date modified" went unfound for weeks because this gesture answered with nothing. Both are
  // flyouts, not a flat block of nine rows, so the menu grows by two lines instead of nine —
  // and both are the very same items the toolbar shows, so the two doors cannot drift apart.
  sortByFlyout,
  groupByFlyout,
  { kind: 'divider', key: 'd2' },
  {
    kind: 'item',
    key: 'terminal',
    label: 'Open in Terminal',
    glyph: 'terminal',
    // an archive's inside has no real folder to open (`openTerminal` returns early there)
    enabled: () => actions.inFolder,
    run: actions.openTerminal,
  },
  {
    kind: 'item',
    key: 'select-all',
    label: 'Select all',
    shortcut: keyLabel('Ctrl+A'),
    run: () => selection.selectAll(listing.shown.map((e) => e.path)),
  },
  {
    kind: 'item',
    key: 'pin',
    label: 'Pin this folder to sidebar',
    glyph: 'pinTo',
    // an archive's inside has path '' — there is no real folder to pin
    visible: () => tabs.active.isFolder && !herePinned(),
    run: () => settings.togglePin(tabs.active.path, knownKeyOf(tabs.active.path)),
  },
  {
    kind: 'item',
    key: 'unpin',
    label: 'Unpin this folder from sidebar',
    glyph: 'unpin',
    visible: herePinned,
    run: () => settings.togglePin(tabs.active.path),
  },
  { kind: 'divider', key: 'd-more' },
  // the old command bar's View panes and "See more" list, whole, so nothing it held is lost (D4)
  moreFlyout,
];

/**
 * The file a registry `Icon` value points at, or `undefined` when we cannot serve it.
 *
 * The values look like `"C:\Program Files\app.exe",0`, `C:\app.exe,0`, or `C:\thing.ico`. The
 * shell protocol renders a *file's* icon, which is its index 0 — so an explicit non-zero index
 * (`shell32.dll,-16` and friends) is dropped rather than drawn as the wrong picture, and so is
 * anything with an unexpanded `%VAR%`, which only the Rust side could resolve. Dropping means a
 * blank in the reserved slot, never a shifted row.
 */
export const verbIconPath = (icon: string | null): string | undefined => {
  const raw = icon?.trim();
  if (!raw || raw.includes('%')) return undefined;
  let file = raw;
  const comma = raw.lastIndexOf(',');
  if (comma > 0) {
    const index = raw.slice(comma + 1).trim();
    if (/^-?\d+$/.test(index)) {
      if (Number(index) !== 0) return undefined;
      file = raw.slice(0, comma);
    }
  }
  file = file
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
  return /^([a-zA-Z]:\\|\\\\)/.test(file) ? file : undefined;
};

/** The 16px icon URL for a path the shell knows, or `undefined` — the slot stays reserved. */
const shellIcon = (file: string | undefined): string | undefined =>
  file === undefined ? undefined : iconUrl(`file/${file}`, 16);

/**
 * The tail every right-click menu ends with: Windows' registered verbs for the target ("Open
 * with Code", "Open Git Bash here" …) and the person's own commands, read live so an installer
 * or the customize dialog shows up on the next click. Empty when there is nothing to add.
 *
 * Both kinds carry their own icon where Windows gave us one, so the tail reads as part of the
 * same menu as the built-in items above it rather than a second, iconless list.
 *
 * Inside an archive every row is greyed, the same rule as "Open in Terminal": the target is a
 * member path (a NUL inside) or the archive tab's '' — nothing on the disk for a program to open.
 */
export const dynamicTail = (
  verbScope: VerbScope,
  commandScope: CommandScope,
  path: string,
  paths: string[],
): MenuItem[] => {
  const verbs = shellVerbs.forScope(verbScope);
  const commands = shellVerbs.commandsFor(commandScope, path);
  if (verbs.length === 0 && commands.length === 0) return [];
  const onDisk = path !== '' && !isArchivePath(path);
  const enabled = () => onDisk;
  return [
    { kind: 'divider', key: 'd-dynamic' },
    ...verbs.map((v): MenuItem => ({
      kind: 'item',
      key: `verb:${v.scope}:${v.key}`,
      label: v.label,
      iconSrc: shellIcon(verbIconPath(v.icon)),
      enabled,
      run: () => (onDisk ? shellVerbs.run(v, path) : undefined),
    })),
    ...commands.map((c): MenuItem => ({
      kind: 'item',
      key: `cmd:${c.id}`,
      label: c.label,
      iconSrc: shellIcon(verbIconPath(c.program)),
      enabled,
      run: () => (onDisk ? shellVerbs.runCommand(c, { path, paths }) : undefined),
    })),
  ];
};

/** What a right-click on `entry` offers: the row menu plus the verbs for that kind of item. */
export const rowMenuFor = (entry: FileEntry): MenuItem[] => {
  const paths = listing.rows.filter((e) => selection.has(e.path)).map((e) => e.path);
  const verbScope: VerbScope = !entry.isDir
    ? 'file'
    : isDriveRoot(entry.path)
      ? 'drive'
      : 'directory';
  // an archive member has no real path (a NUL inside) and its flyout is hidden: asking the OS
  // for its apps crashed Trove on macOS (MAC-C.8.7)
  if (!entry.isDir && !splitArchivePath(entry.path)) void openWith.load(entry.path);
  return [
    ...rowMenu,
    ...dynamicTail(
      verbScope,
      entry.isDir ? 'folder' : 'file',
      entry.path,
      paths.length ? paths : [entry.path],
    ),
  ];
};

/** A right-click on the empty space: the background menu plus the folder's own verbs. */
export const backgroundMenuFor = (): MenuItem[] => {
  const here = tabs.active.path;
  return [...backgroundMenu, ...dynamicTail('directory-background', 'background', here, [here])];
};

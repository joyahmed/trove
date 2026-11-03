// The Settings dialog as data: sections of rows, each row a toggle, a radio, a button or a
// stepper over `settings` (and `defaultHandler` for the one that touches the registry). The
// dialog renders one `{#each}` per section and one per row, by `kind` (CONTRIBUTING § 2).
import type { KnownFolderKey } from '$lib/types/shell';
import { hostStyle, toChoice, type ComingFrom, type OsStyle } from '$lib/state/coming-from.svelte';
import { confirm } from '$lib/state/confirm.svelte';
import { customize } from '$lib/state/customize.svelte';
import { defaultHandler } from '$lib/state/default-handler.svelte';
import { indexSettings } from '$lib/state/index-settings.svelte';
import type { SettingsSectionKey } from '$lib/state/settings-dialog.svelte';
import {
  sanitize,
  settings,
  ZOOM,
  type FolderSizesChoice,
  type SidebarKey,
  type ThemeChoice,
} from '$lib/state/settings.svelte';
import { shellVerbs } from '$lib/state/shell-verbs.svelte';
import { spotlight } from '$lib/state/spotlight-bridge.svelte';
import { chordWarning } from '$lib/utils/hotkeys';
import { locationLabel, THIS_PC } from '$lib/utils/location';
import { binName, onLinux, onMac, onWindows, storeBuild } from '$lib/utils/platform';
import { explorerViewOrder, isStep, stepLabel } from '$lib/utils/view-steps';

export interface RadioOption {
  key: string;
  label: string;
}

interface RowBase {
  key: string;
  label: string;
  description?: string;
  /** greyed out, with the reason as its title */
  disabled?: () => boolean;
  /** a line under the control (a warning, a count) read live */
  note?: () => string | null;
}

export type SettingRow =
  | (RowBase & { kind: 'toggle'; get: () => boolean; set: (on: boolean) => unknown })
  | (RowBase & {
      kind: 'radio';
      options: RadioOption[];
      get: () => string;
      set: (key: string) => unknown;
    })
  | (RowBase & { kind: 'button'; buttonLabel: string; danger?: boolean; run: () => unknown })
  /** no control: a feature this build cannot offer, with the reason as its description */
  | (RowBase & { kind: 'info' })
  | (RowBase & { kind: 'hotkey'; get: () => string; set: (chord: string) => unknown })
  | (RowBase & {
      kind: 'engine';
      /** the named engines; the row adds its own "Custom…" choice */
      options: RadioOption[];
      /** the saved URL template */
      get: () => string;
      /** saves a template; returns the reason it was refused, or null when kept */
      set: (template: string) => string | null;
    })
  | (RowBase & {
      kind: 'folders';
      /** the folders now in the list */
      get: () => string[];
      /** adds one; returns the reason it was refused, or null when kept */
      add: (path: string) => string | null;
      remove: (path: string) => unknown;
    })
  | (RowBase & {
      kind: 'stepper';
      /** the shown value, e.g. "120 %" */
      get: () => string;
      step: (dir: 1 | -1) => unknown;
      reset: () => unknown;
      canStep: (dir: 1 | -1) => boolean;
    });

export interface SettingsSection {
  key: SettingsSectionKey;
  label: string;
  /** rows read live: the hidden built-ins list changes as the person unpins */
  rows: () => SettingRow[];
}

/** The web search engines Spotlight offers by name; `%s` stands in for the encoded query. */
export const SEARCH_ENGINES: (RadioOption & { template: string })[] = [
  { key: 'google', label: 'Google', template: 'https://www.google.com/search?q=%s' },
  { key: 'bing', label: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  { key: 'duckduckgo', label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
];

/** Why a custom search template cannot be used, or null when it can. */
export const searchTemplateError = (raw: string): string | null => {
  const t = raw.trim();
  if (!/^https?:\/\//i.test(t)) return 'The address must start with http:// or https://';
  if (!t.includes('%s')) return 'The address must contain %s where the search words go';
  return null;
};

/** The Store build never writes the default-handler keys, so nothing can be forced by them. */
const forcedByDefault = () => !storeBuild() && settings.defaultHandler.applied;
/** The host owns where a background app lives (plan 19): menu bar on a Mac, tray elsewhere. */
const trayWords = () =>
  onMac() ? 'A menu bar icon' : onLinux() ? 'A system tray icon' : 'A tray icon';

const FORCED_NOTE = 'On while Trove is the default file manager';

/** The built-in Pinned folders the person has unpinned, as "Show" rows. */
const hiddenFolderRows = (): SettingRow[] =>
  settings.hiddenKnownFolders.map((key: KnownFolderKey) => ({
    kind: 'button' as const,
    key: `show-${key}`,
    label: key.charAt(0).toUpperCase() + key.slice(1),
    description: 'Unpinned from the sidebar',
    buttonLabel: 'Show',
    run: () => settings.toggleKnownFolder(key),
  }));

const sidebarKeyLabel = (key: SidebarKey): string =>
  ({
    home: 'Home',
    gallery: 'Gallery',
    applications: 'Applications',
    onedrive: 'OneDrive',
    'recycle-bin': binName(),
  })[key];

/** Home, Gallery, Applications, OneDrive or the Bin, unpinned, as "Show" rows. */
const hiddenSidebarRows = (): SettingRow[] =>
  settings.hiddenSidebarKeys.map((key) => ({
    kind: 'button' as const,
    key: `show-${key}`,
    label: sidebarKeyLabel(key),
    description: 'Unpinned from the sidebar',
    buttonLabel: 'Show',
    run: () => settings.toggleSidebarKey(key),
  }));

const hiddenCount = () => settings.hiddenKnownFolders.length + settings.hiddenSidebarKeys.length;

const viewStepKey = (i: number) => `view-${i}`;

const THEME_OPTIONS: { key: ThemeChoice; label: string }[] = [
  { key: 'system', label: 'System' },
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
];
const toThemeChoice = (key: string): ThemeChoice =>
  THEME_OPTIONS.find((o) => o.key === key)?.key ?? 'system';

const FOLDER_SIZES_OPTIONS: { key: FolderSizesChoice; label: string }[] = [
  { key: 'off', label: 'Off' },
  { key: 'local', label: 'Local drives' },
  { key: 'everywhere', label: 'Everywhere' },
];
const toFolderSizesChoice = (key: string): FolderSizesChoice =>
  FOLDER_SIZES_OPTIONS.find((o) => o.key === key)?.key ?? 'local';

/** "I'm coming from" choices (plan 19); the host's own is marked, on every OS. */
export const COMING_FROM_OPTIONS = (host: OsStyle = hostStyle()): RadioOption[] =>
  (
    [
      { key: 'windows', label: 'Windows' },
      { key: 'mac', label: 'Mac' },
      { key: 'linux', label: 'Linux' },
    ] as const
  ).map((o) => ({ key: o.key, label: o.key === host ? `${o.label} (this computer)` : o.label }));

/** A picked option as the stored choice: the host's own is stored as 'native' (so the setting
 * follows the box it syncs to), any other style as itself, junk as 'native'. */
export const toComingFrom = (key: string, host: OsStyle = hostStyle()): ComingFrom =>
  key === host ? 'native' : toChoice(key);

/** The zoom chords as the keyboard shows them: Ctrl on Windows and Linux, ⌘ on a Mac. */
const zoomChords = () => (onMac() ? '⌘+ / ⌘−' : 'Ctrl + / Ctrl −');

/**
 * Rows that only mean something on Windows: they write the registry (default file manager, the
 * `Run` entry, the shell verbs) or name Windows' own keys. Hidden — not greyed — elsewhere, like
 * the accent row; `rows()` is read live, so this follows the platform.
 */
const windowsOnly = (rows: SettingRow[]): SettingRow[] => (onWindows() ? rows : []);

/** What the Store build shows instead of the switch: its HKCU writes land in the package's
 * private hive, which Explorer never reads (plan 22.2.4). Hidden, said why — never a dead toggle. */
export const STORE_DEFAULT_HANDLER_NOTE = 'Not available in the Store version yet';

/**
 * The default file manager is built for Windows (registry) and Linux (`xdg-mime`); not Mac. In
 * the Store build the switch becomes one line saying why it is not there.
 */
const defaultHandlerRows = (rows: SettingRow[]): SettingRow[] => {
  if (!(onWindows() || onLinux())) return [];
  if (!storeBuild()) return rows;
  return rows.map(({ key, label }) => ({
    kind: 'info' as const,
    key,
    label,
    description: STORE_DEFAULT_HANDLER_NOTE,
  }));
};

/** Everything back to the defaults — the registry is not touched (that is the toggle's job). */
export const resetToDefaults = async () => {
  const ok = await confirm.ask({
    title: 'Reset settings',
    message: onWindows()
      ? 'Every setting goes back to its default: view, pins, panes, zoom, commands. Being the default file manager is left as it is.'
      : 'Every setting goes back to its default: view, pins, panes, zoom, commands.',
    okLabel: 'Reset',
    danger: true,
  });
  if (!ok) return false;
  const defaults = sanitize(null);
  settings.apply({ ...defaults, defaultHandler: { ...settings.defaultHandler } });
  return true;
};

/** What the index never goes into, whatever is chosen. Keep in step with `Skip::defaults` (core/index/walk.rs). */
export const indexBuiltInSkips = (mac = onMac(), linux = onLinux()): string[] => [
  'node_modules',
  '.git',
  '.pnpm-store',
  '.cargo\\registry',
  '.rustup',
  '__pycache__',
  '.next',
  '.turbo',
  '.gradle',
  'target (beside a Cargo.toml)',
  ...(mac
    ? [
        'Library/Caches',
        'Library/Developer',
        'Library/pnpm',
        'Library/Containers',
        'Library/Android',
        '.Trash',
      ]
    : linux
      ? // `linux_skips` (core/index/walk.rs)
        [
          '~/.cache',
          '~/.local/share/Trash',
          '/proc',
          '/sys',
          '/dev',
          '/run',
          '/media',
          'network shares and other mounts that are not a local disk',
        ]
      : ['$Recycle.Bin', 'System Volume Information']),
  'the temp folder',
];

/** Forget: ask, then delete the index's saved files. Returns whether it ran. */
export const forgetIndex = async (mac = onMac()) => {
  const ok = await confirm.ask({
    title: 'Forget the search index',
    message: `The saved list of file names is deleted from this ${mac ? 'Mac' : 'PC'}. Search still works; the index builds the list again the next time Trove starts.`,
    okLabel: 'Forget',
    danger: true,
  });
  if (!ok) return false;
  return (await indexSettings.forget()) !== null;
};

/** A drive row's words. Linux has one "drive", `/`: the disk outside the home folder, walked
 * again every 30 minutes instead of watched (plan 21C.9b). */
export const indexDriveText = (root: string, linux = onLinux()) =>
  linux && root === '/'
    ? {
        label: 'Outside the home folder (/)',
        description:
          'Walked again every 30 minutes; USB drives and network shares are never indexed',
      }
    : {
        label: `Drive ${root.replace(/[\\/]+$/, '')}`,
        description: 'Fixed local drives only; USB drives and network shares are never indexed',
      };

/** One on/off row per drive the host offers: Windows' fixed drives, Linux's `/`, none on a Mac. */
const indexDriveRows = (): SettingRow[] =>
  indexSettings.drives.map((root) => ({
    kind: 'toggle' as const,
    key: `index-drive-${root.charAt(0).toLowerCase()}`,
    ...indexDriveText(root),
    disabled: () => !settings.indexOn,
    get: () => settings.isIndexDriveOn(root),
    set: (on: boolean) => settings.setIndexDrive(root, on),
  }));

const indexRows = (): SettingRow[] => {
  indexSettings.ensureLoaded();
  return [
    {
      kind: 'toggle',
      key: 'index-on',
      label: 'Search index',
      description: 'Keeps a list of your file names so search answers in milliseconds',
      get: () => settings.indexOn,
      set: (on) => (settings.indexOn = on),
    },
    ...indexDriveRows(),
    {
      kind: 'folders',
      key: 'index-skip',
      label: 'Folders to skip',
      description: `Always skipped: ${indexBuiltInSkips().join(', ')}`,
      disabled: () => !settings.indexOn,
      get: () => settings.indexSkipFolders,
      add: (path) => settings.addIndexSkipFolder(path),
      remove: (path) => settings.removeIndexSkipFolder(path),
    },
    {
      kind: 'button',
      key: 'index-forget',
      label: 'Forget the index',
      description: `Deletes the saved list of file names from this ${onMac() ? 'Mac' : 'PC'}`,
      buttonLabel: 'Forget…',
      danger: true,
      disabled: () => !indexSettings.size,
      note: () => indexSettings.sizeLabel,
      run: () => forgetIndex(),
    },
  ];
};

export const settingsSections: SettingsSection[] = [
  {
    key: 'general',
    label: 'General',
    rows: () => [
      {
        kind: 'radio',
        key: 'start-place',
        label: 'Open Trove to',
        description: 'What a new tab and a launch without a folder show',
        options: [
          { key: 'home', label: 'Home' },
          { key: 'this-pc', label: locationLabel(THIS_PC) },
        ],
        get: () => settings.startPlace,
        set: (key) => (settings.startPlace = key === 'this-pc' ? 'this-pc' : 'home'),
      },
      {
        kind: 'radio',
        key: 'coming-from',
        label: "I'm coming from",
        // plan 19: Phase 1 changed the words, Phase 2 the shortcut set (the host's keys stay)
        description:
          'Changes only words (Trash or Recycle Bin, Get Info or Properties, This PC or This Mac) and which shortcuts work',
        options: COMING_FROM_OPTIONS(),
        // the stored choice resolved, so the radio is right even before the layout effect copies it
        get: () => (settings.comingFrom === 'native' ? hostStyle() : settings.comingFrom),
        set: (key) => (settings.comingFrom = toComingFrom(key)),
      },
      {
        kind: 'toggle',
        key: 'restore-tabs',
        label: 'Restore tabs on restart',
        description: "Reopen the last session's folders",
        get: () => settings.restoreTabs,
        set: (on) => (settings.restoreTabs = on),
      },
      {
        kind: 'toggle',
        key: 'archives-open-inside',
        label: 'Open archives inside Trove',
        description: 'Double-click a .zip, .7z or .tar to browse it like a folder',
        get: () => settings.archivesOpenInside,
        set: (on) => (settings.archivesOpenInside = on),
      },
      {
        kind: 'toggle',
        key: 'show-hidden',
        label: 'Show hidden items',
        description: onWindows()
          ? 'Files and folders with the hidden attribute, and dotfiles'
          : 'Files and folders whose name starts with a dot',
        get: () => settings.showHidden,
        set: (on) => (settings.showHidden = on),
      },
      {
        kind: 'toggle',
        key: 'folders-first',
        label: 'Always list folders first',
        description: onWindows()
          ? 'Off matches Explorer: folders sit above files by Name, and mix in with them by date or size'
          : 'Off: folders sit above files by Name, and mix in with them by date or size',
        get: () => settings.foldersFirst,
        set: (on) => (settings.foldersFirst = on),
      },
      {
        kind: 'radio',
        key: 'folder-sizes',
        label: 'Show folder sizes',
        description: `Counts each folder's contents for the Size column. Local drives leaves ${
          onWindows() ? 'network, USB and WSL' : 'network and USB'
        } folders blank`,
        options: FOLDER_SIZES_OPTIONS,
        get: () => settings.folderSizes,
        set: (key) => (settings.folderSizes = toFolderSizesChoice(key)),
      },
    ],
  },
  {
    key: 'behaviour',
    label: 'Behaviour',
    rows: () => [
      ...defaultHandlerRows([
        {
          kind: 'toggle',
          key: 'default-handler',
          label: 'Use as default file manager',
          description: onWindows()
            ? 'Win+E, folder double-clicks and "Show in folder" open Trove. Undo any time.'
            : 'Folder double-clicks and "Show in folder" open Trove. Undo any time.',
          get: () => defaultHandler.checked,
          set: () => defaultHandler.toggle(),
          disabled: () => defaultHandler.busy,
          note: () => defaultHandler.warning,
        },
      ]),
      // Both are forced on (and locked) while the app is the default file manager: Win+E must
      // answer at once, and a portable exe has no installer to register it at logon.
      {
        kind: 'toggle',
        key: 'keep-running',
        label: 'Keep running in the background',
        description: `${trayWords()}; closing the last window hides it`,
        get: () => settings.keepRunning || forcedByDefault(),
        set: (on) => (settings.keepRunning = on),
        disabled: forcedByDefault,
        note: () => (forcedByDefault() ? FORCED_NOTE : null),
      },
      {
        kind: 'toggle',
        key: 'start-with-windows',
        label: onWindows() ? 'Start with Windows' : 'Start at login',
        description: onMac()
          ? 'Starts hidden at login'
          : onLinux()
            ? 'Starts hidden in the system tray at login'
            : 'Starts hidden in the tray at logon',
        get: () => settings.startWithWindows || forcedByDefault(),
        set: (on) => (settings.startWithWindows = on),
        disabled: forcedByDefault,
        note: () => (forcedByDefault() ? FORCED_NOTE : null),
      },
      // ⛔ The note carries two different things: a registration error Rust reported, and a
      // warning about a chord that will register cleanly and then never fire. The second is the
      // one that matters — there is no error for it, so without the warning the palette just
      // silently stops working. See utils/hotkeys.ts.
      {
        kind: 'hotkey',
        key: 'spotlight-hotkey',
        label: 'Spotlight shortcut',
        description: 'Opens the search palette from anywhere',
        get: () => settings.spotlightHotkey,
        set: (chord) => {
          // ⛔ Saved only once the OS accepts it. A refused chord written to settings.json
          // would be retried at the next start while the working one is lost.
          void spotlight.register(chord).then((ok) => {
            if (ok) settings.spotlightHotkey = chord;
          });
        },
        note: () =>
          spotlight.hotkeyError ??
          spotlight.hotkeyConflict ??
          chordWarning(settings.spotlightHotkey),
      },
      {
        kind: 'engine',
        key: 'spotlight-search-engine',
        label: 'Web search engine',
        description: "Where Spotlight's web search row goes. Opens in your default browser.",
        options: SEARCH_ENGINES,
        get: () => settings.spotlightSearchTemplate,
        set: (template) => {
          const error = searchTemplateError(template);
          if (error) return error;
          settings.spotlightSearchTemplate = template.trim();
          return null;
        },
      },
    ],
  },
  {
    key: 'appearance',
    label: 'Appearance',
    rows: () => [
      {
        kind: 'radio',
        key: 'theme',
        label: 'Theme',
        description: 'System follows your light or dark setting as it changes',
        options: THEME_OPTIONS,
        get: () => settings.theme,
        set: (key) => (settings.theme = toThemeChoice(key)),
      },
      {
        kind: 'stepper',
        key: 'zoom',
        label: 'Text size',
        description: `The whole window, like a browser zoom (${zoomChords()})`,
        get: () => `${Math.round(settings.zoom * 100)} %`,
        step: (dir) => settings.zoomBy(dir),
        reset: () => (settings.zoom = 1),
        canStep: (dir) => (dir > 0 ? settings.zoom < ZOOM.max : settings.zoom > ZOOM.min),
      },
      // Hidden (not greyed) off Windows: a radio row cannot disable one option, and Windows is
      // the only OS that hands us an accent. `rows()` is read live, so this follows the platform.
      ...(onWindows()
        ? ([
            {
              kind: 'radio',
              key: 'accent-source',
              label: 'Accent colour',
              description: "Sapphire is Trove's own; Match system uses your Windows accent",
              options: [
                { key: 'sapphire', label: 'Sapphire' },
                { key: 'system', label: 'Match system' },
              ],
              get: () => settings.accentSource,
              set: (key) => (settings.accentSource = key === 'system' ? 'system' : 'sapphire'),
            },
          ] satisfies SettingRow[])
        : []),
      {
        kind: 'radio',
        key: 'default-view',
        label: 'View',
        description: 'How folders list their items',
        options: explorerViewOrder.map((s, i) => ({ key: viewStepKey(i), label: stepLabel(s) })),
        get: () => {
          const i = explorerViewOrder.findIndex((s) => isStep(s, settings));
          return viewStepKey(i < 0 ? explorerViewOrder.findIndex((s) => s.view === 'details') : i);
        },
        set: (key) => {
          const step = explorerViewOrder[Number(key.replace('view-', ''))];
          if (!step) return;
          settings.view = step.view;
          if (step.view === 'grid') settings.iconSize = step.iconSize;
        },
      },
    ],
  },
  {
    key: 'quick-access',
    label: 'Sidebar',
    rows: () => [
      {
        kind: 'button',
        key: 'restore-sidebar',
        label: 'Restore sidebar defaults',
        description: `Home, Gallery, the ${binName()} and the default folders, all listed again`,
        buttonLabel: 'Restore',
        disabled: () => hiddenCount() === 0,
        note: () => (hiddenCount() === 0 ? 'All shown' : `${hiddenCount()} hidden`),
        run: () => settings.restoreSidebarDefaults(),
      },
      ...hiddenSidebarRows(),
      ...hiddenFolderRows(),
    ],
  },
  {
    key: 'context-menu',
    label: 'Context menu',
    rows: () => [
      {
        kind: 'button',
        key: 'customize',
        label: 'Your commands',
        description: onWindows()
          ? 'Open with Code (WSL), Zed, anything with a program and arguments'
          : 'Open with Code, Zed, anything with a program and arguments',
        buttonLabel: 'Customize…',
        run: () => customize.show(),
      },
      ...windowsOnly([
        {
          kind: 'button',
          key: 'refresh-verbs',
          label: "Windows' entries",
          description: 'Read from the registry: what installers added to the menu',
          buttonLabel: 'Refresh',
          note: () => `${shellVerbs.verbs.length} entries`,
          run: () => shellVerbs.refresh(),
        },
      ]),
    ],
  },
  {
    key: 'search-index',
    label: 'Search index',
    rows: indexRows,
  },
  {
    key: 'advanced',
    label: 'Advanced',
    rows: () => [
      {
        kind: 'button',
        key: 'reset',
        label: 'Reset all settings',
        description: onWindows()
          ? 'Back to the defaults; being the default file manager is kept'
          : 'Back to the defaults',
        buttonLabel: 'Reset…',
        danger: true,
        run: resetToDefaults,
      },
    ],
  },
];

// What survives a restart: view mode, column widths, show-hidden, sidebar pins. Loaded once on
// mount, written (debounced) whenever a field changes. Unknown or malformed stored values fall
// back to the defaults field by field, so an old file never breaks a new build.
import { mergeSettings, readSettings, writeSettings } from '$lib/api/settings';
import {
  DEFAULT_COLUMNS,
  REQUIRED_COLUMN,
  allColumns,
  isGroupKey,
  isSortKey,
  type SortKey,
} from '$lib/data/file-columns';
import type { KnownFolderKey } from '$lib/types/shell';
import type { CommandScope, CustomCommand } from '$lib/types/shell-verbs';
import { seedCommandsFor } from '$lib/utils/custom-commands';
import { sanitizeFolderViews, type FolderView } from '$lib/utils/folder-views';
import { sanitizeTabSets, type TabSet } from '$lib/utils/tab-sets';
import { cleanColumnOrder, insertColumn } from '$lib/utils/column-order';
import { toChoice, type ComingFrom } from '$lib/state/coming-from.svelte';
import { defaultSpotlightHotkey } from '$lib/utils/hotkeys';
import { sanitizeOverrides, toStoredOverrides } from '$lib/utils/chord-overrides';

/**
 * How a folder is shown. Explorer's views (`utils/view-steps` orders them): `grid` is Medium /
 * Large / Extra large icons by `IconSize`, `small` is Small icons, Tiles and Content are their own
 * layouts. `gallery` (plan 15 G.52) is the Gallery's photo grid over the folder's own files; it is
 * a per-folder choice only — a place has no files to put in it, so the global default is always
 * one of the list views (`ListViewMode`).
 */
export type ViewMode = 'details' | 'list' | 'grid' | 'small' | 'tiles' | 'content' | 'gallery';
/** The views the file list itself draws, and the only ones the global default can be. */
export type ListViewMode = Exclude<ViewMode, 'gallery'>;
export const VIEW_MODES: readonly ListViewMode[] = [
  'details',
  'list',
  'grid',
  'small',
  'tiles',
  'content',
];
/** The grid's icon size: Explorer's Medium / Large / Extra large. */
export type IconSize = 48 | 96 | 256;

export type AccentSource = 'sapphire' | 'system';
/** Settings → Appearance → Theme: follow the OS, or always light, or always dark. */
export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_CHOICES: ThemeChoice[] = ['system', 'light', 'dark'];
const isThemeChoice = (v: unknown): v is ThemeChoice =>
  typeof v === 'string' && (THEME_CHOICES as string[]).includes(v);
/** Settings → Show folder sizes (plan 21 A): which folders the Size column counts. "Local
 *  drives" leaves network, removable and WSL folders blank, as before. */
export type FolderSizesChoice = 'off' | 'local' | 'everywhere';
export const FOLDER_SIZES_CHOICES: FolderSizesChoice[] = ['off', 'local', 'everywhere'];
const isFolderSizesChoice = (v: unknown): v is FolderSizesChoice =>
  typeof v === 'string' && (FOLDER_SIZES_CHOICES as string[]).includes(v);

export interface Settings {
  view: ListViewMode;
  /** px per column key; missing keys use the column's default */
  columnWidths: Partial<Record<SortKey, number>>;
  /** which details columns are shown, in `fileColumns` order; Name is always in */
  columns: SortKey[];
  /** the column a new tab sorts by, and which way — Explorer remembers these too */
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  /** the column a new tab groups by (Explorer's "Group by"); null is its "(None)" */
  groupKey: SortKey | null;
  /** keep folders above files on every column, not just Name (Explorer's own rule) */
  foldersFirst: boolean;
  showHidden: boolean;
  /** the accent colour: the app's own sapphire, or Windows' (Match system, Windows only) */
  accentSource: AccentSource;
  /** light, dark, or whatever the OS is in (state/theme resolves it, hooks/use-theme applies it) */
  theme: ThemeChoice;
  /** paths pinned to the sidebar, in order */
  pins: string[];
  /** width of the right-side pane (Details / Preview), px */
  paneWidth: number;
  /** height of the bottom terminal pane, px */
  terminalHeight: number;
  /** the terminal pane `cd`s along with the active tab */
  terminalFollow: boolean;
  /** what set-as-default did last time — separate from what the registry says now */
  defaultHandler: DefaultHandlerSetting;
  /** sidebar sections folded shut: 'quick-access', 'drives' */
  sidebarCollapsed: string[];
  /** width of the sidebar, px */
  sidebarWidth: number;
  /** folders visited, most recent first (ours, not Windows'); Quick access lists them */
  recentFolders: string[];
  /** stay in the tray when the last window closes (also forced on by set-as-default) */
  keepRunning: boolean;
  /** a `Run` entry starts the app hidden at logon (also forced on by set-as-default) */
  startWithWindows: boolean;
  /** reopen the last session's folder tabs */
  restoreTabs: boolean;
  /** what a new tab and a launch without a path open: Explorer's Folder Options choice */
  startPlace: 'home' | 'this-pc';
  /** the global chord that opens Spotlight, canonical form e.g. `super+space` */
  spotlightHotkey: string;
  /** the engine Spotlight's web row opens, `%s` standing in for the encoded query */
  spotlightSearchTemplate: string;
  /** the last session's folder tabs, written as they change */
  openTabs: string[];
  /** built-in Quick access folders the person unpinned (Desktop, Downloads, …) */
  hiddenKnownFolders: KnownFolderKey[];
  /** sidebar rows that are not folders (Home, Gallery, OneDrive, Recycle Bin), unpinned */
  hiddenSidebarKeys: SidebarKey[];
  /** the grid view's icon size (Medium 48 / Large 96 / Extra large 256) */
  iconSize: IconSize;
  /** the webview's zoom factor — the "text size" control; 1 = 100 % */
  zoom: number;
  /** the person's own context-menu commands ("Open with Code (WSL)" …) */
  customCommands: CustomCommand[];
  /**
   * Per-folder sort and grouping, most-recently-changed first — Explorer's folder bags. The
   * fields above (`sortKey`, `sortDir`, `groupKey`) stay the defaults a folder with no entry
   * here is shown with. Capped at `MAX_FOLDER_VIEWS`; see `utils/folder-views`.
   */
  folderViews: FolderView[];
  /** saved, named tab sets (plan 08 F3), newest first; see `utils/tab-sets` */
  tabSets: TabSet[];
  /** the Preview pane is the open right-side pane (Details stays per session) */
  previewOpen: boolean;
  /** the palette's preview pane beside its results (plan 04 4.4): Alt+→ shows it, Alt+← hides it */
  palettePreview: boolean;
  /** its width in px, dragged at its left edge; `PALETTE_PREVIEW_WIDTH` bounds it */
  palettePreviewWidth: number;
  /** double-click a zip / 7z / tar opens it inside Trove, not in another app */
  archivesOpenInside: boolean;
  /** "I'm coming from": the words and the extra shortcut set; 'native' = the OS Trove runs on */
  comingFrom: ComingFrom;
  /** the Size column counts folders: off, on local drives only, or everywhere */
  folderSizes: FolderSizesChoice;
  /** the name index (plan 21C.5) is on; off means no walk and no saved file */
  indexOn: boolean;
  /** drive roots (`D:\`) left out of the index; a drive not listed here is in */
  indexDrivesOff: string[];
  /** whole folders the index skips, on top of its built-ins (node_modules, .git, the Bin …) */
  indexSkipFolders: string[];
  /** Explorer's Navigation pane: the sidebar shows; off gives its width to the file list */
  navPane: boolean;
  /** Explorer's Item check boxes: a box before each name; clicking it toggles that item like Ctrl+click */
  itemCheckboxes: boolean;
  /** Explorer's Compact view: shorter details rows (22 px, 20 on a Mac) — the --spacing-row token */
  compactView: boolean;
  /** names show their extension (report.pdf); off shows report, as Explorer's default does */
  showExtensions: boolean;
  /**
   * Plan 08 A3: the person's own chord per palette action id, written as the window table writes
   * chords (`utils/chord-overrides`). In memory ⌘ is `Ctrl`; `snapshot` (the file) writes it as
   * `CmdOrCtrl`, and `sanitize` reads either back. An action not listed keeps its "I'm coming from" chord;
   * `data/shortcut-overrides` `effectiveChord` is the one place that decides.
   */
  shortcutOverrides: Record<string, string>;
}

const KNOWN_FOLDER_KEYS: KnownFolderKey[] = [
  'desktop',
  'downloads',
  'documents',
  'pictures',
  'music',
  'videos',
];
const isKnownFolderKey = (v: unknown): v is KnownFolderKey =>
  typeof v === 'string' && (KNOWN_FOLDER_KEYS as string[]).includes(v);

/** The sidebar rows that are not folders and can still be unpinned. */
export const SIDEBAR_KEYS = ['home', 'gallery', 'applications', 'onedrive', 'recycle-bin'] as const;
export type SidebarKey = (typeof SIDEBAR_KEYS)[number];
export const isSidebarKey = (v: unknown): v is SidebarKey =>
  typeof v === 'string' && (SIDEBAR_KEYS as readonly string[]).includes(v);

/** The sidebar's This PC node became the Drives section; a file that folded it folds Drives. */
const sanitizeCollapsed = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const keys = raw
    .filter((k): k is string => typeof k === 'string')
    .map((k) => (k === 'this-pc' ? 'drives' : k));
  return [...new Set(keys)];
};

export interface DefaultHandlerSetting {
  applied: boolean;
  /** the exe path the keys were written with; '' when never applied */
  exePath: string;
}

/** how many folder tabs a session remembers */
export const MAX_OPEN_TABS = 20;

const DEFAULTS: Settings = {
  view: 'details',
  columnWidths: {},
  columns: [...DEFAULT_COLUMNS],
  sortKey: 'name',
  sortDir: 'asc',
  groupKey: null,
  foldersFirst: false,
  showHidden: false,
  accentSource: 'sapphire',
  theme: 'system',
  pins: [],
  paneWidth: 320,
  terminalHeight: 240,
  terminalFollow: true,
  defaultHandler: { applied: false, exePath: '' },
  sidebarCollapsed: [],
  sidebarWidth: 248,
  recentFolders: [],
  keepRunning: false,
  startWithWindows: false,
  restoreTabs: true,
  startPlace: 'home',
  // Measured on 2026-09-24, on the shipped build, in this order:
  //   super+space        REFUSED by Windows (the shell owns it for the language switcher)
  //   alt+space          registers, fires  ← chosen
  //   ctrl+shift+space   registers, fires
  //   ctrl+space         registers, fires
  // ⚠️ alt+space has a price and it is deliberate: while Trove holds the chord, Alt+Space no
  // longer opens the window menu in other apps. Joy weighed that and picked it. See
  // utils/hotkeys.ts, whose note says the same thing to anyone choosing in Settings.
  // Linux gets ctrl+alt+space instead: GNOME holds Alt+Space (`defaultSpotlightHotkey`).
  spotlightHotkey: defaultSpotlightHotkey(),
  // Google, because the engine is a URL and this one needs no justification beyond being the
  // least surprising. It says nothing about which BROWSER opens it — the OS picks that.
  spotlightSearchTemplate: 'https://www.google.com/search?q=%s',
  openTabs: [],
  hiddenKnownFolders: [],
  hiddenSidebarKeys: [],
  iconSize: 48,
  zoom: 1,
  customCommands: [],
  folderViews: [],
  tabSets: [],
  previewOpen: false,
  palettePreview: true,
  palettePreviewWidth: 320,
  archivesOpenInside: true,
  comingFrom: 'native',
  folderSizes: 'local',
  indexOn: true,
  indexDrivesOff: [],
  indexSkipFolders: [],
  navPane: true,
  itemCheckboxes: false,
  compactView: false,
  showExtensions: true,
  shortcutOverrides: {},
};
/**
 * What a NEW install (no settings file at all) starts with: grouped cards, Medium, by date
 * modified (Today, Yesterday, … newest first). `DEFAULTS` above stay the OLD defaults on purpose:
 * they are what a field falls back to inside a file that exists, so a file written before these
 * keys existed (or holding a bad value) keeps details / no grouping instead of switching view
 * under the person. `sanitize` applies this only when `raw` is not a record.
 */
const NEW_INSTALL: Partial<Settings> = { view: 'grid', iconSize: 96, groupKey: 'modifiedMs' };
export const ICON_SIZES: IconSize[] = [48, 96, 256];
export const ZOOM = { min: 0.8, max: 2, step: 0.1 };
const isIconSize = (v: unknown): v is IconSize => ICON_SIZES.includes(v as IconSize);
/** A zoom inside its bounds, on the 0.1 grid, so Ctrl+Plus / Minus land on round numbers. */
export const clampZoom = (z: number): number =>
  Math.round(Math.min(ZOOM.max, Math.max(ZOOM.min, z)) * 10) / 10;
const TERMINAL_HEIGHT = { min: 120, max: 800 };
const MAX_COLUMN_WIDTH = 2000;
const SIDEBAR_WIDTH = { min: 160, max: 480 };
const SAVE_DELAY_MS = 400;
/** The palette preview's width bounds: 320 is plan 04 4.4's; past 400 the result list is cramped. */
export const PALETTE_PREVIEW_WIDTH = { min: 240, max: 400 };
/** A dragged width, whole and inside its bounds. */
export const clampPalettePreviewWidth = (px: number): number =>
  Math.min(PALETTE_PREVIEW_WIDTH.max, Math.max(PALETTE_PREVIEW_WIDTH.min, Math.round(px)));

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/**
 * The stored column list, in the person's order (G.59: headers can be dragged), cleaned and with
 * Name forced in first: a file built by hand (or by an older build that had no Date created)
 * must never render a header the rows do not fill, or a list with no names.
 */
const sanitizeColumns = (raw: unknown): SortKey[] =>
  Array.isArray(raw) ? cleanColumnOrder(raw) : [...DEFAULTS.columns];

/** Pick the fields we know, with their types checked; everything else is the default. */
export const sanitize = (raw: unknown): Settings => {
  if (!isRecord(raw)) {
    return { ...DEFAULTS, ...NEW_INSTALL, spotlightHotkey: defaultSpotlightHotkey() };
  }
  // a width below the column's minWidth (a hand-edited or old file) would render a squashed
  // column, so clamp to [minWidth, 2000]; a key no column owns is dropped
  const widths: Settings['columnWidths'] = {};
  if (isRecord(raw.columnWidths)) {
    for (const [k, v] of Object.entries(raw.columnWidths)) {
      const col = allColumns.find((c) => c.key === k);
      if (col && typeof v === 'number' && Number.isFinite(v)) {
        widths[col.key] = Math.max(col.minWidth, Math.min(MAX_COLUMN_WIDTH, Math.round(v)));
      }
    }
  }
  return {
    view: VIEW_MODES.includes(raw.view as ListViewMode)
      ? (raw.view as ListViewMode)
      : DEFAULTS.view,
    columnWidths: widths,
    columns: sanitizeColumns(raw.columns),
    sortKey: isSortKey(raw.sortKey) ? raw.sortKey : DEFAULTS.sortKey,
    sortDir: raw.sortDir === 'desc' ? 'desc' : DEFAULTS.sortDir,
    groupKey: isGroupKey(raw.groupKey) ? raw.groupKey : DEFAULTS.groupKey,
    foldersFirst: typeof raw.foldersFirst === 'boolean' ? raw.foldersFirst : DEFAULTS.foldersFirst,
    showHidden: typeof raw.showHidden === 'boolean' ? raw.showHidden : DEFAULTS.showHidden,
    accentSource: raw.accentSource === 'system' ? 'system' : DEFAULTS.accentSource,
    theme: isThemeChoice(raw.theme) ? raw.theme : DEFAULTS.theme,
    pins: Array.isArray(raw.pins)
      ? raw.pins.filter((p): p is string => typeof p === 'string' && p !== '')
      : [],
    paneWidth:
      typeof raw.paneWidth === 'number' && raw.paneWidth >= 200 && raw.paneWidth <= 720
        ? raw.paneWidth
        : DEFAULTS.paneWidth,
    terminalHeight:
      typeof raw.terminalHeight === 'number' &&
      raw.terminalHeight >= TERMINAL_HEIGHT.min &&
      raw.terminalHeight <= TERMINAL_HEIGHT.max
        ? raw.terminalHeight
        : DEFAULTS.terminalHeight,
    terminalFollow:
      typeof raw.terminalFollow === 'boolean' ? raw.terminalFollow : DEFAULTS.terminalFollow,
    defaultHandler: sanitizeDefaultHandler(raw.defaultHandler),
    sidebarCollapsed: sanitizeCollapsed(raw.sidebarCollapsed),
    sidebarWidth:
      typeof raw.sidebarWidth === 'number' &&
      raw.sidebarWidth >= SIDEBAR_WIDTH.min &&
      raw.sidebarWidth <= SIDEBAR_WIDTH.max
        ? raw.sidebarWidth
        : DEFAULTS.sidebarWidth,
    recentFolders: Array.isArray(raw.recentFolders)
      ? raw.recentFolders.filter((p): p is string => typeof p === 'string' && p !== '')
      : [],
    keepRunning: typeof raw.keepRunning === 'boolean' ? raw.keepRunning : DEFAULTS.keepRunning,
    startWithWindows:
      typeof raw.startWithWindows === 'boolean' ? raw.startWithWindows : DEFAULTS.startWithWindows,
    restoreTabs: typeof raw.restoreTabs === 'boolean' ? raw.restoreTabs : DEFAULTS.restoreTabs,
    archivesOpenInside:
      typeof raw.archivesOpenInside === 'boolean'
        ? raw.archivesOpenInside
        : DEFAULTS.archivesOpenInside,
    startPlace: raw.startPlace === 'this-pc' ? 'this-pc' : DEFAULTS.startPlace,
    spotlightHotkey:
      typeof raw.spotlightHotkey === 'string' && raw.spotlightHotkey.trim() !== ''
        ? raw.spotlightHotkey.trim().toLowerCase()
        : // read now, not at module load: the platform is a call-time fact (`utils/platform`)
          defaultSpotlightHotkey(),
    spotlightSearchTemplate: sanitizeSearchTemplate(raw.spotlightSearchTemplate),
    openTabs: Array.isArray(raw.openTabs)
      ? raw.openTabs
          .filter((p): p is string => typeof p === 'string' && p !== '')
          .slice(0, MAX_OPEN_TABS)
      : [],
    hiddenKnownFolders: Array.isArray(raw.hiddenKnownFolders)
      ? raw.hiddenKnownFolders.filter(isKnownFolderKey)
      : [],
    hiddenSidebarKeys: Array.isArray(raw.hiddenSidebarKeys)
      ? raw.hiddenSidebarKeys.filter(isSidebarKey).filter((k, i, all) => all.indexOf(k) === i)
      : [],
    iconSize: isIconSize(raw.iconSize) ? raw.iconSize : DEFAULTS.iconSize,
    zoom:
      typeof raw.zoom === 'number' && Number.isFinite(raw.zoom)
        ? clampZoom(raw.zoom)
        : DEFAULTS.zoom,
    customCommands: Array.isArray(raw.customCommands)
      ? raw.customCommands.map(sanitizeCustomCommand).filter((c): c is CustomCommand => c !== null)
      : [],
    // absent in every file written before per-folder views existed, and that has to be silent
    folderViews: sanitizeFolderViews(raw.folderViews),
    tabSets: sanitizeTabSets(raw.tabSets),
    previewOpen: raw.previewOpen === true,
    // absent before plan 04 4.4: on, at 320
    palettePreview: raw.palettePreview !== false,
    palettePreviewWidth:
      typeof raw.palettePreviewWidth === 'number' && Number.isFinite(raw.palettePreviewWidth)
        ? clampPalettePreviewWidth(raw.palettePreviewWidth)
        : DEFAULTS.palettePreviewWidth,
    // anything but the three styles (a missing key, an older file, junk) is 'native'
    comingFrom: toChoice(raw.comingFrom),
    folderSizes: isFolderSizesChoice(raw.folderSizes) ? raw.folderSizes : DEFAULTS.folderSizes,
    indexOn: raw.indexOn !== false,
    indexDrivesOff: sanitizePathList(raw.indexDrivesOff),
    indexSkipFolders: sanitizePathList(raw.indexSkipFolders),
    // a missing key (a file from before this toggle) or a non-boolean is the default
    navPane: typeof raw.navPane === 'boolean' ? raw.navPane : DEFAULTS.navPane,
    // a missing key (a file from before this toggle) or a non-boolean is the default
    itemCheckboxes:
      typeof raw.itemCheckboxes === 'boolean' ? raw.itemCheckboxes : DEFAULTS.itemCheckboxes,
    // a missing key (a file from before this toggle) or a non-boolean is the default
    compactView: typeof raw.compactView === 'boolean' ? raw.compactView : DEFAULTS.compactView,
    // a missing key (a file from before this toggle) or a non-boolean is the default
    showExtensions:
      typeof raw.showExtensions === 'boolean' ? raw.showExtensions : DEFAULTS.showExtensions,
    // absent before plan 08 A3: no overrides; unknown ids and malformed chords are dropped
    shortcutOverrides: sanitizeOverrides(raw.shortcutOverrides),
  };
};

/** A path compared the way Windows does: no case, no trailing slash. */
const driveKey = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();

/** A list of paths: strings only, trimmed, no blanks, no repeats (case-folded: Windows paths). */
const sanitizePathList = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const seen: Record<string, true> = {};
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const path = v.trim();
    const key = path.toLowerCase();
    if (path && !seen[key]) {
      seen[key] = true;
      out.push(path);
    }
  }
  return out;
};

const COMMAND_SCOPES: CommandScope[] = ['file', 'folder', 'background', 'wsl'];
const isCommandScope = (v: unknown): v is CommandScope =>
  typeof v === 'string' && (COMMAND_SCOPES as string[]).includes(v);

/** A stored command is kept only with an id, a label and a program; scopes are filtered. */
const sanitizeCustomCommand = (raw: unknown): CustomCommand | null => {
  if (!isRecord(raw)) return null;
  const { id, label, program, args, scope } = raw;
  if (typeof id !== 'string' || !id || typeof label !== 'string' || typeof program !== 'string')
    return null;
  if (!program.trim()) return null;
  return {
    id,
    label: label.trim() || program,
    program: program.trim(),
    args: typeof args === 'string' ? args : '',
    scope: Array.isArray(scope) ? scope.filter(isCommandScope) : [],
  };
};

/**
 * A search template is only kept when it can actually build a URL: `%s` somewhere for the
 * query to go, and an `http://`/`https://` scheme. Anything else — a hand-edited file, a
 * half-typed value, a `javascript:` or `file:` string — falls back to the default rather than
 * being written through, so Enter on the web row can never hand the OS something that is not
 * a web address, and an old file never breaks a new build.
 */
const sanitizeSearchTemplate = (raw: unknown): string => {
  if (typeof raw !== 'string') return DEFAULTS.spotlightSearchTemplate;
  const t = raw.trim();
  return t.includes('%s') && /^https?:\/\//i.test(t) ? t : DEFAULTS.spotlightSearchTemplate;
};

const sanitizeDefaultHandler = (raw: unknown): DefaultHandlerSetting => {
  if (!isRecord(raw)) return { ...DEFAULTS.defaultHandler };
  return {
    applied: typeof raw.applied === 'boolean' ? raw.applied : false,
    exePath: typeof raw.exePath === 'string' ? raw.exePath : '',
  };
};

/**
 * The fields whose value differs between two snapshots, with `to`'s values. Compared as JSON:
 * every field is plain data, and a fresh copy of an unchanged array must not count as a change.
 */
export const changedFields = (from: Settings, to: Settings): Partial<Settings> => {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(to) as (keyof Settings)[]) {
    if (JSON.stringify(from[key]) !== JSON.stringify(to[key])) patch[key] = to[key];
  }
  return patch as Partial<Settings>;
};

export const SETTINGS_KEYS = Object.keys(DEFAULTS) as (keyof Settings)[];

class SettingsState {
  view = $state<ListViewMode>(DEFAULTS.view);
  columnWidths = $state<Settings['columnWidths']>({});
  columns = $state<SortKey[]>([...DEFAULTS.columns]);
  sortKey = $state<SortKey>(DEFAULTS.sortKey);
  sortDir = $state<'asc' | 'desc'>(DEFAULTS.sortDir);
  groupKey = $state<SortKey | null>(DEFAULTS.groupKey);
  foldersFirst = $state(DEFAULTS.foldersFirst);
  showHidden = $state(DEFAULTS.showHidden);
  accentSource = $state<AccentSource>(DEFAULTS.accentSource);
  theme = $state<ThemeChoice>(DEFAULTS.theme);
  pins = $state<string[]>([]);
  paneWidth = $state(DEFAULTS.paneWidth);
  terminalHeight = $state(DEFAULTS.terminalHeight);
  terminalFollow = $state(DEFAULTS.terminalFollow);
  defaultHandler = $state<DefaultHandlerSetting>({ ...DEFAULTS.defaultHandler });
  sidebarCollapsed = $state<string[]>([]);
  sidebarWidth = $state(DEFAULTS.sidebarWidth);
  recentFolders = $state<string[]>([]);
  keepRunning = $state(DEFAULTS.keepRunning);
  startWithWindows = $state(DEFAULTS.startWithWindows);
  restoreTabs = $state(DEFAULTS.restoreTabs);
  archivesOpenInside = $state(DEFAULTS.archivesOpenInside);
  startPlace = $state<Settings['startPlace']>(DEFAULTS.startPlace);
  spotlightHotkey = $state<Settings['spotlightHotkey']>(DEFAULTS.spotlightHotkey);
  spotlightSearchTemplate = $state<Settings['spotlightSearchTemplate']>(
    DEFAULTS.spotlightSearchTemplate,
  );
  openTabs = $state<string[]>([]);
  hiddenKnownFolders = $state<KnownFolderKey[]>([]);
  hiddenSidebarKeys = $state<SidebarKey[]>([]);
  iconSize = $state<IconSize>(DEFAULTS.iconSize);
  zoom = $state(DEFAULTS.zoom);
  customCommands = $state<CustomCommand[]>([]);
  folderViews = $state<FolderView[]>([]);
  tabSets = $state<TabSet[]>([]);
  previewOpen = $state(DEFAULTS.previewOpen);
  palettePreview = $state(DEFAULTS.palettePreview);
  palettePreviewWidth = $state(DEFAULTS.palettePreviewWidth);
  comingFrom = $state<ComingFrom>(DEFAULTS.comingFrom);
  folderSizes = $state<FolderSizesChoice>(DEFAULTS.folderSizes);
  indexOn = $state(DEFAULTS.indexOn);
  indexDrivesOff = $state<string[]>([]);
  indexSkipFolders = $state<string[]>([]);
  navPane = $state(DEFAULTS.navPane);
  itemCheckboxes = $state(DEFAULTS.itemCheckboxes);
  compactView = $state(DEFAULTS.compactView);
  showExtensions = $state(DEFAULTS.showExtensions);
  shortcutOverrides = $state<Record<string, string>>({});
  loaded = $state(false);
  /**
   * This window's values are the person's, not the shipped defaults: true after `load`, and in
   * the Spotlight window (which never loads) once it has read the file or heard a live change.
   * Until then the theme is only System's answer, so use-theme must not store it for the next
   * window (`trove-theme`) — that would overwrite a real Light/Dark choice with a guess.
   */
  settled = $state(false);
  /** no settings file existed when we loaded: the first run on this machine */
  firstRun = $state(false);
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** the snapshot the debounce is still holding; undefined when nothing is waiting to be written */
  #pending: Settings | undefined;
  /**
   * Writes run one at a time, in the order they were asked for. Two `writeSettings` calls in
   * flight together are two whole-file writes of two different snapshots, and Rust finishes them
   * in whichever order its command tasks happen to — so the OLDER snapshot can land last and undo
   * the newer one. `flush` makes that overlap ordinary (it issues a write while the timer's write
   * may still be in flight), so the chain is what keeps last-asked-for = last-written.
   */
  #tail: Promise<void> = Promise.resolve();
  /**
   * What this window last agreed with the others: the state after `load`, moved forward by every
   * change it published (`takeChanges`) and every change it received (`applyRemote`). A change is
   * a field that differs from this — so a field received from another window is never sent back.
   */
  #shared: Settings | undefined;
  /** fields a non-main window changed and has not written yet (`schedulePatch`) */
  #pendingPatch: Partial<Settings> | undefined;
  #patchTimer: ReturnType<typeof setTimeout> | undefined;

  snapshot = (): Settings => ({
    view: this.view,
    columnWidths: { ...this.columnWidths },
    columns: [...this.columns],
    sortKey: this.sortKey,
    sortDir: this.sortDir,
    groupKey: this.groupKey,
    foldersFirst: this.foldersFirst,
    showHidden: this.showHidden,
    accentSource: this.accentSource,
    theme: this.theme,
    pins: [...this.pins],
    paneWidth: this.paneWidth,
    terminalHeight: this.terminalHeight,
    terminalFollow: this.terminalFollow,
    defaultHandler: { ...this.defaultHandler },
    sidebarCollapsed: [...this.sidebarCollapsed],
    sidebarWidth: this.sidebarWidth,
    recentFolders: [...this.recentFolders],
    keepRunning: this.keepRunning,
    startWithWindows: this.startWithWindows,
    restoreTabs: this.restoreTabs,
    archivesOpenInside: this.archivesOpenInside,
    startPlace: this.startPlace,
    spotlightHotkey: this.spotlightHotkey,
    spotlightSearchTemplate: this.spotlightSearchTemplate,
    openTabs: [...this.openTabs],
    hiddenKnownFolders: [...this.hiddenKnownFolders],
    hiddenSidebarKeys: [...this.hiddenSidebarKeys],
    iconSize: this.iconSize,
    zoom: this.zoom,
    customCommands: this.customCommands.map((c) => ({ ...c, scope: [...c.scope] })),
    folderViews: this.folderViews.map((v) => ({ ...v })),
    tabSets: this.tabSets.map((t) => ({ ...t, tabs: [...t.tabs] })),
    previewOpen: this.previewOpen,
    palettePreview: this.palettePreview,
    palettePreviewWidth: this.palettePreviewWidth,
    comingFrom: this.comingFrom,
    folderSizes: this.folderSizes,
    indexOn: this.indexOn,
    indexDrivesOff: [...this.indexDrivesOff],
    indexSkipFolders: [...this.indexSkipFolders],
    navPane: this.navPane,
    itemCheckboxes: this.itemCheckboxes,
    compactView: this.compactView,
    showExtensions: this.showExtensions,
    shortcutOverrides: toStoredOverrides(this.shortcutOverrides),
  });

  apply(s: Settings) {
    this.view = s.view;
    this.columnWidths = s.columnWidths;
    this.columns = s.columns;
    this.sortKey = s.sortKey;
    this.sortDir = s.sortDir;
    this.groupKey = s.groupKey;
    this.foldersFirst = s.foldersFirst;
    this.showHidden = s.showHidden;
    this.accentSource = s.accentSource;
    this.theme = s.theme;
    this.pins = s.pins;
    this.paneWidth = s.paneWidth;
    this.terminalHeight = s.terminalHeight;
    this.terminalFollow = s.terminalFollow;
    this.defaultHandler = s.defaultHandler;
    this.sidebarCollapsed = s.sidebarCollapsed;
    this.sidebarWidth = s.sidebarWidth;
    this.recentFolders = s.recentFolders;
    this.keepRunning = s.keepRunning;
    this.startWithWindows = s.startWithWindows;
    this.restoreTabs = s.restoreTabs;
    this.archivesOpenInside = s.archivesOpenInside;
    this.startPlace = s.startPlace;
    this.spotlightHotkey = s.spotlightHotkey;
    this.spotlightSearchTemplate = s.spotlightSearchTemplate;
    this.openTabs = s.openTabs;
    this.hiddenKnownFolders = s.hiddenKnownFolders;
    this.hiddenSidebarKeys = s.hiddenSidebarKeys;
    this.iconSize = s.iconSize;
    this.zoom = s.zoom;
    this.customCommands = s.customCommands;
    this.folderViews = s.folderViews;
    this.tabSets = s.tabSets;
    this.previewOpen = s.previewOpen;
    this.palettePreview = s.palettePreview;
    this.palettePreviewWidth = s.palettePreviewWidth;
    this.comingFrom = s.comingFrom;
    this.folderSizes = s.folderSizes;
    this.indexOn = s.indexOn;
    this.indexDrivesOff = s.indexDrivesOff;
    this.indexSkipFolders = s.indexSkipFolders;
    this.navPane = s.navPane;
    this.itemCheckboxes = s.itemCheckboxes;
    this.compactView = s.compactView;
    this.showExtensions = s.showExtensions;
    this.shortcutOverrides = s.shortcutOverrides;
  }

  /** Ctrl+Plus / Ctrl+Minus / Ctrl+0: one step on the 0.1 grid, inside the bounds. */
  zoomBy(steps: number) {
    this.zoom = clampZoom(this.zoom + steps * ZOOM.step);
  }

  /** Clamped so a drag past the edge never persists a bad width. */
  setSidebarWidth(px: number) {
    this.sidebarWidth = Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(px)));
  }

  isCollapsed(key: string) {
    return this.sidebarCollapsed.includes(key);
  }

  toggleCollapsed(key: string) {
    const i = this.sidebarCollapsed.indexOf(key);
    if (i >= 0) this.sidebarCollapsed.splice(i, 1);
    else this.sidebarCollapsed.push(key);
  }

  /** Clamped to the pane's bounds so a drag past the edge never persists a bad value. */
  setTerminalHeight(px: number) {
    this.terminalHeight = Math.min(
      TERMINAL_HEIGHT.max,
      Math.max(TERMINAL_HEIGHT.min, Math.round(px)),
    );
  }

  async load() {
    if (this.loaded) return;
    const raw = await readSettings();
    this.firstRun = raw === null || raw === undefined;
    this.apply(sanitize(raw));
    // first run only: the Preview pane starts open on a wide window (an existing file keeps its own)
    // A first run marks the preview open; PaneHost's previewFits hides it while the window is too
    // narrow and shows it once it is wide. Reading the width HERE was wrong: the main window is
    // still hidden while settings load, so innerWidth was not its real width and a new install at
    // 1200 px opened with the preview closed (Ubuntu, 2026-10-06).
    if (this.firstRun) this.previewOpen = true;
    // A settings file that has never held custom commands — a first run, or one written before
    // the feature existed — gets the one command Windows cannot register itself: Code over WSL.
    const neverHadCommands =
      this.firstRun || !(typeof raw === 'object' && raw !== null && 'customCommands' in raw);
    if (neverHadCommands && this.customCommands.length === 0) {
      this.customCommands = seedCommandsFor();
    }
    this.#shared = this.snapshot();
    this.loaded = true;
    this.settled = true;
  }

  /**
   * The fields `snapshot` changed since this window last agreed with the others, and agree on it
   * now. Empty before `load`, and empty for a change that came from another window.
   *
   * ⚠️ Second windows: `main` writes the whole file, and a second window's state is only ever as
   * fresh as its own `load` — so it must never write its whole snapshot, or it would put back
   * what `main` changed since. It sends these fields instead (an event, and `schedulePatch`).
   */
  takeChanges(snapshot: Settings): Partial<Settings> {
    if (!this.loaded || this.#shared === undefined) return {};
    const patch = changedFields(this.#shared, snapshot);
    this.#shared = snapshot;
    return patch;
  }

  /**
   * Another window changed these fields: take them, sanitized like a file, and mark them agreed
   * so they are not sent back. Unknown keys are dropped. Ignored before `load` — the file read
   * then has the change already, or will once its writer saves.
   */
  applyRemote(raw: unknown) {
    if (!this.loaded || this.#shared === undefined || !isRecord(raw)) return;
    const keys = SETTINGS_KEYS.filter((k) => k in raw);
    if (keys.length === 0) return;
    const clean = sanitize({ ...this.snapshot(), ...raw });
    const shared: Record<string, unknown> = { ...this.#shared };
    const self = this as unknown as Record<string, unknown>;
    for (const key of keys) {
      // `#shared` holds snapshot form, so the overrides go back to their stored spelling
      shared[key] =
        key === 'shortcutOverrides' ? toStoredOverrides(clean.shortcutOverrides) : clean[key];
      self[key] = clean[key];
    }
    this.#shared = shared as unknown as Settings;
  }

  /** A non-main window's changed fields, written (merged into the file) after the debounce. */
  schedulePatch(patch: Partial<Settings>) {
    if (!this.loaded || Object.keys(patch).length === 0) return;
    clearTimeout(this.#patchTimer);
    this.#pendingPatch = { ...this.#pendingPatch, ...patch };
    this.#patchTimer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  /** Called from an effect that reads `snapshot()`; coalesces bursts into one write. */
  scheduleSave(snapshot: Settings) {
    if (!this.loaded) return;
    clearTimeout(this.#timer);
    this.#pending = snapshot;
    this.#timer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  /**
   * Write whatever the debounce is still holding, now, and resolve when it has reached disk.
   *
   * ⚠️ This is what stops a settings change from being lost on close. The debounce is
   * `SAVE_DELAY_MS`, and the shipped defaults are `keepRunning: false` with the default handler
   * unapplied — so on the DEFAULT path closing the window destroys the webview, its timers go
   * with it, and a tab opened or a column dragged in the last 400 ms was never written.
   * (Residency masks it: `prevent_close()` + `hide()` keeps the webview alive, so the timer still
   * fires.) A close path must AWAIT this before the window is destroyed — the write is an
   * `invoke` round trip, so a caller that lets the webview die first loses it again.
   *
   * Safe with nothing pending: it writes nothing and resolves once the last write has finished,
   * so a close path can call it unconditionally. The debounce stays — it is there so a column
   * drag does not write the file on every mouse move; this only cuts it short.
   */
  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    clearTimeout(this.#patchTimer);
    this.#patchTimer = undefined;
    const snapshot = this.#pending;
    this.#pending = undefined;
    const patch = this.#pendingPatch;
    this.#pendingPatch = undefined;
    if (snapshot !== undefined) {
      // a rejected write must not poison the chain — that would make every later flush reject and
      // one failed write stop all the rest — so each link swallows its own failure, as
      // `residency.#push` does for the same reason
      this.#tail = this.#tail.then(() => writeSettings(snapshot).catch(() => {}));
    }
    if (patch !== undefined) {
      this.#tail = this.#tail.then(() => mergeSettings(patch).catch(() => {}));
    }
    return this.#tail;
  }

  /**
   * Pin or unpin a folder. Pinning the path of a built-in folder the person had unpinned
   * shows the built-in again instead of adding a second entry for the same folder.
   */
  togglePin(path: string, known?: KnownFolderKey) {
    if (known !== undefined && this.isKnownFolderHidden(known)) {
      this.toggleKnownFolder(known);
      return;
    }
    const i = this.pins.indexOf(path);
    if (i >= 0) this.pins.splice(i, 1);
    else this.pins.push(path);
  }

  isKnownFolderHidden(key: KnownFolderKey) {
    return this.hiddenKnownFolders.includes(key);
  }

  /** Unpin (hide) or show again one of the built-in Quick access folders. */
  toggleKnownFolder(key: KnownFolderKey) {
    const i = this.hiddenKnownFolders.indexOf(key);
    if (i >= 0) this.hiddenKnownFolders.splice(i, 1);
    else this.hiddenKnownFolders.push(key);
  }

  /** The way back after unpinning built-ins: every default folder listed again. */
  showDefaultFolders() {
    this.hiddenKnownFolders = [];
  }

  isSidebarKeyHidden(key: SidebarKey) {
    return this.hiddenSidebarKeys.includes(key);
  }

  /** Unpin (hide) or show again Home, Gallery, OneDrive or the Recycle Bin. */
  toggleSidebarKey(key: SidebarKey) {
    const i = this.hiddenSidebarKeys.indexOf(key);
    if (i >= 0) this.hiddenSidebarKeys.splice(i, 1);
    else this.hiddenSidebarKeys.push(key);
  }

  /** Whether the index walks this drive root (`D:\`); matched ignoring case and a trailing slash. */
  isIndexDriveOn(root: string) {
    const key = driveKey(root);
    return !this.indexDrivesOff.some((d) => driveKey(d) === key);
  }

  /** Put a drive in the index or leave it out. */
  setIndexDrive(root: string, on: boolean) {
    const key = driveKey(root);
    const rest = this.indexDrivesOff.filter((d) => driveKey(d) !== key);
    this.indexDrivesOff = on ? rest : [...rest, root];
  }

  /** Skip one more whole folder. Returns why it was refused, or null when kept. */
  addIndexSkipFolder(raw: string): string | null {
    const path = raw.trim().replace(/[\\/]+$/, '');
    if (!/^([a-z]:|[\\/]{2}|\/)/i.test(path) || path.length < 3) {
      return 'Type a full folder path, like C:\\Games';
    }
    if (this.indexSkipFolders.some((p) => driveKey(p) === driveKey(path))) {
      return 'That folder is already skipped';
    }
    this.indexSkipFolders = [...this.indexSkipFolders, path];
    return null;
  }

  removeIndexSkipFolder(path: string) {
    this.indexSkipFolders = this.indexSkipFolders.filter((p) => p !== path);
  }

  /** Every unpinned row back: the built-in folders and Home, Gallery, OneDrive, the Bin. */
  restoreSidebarDefaults() {
    this.hiddenKnownFolders = [];
    this.hiddenSidebarKeys = [];
  }

  /** Show or hide one details column, keeping the person's order (`insertColumn`). Name cannot go. */
  toggleColumn(key: SortKey) {
    if (key === REQUIRED_COLUMN || key === 'path') return;
    const on = this.columns.includes(key);
    this.columns = on ? this.columns.filter((k) => k !== key) : insertColumn(this.columns, key);
  }
}

export const settings = new SettingsState();

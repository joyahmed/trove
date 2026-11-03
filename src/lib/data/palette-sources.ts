// What the palette can find, one provider per kind. Each returns its matches for a query;
// `utils/palette-rank` orders the merged list. Text matching is left to the ranker, so a
// source returns everything it has unless it is a lookup that takes the text itself (files,
// path mode). From the Spotlight window, everything that changes the explorer goes out as a
// `spotlight:*` event and the palette hides — the main window listens (state/spotlight-bridge).
// From Find anything it goes straight to the window the panel is in (`PaletteTarget`).
import { clipboardWriteText } from '$lib/api/clipboard';
import { openPath, readDir } from '$lib/api/fs';
import {
  emitAction,
  emitNavigate,
  emitSearch,
  emitReveal,
  hidePalette,
  indexSearch,
  indexWsl,
  launchApp,
  openUrlFromPalette,
  showMain,
  spotlightApps,
  spotlightFiles,
} from '$lib/api/palette';
import { recentFiles } from '$lib/api/recent';
import { userProfile } from '$lib/api/shell';
import { wslHome, wslRunningDistros } from '$lib/api/wsl';
import { paletteActions } from '$lib/data/palette-actions';
import { indexProgress } from '$lib/state/index-progress.svelte';
import { places } from '$lib/state/places.svelte';
import { settings } from '$lib/state/settings.svelte';
import { wsl } from '$lib/state/wsl.svelte';
import type { FileEntry } from '$lib/types/fs';
import type { DriveInfo } from '$lib/types/shell';
import type { PaletteResult, PaletteSource } from '$lib/types/palette';
import { fmtSpace } from '$lib/utils/format';
import { locationLabel, pathLocation } from '$lib/utils/location';
import { evaluateExpression, formatResult, looksLikeExpression } from '$lib/utils/palette-calc';
import { matchScore } from '$lib/utils/palette-rank';
import { pathCompletion } from '$lib/utils/palette-path';
import { buildSearchUrl } from '$lib/utils/palette-search-url';
import { onWindows } from '$lib/utils/platform';
import { isAppBundle } from '$lib/utils/app-bundle';
import { appIcon } from '$lib/utils/app-icon';
import { folderKey, isRootPath, parentOf, pathKey, toLinuxForm, wslRootFor } from '$lib/utils/path';
import { logError } from '$lib/api/log';

const folderName = (path: string) => locationLabel(pathLocation(path));

/**
 * How long a query waits for `places` before answering with whatever has landed.
 *
 * ⛔ `places.load()` resolves only when its *slowest* source does, and the drive enumeration
 * is measured in tens of seconds on a machine with a dead network mapping — 21 s and 64 s in
 * `trove.log`, which is why `state/places.svelte.ts` loads its three sources independently.
 * A palette query that awaits the whole thing finds nothing on the machine for a minute
 * ("the supersearch can't find anything"), and worse, `places.loaded` never latches when the
 * drives fail, so *every* query pays it again. So: ask, wait this long, go with what is there.
 */
const PLACES_WAIT_MS = 400;

const placesReady = async () => {
  await Promise.race([places.load(), new Promise<void>((r) => setTimeout(r, PLACES_WAIT_MS))]);
};

/**
 * The explorer a panel palette acts on directly — Find anything hands its own window's
 * `state/spotlight-bridge` here. The Spotlight window has none and emits instead.
 */
export interface PaletteTarget {
  navigate: (path: string) => unknown;
  reveal: (path: string) => unknown;
  searchEverywhere: (text: string) => unknown;
  runAction: (key: string) => unknown;
}

/** What a row does when it acts on the explorer, and how the palette gets out of the way. */
interface Hand {
  navigate: (path: string) => Promise<void>;
  reveal: (path: string) => Promise<void>;
  searchEverywhere: (text: string) => Promise<void>;
  runAction: (key: string) => Promise<void>;
  done: () => Promise<void>;
}

/**
 * The Spotlight window: raise the main explorer, hand it the act as a `spotlight:*` event, hide.
 * ⛔ Only the main window listens, so a panel inside a second window must never come this way —
 * its folder would open in the main window and raise it.
 */
const toMain: Hand = {
  navigate: async (path) => {
    await showMain();
    await emitNavigate(path);
    await hidePalette();
  },
  reveal: async (path) => {
    await showMain();
    await emitReveal(path);
    await hidePalette();
  },
  searchEverywhere: async (text) => {
    await showMain();
    await emitSearch(text);
    await hidePalette();
  },
  runAction: async (key) => {
    await showMain();
    await emitAction(key);
    await hidePalette();
  },
  done: hidePalette,
};

/** A panel: act on the window it sits in. Nothing to raise, and no Spotlight window to hide. */
const toTarget = (t: PaletteTarget): Hand => ({
  navigate: async (path) => void (await t.navigate(path)),
  reveal: async (path) => void (await t.reveal(path)),
  searchEverywhere: async (text) => void (await t.searchEverywhere(text)),
  runAction: async (key) => void (await t.runAction(key)),
  done: async () => {},
});

/**
 * Every row that starts something (a file, a folder's app, an app by id) goes through here:
 * the palette gets out of the way once the start was asked for, and also when it failed — a
 * Spotlight window left open over a start that did nothing looks like the Enter was ignored.
 */
const startThenDone = async (to: Hand, start: () => Promise<unknown>) => {
  try {
    await start();
  } finally {
    await to.done();
  }
};

const open = (to: Hand, path: string) => startThenDone(to, () => openPath(path));

const folderResult = (
  to: Hand,
  key: string,
  path: string,
  category: PaletteResult['category'],
): PaletteResult => ({
  key,
  category,
  title: folderName(path),
  detail: toLinuxForm(path) ?? path,
  identity: path,
  iconKey: 'folder',
  run: () => to.navigate(path),
  reveal: () => to.reveal(path),
});

const fileResult = (
  to: Hand,
  key: string,
  e: FileEntry,
  category: PaletteResult['category'],
): PaletteResult =>
  e.isDir && !isAppBundle(e)
    ? folderResult(to, key, e.path, category)
    : {
        key,
        category,
        title: e.name,
        detail: parentOf(e.path) ?? e.path,
        identity: e.path,
        iconKey: e.iconKey,
        run: () => open(to, e.path),
        reveal: () => to.reveal(e.path),
      };

/**
 * Arithmetic, answered inline. `matched: true` skips the text matcher — `= 84` will never
 * contain what was typed — and `category: 'calc'` sorts it above every other group. Enter
 * copies the answer and gets out of the way; nothing is sent anywhere, the parser is local.
 */
const calcSource = (to: Hand): PaletteSource => ({
  key: 'calc',
  query: async (text) => {
    const t = text.trim();
    if (!looksLikeExpression(t)) return [];
    const value = evaluateExpression(t);
    if (value === undefined) return [];
    const answer = formatResult(value);
    return [
      {
        key: 'calc',
        category: 'calc',
        title: `= ${answer}`,
        detail: `${t} — Enter copies the answer`,
        glyph: 'calculator',
        matched: true,
        run: async () => {
          await clipboardWriteText(answer);
          await to.done();
        },
      },
    ];
  },
});

const actionsSource = (to: Hand): PaletteSource => ({
  key: 'actions',
  query: async () =>
    paletteActions.map((a) => ({
      key: `action:${a.key}`,
      category: 'actions',
      title: a.label,
      detail: a.keywords,
      glyph: a.glyph,
      run: () => to.runAction(a.key),
    })),
});

/** Typed `C:\…`, `\\…`, `~`, `Ubuntu:/…`: the parent's children whose names start with the rest. */
const pathSource = (to: Hand): PaletteSource => ({
  key: 'path',
  query: async (text) => {
    const c = pathCompletion(text, text.trim().startsWith('~') ? await userProfile() : null);
    if (!c) return [];
    try {
      const listing = await readDir(c.parent);
      return (
        listing.entries
          // `isHidden` is the dot-name on Unix and the hidden attribute on Windows, both set in Rust
          .filter((e) => settings.showHidden || !e.isHidden)
          .filter((e) => e.name.toLowerCase().startsWith(c.prefix))
          .slice(0, 12)
          .map((e) => ({ ...fileResult(to, `path:${e.path}`, e, 'path'), matched: true }))
      );
    } catch (e) {
      logError('palette.pathCompletion', e);
      return [];
    }
  },
});

const recentSource = (to: Hand): PaletteSource => ({
  key: 'recent',
  query: async () => {
    const folders = settings.recentFolders.map((p) => folderResult(to, `recent:${p}`, p, 'recent'));
    const files = await recentFiles().catch((): FileEntry[] => []);
    return [...folders, ...files.map((e) => fileResult(to, `recent:${e.path}`, e, 'recent'))];
  },
});

/**
 * `Windows (C:)` on Windows. Off Windows the path is a mount (`/`, `/media/alex/USB`), whose first
 * two characters mean nothing, so the label alone — or the mount path when there is no label.
 */
const driveTitle = (d: DriveInfo): string =>
  onWindows() ? `${d.label} (${d.path.slice(0, 2)})` : d.label || d.path;

const placesSource = (to: Hand): PaletteSource => ({
  key: 'places',
  query: async () => {
    // ⛔ neither wait blocks the row list: a palette that cannot list drives must still offer
    // the known folders and the pins, and a WSL registry read that throws is not "no places"
    await Promise.all([
      placesReady(),
      wsl.load().catch((e: unknown) => logError('palette.wslDistros', e)),
    ]);
    const known = places.knownFolders.map((f) => ({
      ...folderResult(to, `known:${f.key}`, f.path, 'places'),
      title: f.label,
    }));
    const pins = settings.pins.map((p) => folderResult(to, `pin:${p}`, p, 'places'));
    const drives = places.drives.map((d): PaletteResult => ({
      key: `drive:${d.path}`,
      category: 'places',
      title: driveTitle(d),
      // unknown space (null) says nothing rather than a made-up 0
      detail:
        d.freeBytes === null || d.totalBytes === null
          ? ''
          : `${fmtSpace(d.freeBytes)} free of ${fmtSpace(d.totalBytes)}`,
      glyph: 'drive',
      run: () => to.navigate(d.path),
    }));
    const distros = wsl.distros.map((d): PaletteResult => ({
      key: `wsl:${d.name}`,
      category: 'places',
      title: d.name,
      detail: `${d.name}:/`,
      glyph: 'linux',
      // like the sidebar: the distro's home is the entry point (the lookup starts the distro);
      // if it cannot be found the distro's root still opens
      run: async () =>
        to.navigate(await wslHome(d.name, d.uid).catch(() => `\\\\wsl.localhost\\${d.name}\\`)),
    }));
    return [...known, ...pins, ...drives, ...distros];
  },
});

/**
 * Everything the machine can launch, by the name Start prints.
 *
 * ⛔ Two kinds of row, and the palette missed the second kind entirely until now: an app with a
 * resolvable Start-menu shortcut (open the `.lnk`, and `Reveal in explorer` has a real exe to
 * point at), and an app that exists only as an `AppsFolder` id — **every Store app**, plus the
 * ID-list-only shortcuts whose target `parse_lnk` cannot read. On this machine that second kind
 * is 86 of 173 rows: Calculator, Notepad, Paint, Settings, Task Manager, Terminal, Command
 * Prompt, File Explorer, Control Panel, Run. Joy's *"it missed calculator"* was all of them.
 *
 * An id-only row has nothing on disk, so it offers no Reveal — an explorer window on
 * `WindowsApps` is not where that app lives in any sense the person means.
 */
const appsSource = (to: Hand): PaletteSource => ({
  key: 'apps',
  query: async () => {
    const apps = await spotlightApps();
    return apps.map((a) => ({
      key: `app:${a.lnkPath || a.aumid}`,
      category: 'apps',
      title: a.name,
      detail: a.target || a.path,
      identity: a.target || a.path,
      // Windows: the shortcut's icon when there is one (the cached, cheap lookup), else the
      // shell's own tile for the app id. Mac: the `.app` bundle's own icon (QuickLook route).
      // Ubuntu: a drawn app glyph, there is no icon lookup for a `.desktop` file yet.
      ...appIcon(a),
      run: () => (a.lnkPath ? open(to, a.lnkPath) : startThenDone(to, () => launchApp(a.aumid))),
      // `target` is the exe on Windows; Mac and Ubuntu have no target, only the bundle / `.desktop`
      reveal: a.target || a.path ? () => to.reveal(a.target || a.path) : undefined,
    }));
  },
});

/** Below this many hits from the near roots, the drives are walked too. */
export const FILES_NEAR_ENOUGH = 8;

/** The last files row: hand the text to the explorer's own search over every drive. */
export const everywhereResult = (text: string, to: Hand = toMain): PaletteResult => ({
  key: 'files:everywhere',
  category: 'files',
  title: `Search everywhere for "${text}"`,
  detail: 'Every drive, in the explorer',
  glyph: 'search',
  matched: true,
  pinLast: true,
  run: () => to.searchEverywhere(text),
});

/**
 * The near roots, in the order they are worth spending the 250 ms on.
 *
 * ⛔ **Order is the whole function, and it is what fixed "the palette can't find a file I know
 * exists".** `find_files` searches roots *sequentially* against one shared deadline and gives up
 * where the budget runs out, so a root's position decides whether it is looked at at all. This
 * used to be `[...recentFolders, ...knownFolders]`, and Joy's `recentFolders` holds four **drive
 * roots** — `E:\`, `G:`, `G:\`, `C:\` — because he navigates to drive roots and they get
 * remembered like any other folder. `C:\` came up as root #8 and ate the remaining ~180–210 ms
 * without finishing (`C:\` at depth 4 is 24,426 entries / 240–269 ms), so Desktop, Downloads,
 * Documents, Pictures, Music and Videos — positions 13–18 — were scanned **zero** entries in
 * every run. Measured: those six cost 20 ms at depth 4. They were never expensive, they were
 * queued behind a drive.
 *
 * So: known folders first — they are the cheapest and the likeliest — then the recents.
 *
 * ⛔ And **no drive root in the near pass at all**. The wide pass below already walks every
 * drive with its own 900 ms; a drive here is pure duplicated waste that starves the tail. Both
 * spellings have to go: `C:\` with a separator and `G:` without one, which is how it really
 * appears in his settings — `isRootPath` accepts either, and `/` and a distro root (the wide
 * pass walks every running distro) with them.
 *
 * ⚠️ UNC WSL recents below the distro root (`\\wsl.localhost\<distro>\…`) are **kept**. They
 * cost 25–39 ms each just to `is_dir`, but they are real folders Joy was recently in and the
 * wide pass only runs when the near pass returns fewer than `FILES_NEAR_ENOUGH` hits — so
 * dropping them here would make a recently-visited WSL folder unfindable for exactly the common
 * queries that fill 20 slots locally. With the known folders ahead of them their cost no longer
 * delays anything that matters.
 *
 * Deduped by `folderKey` — case-insensitively on Windows only, a trailing separator ignored —
 * because a known folder Joy navigated to is in both lists and searching it twice is the same
 * wasted budget in miniature. ⛔ Not by case on Linux, where `/data` and `/Data` are two folders.
 */
const nearRoots = (vague: Set<string> = new Set()): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  const last: string[] = [];
  // off Windows a drive is `/` or a mount (`/media/…`); the wide pass owns those too
  const drives = new Set(places.drives.map((d) => folderKey(d.path)));
  for (const path of [...places.knownFolders.map((f) => f.path), ...settings.recentFolders]) {
    const key = folderKey(path);
    if (isRootPath(path) || drives.has(key) || seen.has(key)) continue;
    seen.add(key);
    // ⛔ the home folder walks last: it is the widest root, so it must not eat the budget the
    // specific folders (a recent under /tmp) need; the index normally covers it and drops it
    (vague.has(key) ? last : out).push(path);
  }
  return [...out, ...last];
};

/** Whether `path` is `root` or inside it, by `folderKey`. */
const isWithin = (path: string, root: string) => {
  const key = folderKey(path);
  const top = folderKey(root);
  const sep = onWindows() ? '\\' : '/';
  return key === top || key.startsWith(top.endsWith(sep) ? top : top + sep);
};

/** Folders that hold tool caches, not anything a person made. */
const CACHE_FOLDERS = new Set([
  'node_modules',
  'cache',
  'caches',
  '.cache',
  'appdata',
  'coresimulator',
]);

/**
 * How many names the index is asked for. ⛔ Not the 20 shown: Rust ranks by name tier then path
 * length, so `readme` fills its first 20 with dot-folder READMEs and a user README below them
 * never reached `rankFiles` (BUG-S2). Rust now ranks those last itself; 200 leaves `rankFiles`
 * room to judge the rest. The scan is the same one; the cost is 200 `stat`s instead of 20.
 */
const INDEX_FETCH = 200;

/** The name minus its extension is the text: `note-1.txt` for `note-1`, ahead of `note-10.txt`. */
const stemIs = (name: string, text: string) => {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase() === text.trim().toLowerCase();
};

/**
 * Whether `path` sits in a dot-folder or a known cache folder (`.vscode`, `.bun`, `node_modules`,
 * `AppData`), judged by the folders above the file, never its own name — and only the folders
 * below the deepest of `near` that holds it: a folder the person opened is theirs, so a recent
 * under `%TEMP%` (`AppData\Local\Temp\…`) is not a cache path, while `AppData\Roaming` is.
 */
const inCacheFolder = (path: string, near: string[]) => {
  const segments = (p: string) => p.split(/[\\/]/).filter(Boolean);
  // how many leading folders belong to the deepest near root holding the file
  const skip = near
    .filter((r) => isWithin(path, r))
    .reduce((n, r) => Math.max(n, segments(r).length), 0);
  const parts = segments(path).slice(skip, -1);
  return parts.some(
    (p) => (p.startsWith('.') && p.length > 1) || CACHE_FOLDERS.has(p.toLowerCase()),
  );
};

/**
 * Index hits and near-folder hits as one list, best first: every non-cache hit above every cache
 * hit (dot-folders, `node_modules`, `AppData`), whatever its match level; inside each group how
 * well the name answers the text (a name whose stem is the text, exact included, > word > prefix >
 * any), then files in a recent / pinned / known folder above the rest (the most recently opened
 * recent first, then the deeper folder, pinned and known after the recents), then the order they
 * came in.
 * The two halves used to be separate lists, so the index's 20 slots were full before a recent
 * folder was asked.
 */
const rankFiles = (
  hits: FileEntry[],
  text: string,
  near: NearRoot[],
  vague: Set<string> = new Set(),
): FileEntry[] => {
  const roots = near.filter((r) => !isRootPath(r.path) && !vague.has(folderKey(r.path)));
  const folders = near.map((r) => r.path);
  return hits
    .map((e, i) => {
      // the most recently opened holding root wins, then the deepest, then the stronger kind of
      // root (current > recent > pinned); a pinned or known folder is never recent (Infinity)
      let depth = 0;
      let kind = 0;
      let recency = Infinity;
      for (const r of roots) {
        if (!isWithin(e.path, r.path)) continue;
        const d = r.path.split(/[\\/]/).filter(Boolean).length;
        if (
          depth === 0 ||
          r.recency < recency ||
          (r.recency === recency && (d > depth || (d === depth && r.kind > kind)))
        ) {
          depth = d;
          kind = r.kind;
          recency = r.recency;
        }
      }
      const boosted = depth > 0;
      return {
        e,
        i,
        stem: stemIs(e.name, text) ? 1 : 0,
        // an exact name is a stem match too, so the two share one rung and keep the index order
        score: stemIs(e.name, text) ? 0 : matchScore(e.name, text),
        cache: inCacheFolder(e.path, folders) ? 1 : 0,
        boosted: boosted ? 1 : 0,
        recency,
        depth,
        kind,
      };
    })
    .sort(
      (a, b) =>
        a.cache - b.cache ||
        b.stem - a.stem ||
        b.score - a.score ||
        b.boosted - a.boosted ||
        // not a subtraction: Infinity - Infinity is NaN, which would break the tie
        Number(a.recency > b.recency) - Number(a.recency < b.recency) ||
        b.depth - a.depth ||
        b.kind - a.kind ||
        a.i - b.i,
    )
    .map((x) => x.e);
};

/** A folder the rank may boost for, and how much it counts on a tie: current > recent > pinned. */
type NearRoot = { path: string; kind: number; recency: number };

/**
 * The 2.6 provider. First Trove's own name index (plan 21C.1, 21C.2a: the home folder and every
 * fixed drive, every depth, from memory — a root still filling is reported to the footer and
 * walked as before); then, bounded, the near roots the index does not hold (known folders +
 * recents, 4 deep, 250 ms) and — when those give fewer than `FILES_NEAR_ENOUGH` hits — every
 * drive root (4 deep, 900 ms). While the index is still on its first walk it answers
 * `ready: false` and the walks run exactly as before. The last row hands the whole search to
 * the explorer.
 */
/** When the index was last asked to refresh its WSL snapshots (`Date.now()`). */
let wslAskedAt = -Infinity;
const WSL_ASK_EVERY_MS = 60_000;

const filesSource = (to: Hand): PaletteSource => ({
  key: 'files',
  query: async (text) => {
    const t = text.trim();
    if (t.length < 2) return [];
    // one `wsl.exe` ask per query, shared by the index refresh and the drive walk below
    let runningAsk: Promise<string[]> | null = null;
    const runningDistros = () => (runningAsk ??= wslRunningDistros().catch(() => [] as string[]));
    // ⛔ only the running distros: a snapshot of a stopped one would boot it (plan 21C.4b)
    if (Date.now() - wslAskedAt >= WSL_ASK_EVERY_MS) {
      wslAskedAt = Date.now();
      void runningDistros()
        .then((r) => (r.length > 0 ? indexWsl(r) : undefined))
        .catch(() => {});
    }
    await placesReady();
    const indexed = await indexSearch(t, INDEX_FETCH).catch((e: unknown) => {
      logError('palette.indexSearch', e);
      return null;
    });
    if (indexed) indexProgress.set(indexed.filling ?? []);
    const covered = indexed?.ready ? indexed.roots : [];
    // the index already holds every name under these, deeper than any walk goes
    // ⛔ the home folder and the profile hold everything, so being under one says nothing: they
    // give no boost (a recent /Users/alex made every home README 'near' and the tie never broke)
    const vague = new Set(
      [await userProfile().catch(() => null), ...covered]
        .filter((p) => !!p)
        .map((p) => folderKey(p!)),
    );
    const near = nearRoots(vague).filter((r) => !covered.some((c) => isWithin(r, c)));
    // ⛔ a search that fails is logged and costs its own hits only: the row that hands the
    // whole thing to the explorer is the one thing this source must always offer
    const search = (roots: string[], max: number, budget: number) =>
      spotlightFiles(t, roots, max, budget, 4).catch((e: unknown) => {
        logError('palette.spotlightFiles', e);
        return [] as FileEntry[];
      });
    let hits: FileEntry[] = indexed?.ready ? [...indexed.hits] : [];
    // ⛔ always, not only while the index gave fewer than 20: `note-` fills all 20 index slots with
    // home caches (`.vscode`, `.bun`) and the recent folder's own notes were never searched. The
    // walk is bounded as it always was; `rankFiles` below merges both lists into one order.
    if (near.length > 0) {
      const seen = new Set(hits.map((h) => pathKey(h.path)));
      for (const e of await search(near, 20, 250)) if (!seen.has(pathKey(e.path))) hits.push(e);
    }
    // recents keep their order (index 0 = the most recent) and rank first; pinned and known
    // folders have no recency (Infinity), so they come after every recent
    const recent = new Map(settings.recentFolders.map((f, i) => [folderKey(f), i] as const));
    const boostRoots: NearRoot[] = [
      ...nearRoots(vague).map((path) => {
        const at = recent.get(folderKey(path));
        return { path, kind: at === undefined ? 1 : 2, recency: at ?? Infinity };
      }),
      ...settings.pins.map((path) => ({ path, kind: 1, recency: Infinity })),
    ];
    hits = rankFiles(hits, t, boostRoots, vague).slice(0, 20);
    if (hits.length < FILES_NEAR_ENOUGH && places.drives.length > 0) {
      // every local drive, plus the running distros' shares (a stopped one is never started
      // here). ⛔ Not a network share: walking one nobody opened raises macOS's network-volume
      // prompt (`core/mounts.rs`).
      const running = await runningDistros();
      // a drive the index holds whole is not walked again (plan 21C.2a); one still filling is
      const local = places.drives.filter(
        (d) => !d.network && !covered.some((c) => folderKey(c) === folderKey(d.path)),
      );
      const wide = await search(
        [...local.map((d) => d.path), ...running.map(wslRootFor)],
        20 - hits.length,
        900,
      );
      // ⛔ by `pathKey`: folding case on Linux would drop a real `Report.txt` beside `report.txt`
      const seen = new Set(hits.map((h) => pathKey(h.path)));
      // the cap is per drive in Rust (`find_files`), so the 20 is held here
      for (const e of wide) if (hits.length < 20 && !seen.has(pathKey(e.path))) hits.push(e);
    }
    return [
      ...hits.map((e) => fileResult(to, `file:${e.path}`, e, 'files')),
      everywhereResult(t, to),
    ];
  },
});

/**
 * The last thing offered on every query, when nothing on this machine was what was wanted.
 * Unconditional and `pinLast`, exactly like `everywhereResult` — a second row in a position
 * Joy already reads rather than a new prefix idiom to learn.
 *
 * ⭐ No browser is named, detected or required. `spotlightSearchTemplate` holds a search
 * ENGINE (a URL, Google by default); which browser opens it is the OS's own default-handler
 * association, which is why the detail line promises exactly that and nothing more.
 *
 * `openUrlFromPalette` owns the whole act-then-hide: it opens, surfaces a failure through
 * `spotlight:open-failed` (the palette has its own JS realm and cannot toast directly), and
 * hides in a `finally`. That is why there is no try/catch and no second `hidePalette` here.
 */
const webSource: PaletteSource = {
  key: 'web',
  query: async (text) => {
    const t = text.trim();
    if (!t) return [];
    return [
      {
        key: 'web:search',
        category: 'web',
        title: `Search the web for "${t}"`,
        detail: 'Opens in your default browser',
        glyph: 'search',
        matched: true,
        pinLast: true,
        run: () => openUrlFromPalette(buildSearchUrl(settings.spotlightSearchTemplate, t)),
      },
    ];
  },
};

/**
 * Every source, acting through `target` when one is given (Find anything, a panel in an
 * explorer window: it acts on that window) or by `spotlight:*` event to the main window when
 * not (the Spotlight window).
 */
export const makePaletteSources = (target?: PaletteTarget): PaletteSource[] => {
  const to = target ? toTarget(target) : toMain;
  return [
    calcSource(to),
    actionsSource(to),
    pathSource(to),
    recentSource(to),
    placesSource(to),
    appsSource(to),
    filesSource(to),
    // after `filesSource`, so the two pinned rows keep keyboard order in step with what is drawn:
    // "Search everywhere" (category `files`) then this one (category `web`, the last group)
    webSource,
  ];
};

/** The Spotlight window's sources: every act goes to the main window. */
export const paletteSources: PaletteSource[] = makePaletteSources();

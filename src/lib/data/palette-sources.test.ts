import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexAnswer } from '$lib/api/palette';
import { indexProgress } from '$lib/state/index-progress.svelte';
import { places } from '$lib/state/places.svelte';
import { settings } from '$lib/state/settings.svelte';
import { wsl } from '$lib/state/wsl.svelte';
import type { FileEntry } from '$lib/types/fs';
import type { AppEntry, PaletteSource } from '$lib/types/palette';

const apps = vi.fn<() => Promise<AppEntry[]>>(async () => []);
const files = vi.fn<
  (
    text: string,
    roots: string[],
    max: number,
    budget: number,
    depth: number,
  ) => Promise<FileEntry[]>
>(async () => []);
const NOT_READY: IndexAnswer = { ready: false, roots: [], hits: [], total: 0 };
const indexed = vi.fn<(text: string, max: number) => Promise<IndexAnswer>>(async () => NOT_READY);
const launchApp = vi.fn<(aumid: string) => Promise<void>>(async () => {});
const openPath = vi.fn<(path: string) => Promise<void>>(async () => {});

vi.mock('$lib/api/palette', () => ({
  emitAction: vi.fn(),
  emitNavigate: vi.fn(),
  emitReveal: vi.fn(),
  emitSearch: vi.fn(),
  hidePalette: vi.fn(async () => {}),
  indexSearch: (text: string, max: number) => indexed(text, max),
  indexWsl: vi.fn(async () => {}),
  launchApp: (a: string) => launchApp(a),
  openUrlFromPalette: vi.fn(),
  showMain: vi.fn(async () => {}),
  spotlightApps: () => apps(),
  spotlightFiles: (text: string, roots: string[], max: number, budget: number, depth: number) =>
    files(text, roots, max, budget, depth),
}));
vi.mock('$lib/api/fs', () => ({
  openPath: (p: string) => openPath(p),
  openUrl: vi.fn(),
  readDir: vi.fn(async () => []),
}));
vi.mock('$lib/api/clipboard', () => ({ clipboardWriteText: vi.fn() }));
vi.mock('$lib/api/recent', () => ({ recentFiles: vi.fn(async () => []) }));
vi.mock('$lib/api/shell', () => ({ userProfile: vi.fn(async () => 'C:\\Users\\alex') }));
const wslHome = vi.fn<(name: string, uid: number) => Promise<string>>(
  async (name) => `\\\\wsl.localhost\\${name}\\home\\alex`,
);
vi.mock('$lib/api/wsl', () => ({
  wslRunningDistros: vi.fn(async () => []),
  wslHome: (name: string, uid: number) => wslHome(name, uid),
}));
vi.mock('$lib/api/log', () => ({ logError: vi.fn() }));

const { makePaletteSources, paletteSources } = await import('./palette-sources');
const { emitAction, emitNavigate, emitReveal, emitSearch, hidePalette, showMain } =
  await import('$lib/api/palette');
const { recentFiles } = await import('$lib/api/recent');
const { readDir } = await import('$lib/api/fs');

const sourceNamed = (key: string) => {
  const found = paletteSources.find((s) => s.key === key);
  if (!found) throw new Error(`no ${key} source`);
  return found;
};
const appsSource = () => sourceNamed('apps');

/**
 * The two row shapes of `AppEntry`.
 *
 * Joy's "the supersearch can't find anything on the machine. it missed calculator" was the
 * second shape never being drawn at all: an app that exists only as an `AppsFolder` id, which
 * is every Store app and every ID-list-only shortcut `parse_lnk` cannot resolve. 86 of this
 * machine's 173 apps are that shape.
 */
describe('the apps source', () => {
  beforeEach(() => {
    apps.mockReset();
    launchApp.mockReset();
    openPath.mockReset();
    vi.mocked(hidePalette).mockClear();
  });

  it('every launch path closes Spotlight: shortcut, app id, and a launch that failed', async () => {
    const lnk = {
      name: 'Zed',
      lnkPath: 'C:\\Start\\Zed.lnk',
      target: '',
      aumid: '',
      openWith: null,
      path: '',
    };
    const byId = {
      name: 'vim',
      lnkPath: '',
      target: '',
      aumid: 'vim.desktop',
      openWith: null,
      path: '/usr/share/applications/vim.desktop',
    };
    apps.mockResolvedValue([lnk, byId]);
    const [a, b] = await appsSource().query('');
    await a.run();
    expect(hidePalette).toHaveBeenCalledTimes(1);
    await b.run();
    expect(hidePalette).toHaveBeenCalledTimes(2);
    launchApp.mockRejectedValueOnce(new Error('refused for a terminal app'));
    await expect(b.run()).rejects.toThrow('refused');
    expect(hidePalette).toHaveBeenCalledTimes(3);
  });

  it('an app with a shortcut opens the shortcut and can be revealed', async () => {
    apps.mockResolvedValue([
      {
        name: 'Zed',
        lnkPath: 'C:\\Start\\Zed.lnk',
        target: 'C:\\App\\zed.exe',
        aumid: '',
        openWith: null,
        path: 'C:\\App\\zed.exe',
      },
    ]);
    const [row] = await appsSource().query('zed');
    expect(row.key).toBe('app:C:\\Start\\Zed.lnk');
    expect(row.iconKey).toBe('file/C:\\Start\\Zed.lnk');
    expect(row.reveal).toBeTypeOf('function');
    await row.run();
    expect(openPath).toHaveBeenCalledWith('C:\\Start\\Zed.lnk');
    expect(launchApp).not.toHaveBeenCalled();
  });

  it('a Store app has no shortcut, so it launches by app id and offers no Reveal', async () => {
    const aumid = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App';
    apps.mockResolvedValue([
      { name: 'Calculator', lnkPath: '', target: '', aumid, openWith: null, path: '' },
    ]);
    const [row] = await appsSource().query('calc');
    expect(row.title).toBe('Calculator');
    expect(row.key).toBe(`app:${aumid}`);
    // the icon route's kind is `app/`, and `app:` is the spelling this already got wrong once:
    // it would 404 silently and the row would draw blank rather than error
    expect(row.iconKey).toBe(`app/${aumid}`);
    // nothing on disk to show — an explorer window on WindowsApps is not where it lives
    expect(row.reveal).toBeUndefined();
    await row.run();
    expect(launchApp).toHaveBeenCalledWith(aumid);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('an app found by both sources keeps both, and the shortcut wins', async () => {
    apps.mockResolvedValue([
      {
        name: 'Terminal',
        lnkPath: 'C:\\Start\\Terminal.lnk',
        target: 'C:\\App\\wt.exe',
        aumid: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App',
        openWith: null,
        path: 'C:\\App\\wt.exe',
      },
    ]);
    const [row] = await appsSource().query('term');
    // the cached shell icon and the plain shortcut are both cheaper than a namespace lookup
    expect(row.iconKey).toBe('file/C:\\Start\\Terminal.lnk');
    await row.run();
    expect(openPath).toHaveBeenCalledWith('C:\\Start\\Terminal.lnk');
    expect(launchApp).not.toHaveBeenCalled();
  });

  it('a Mac app launches by its bundle, draws the bundle icon and reveals the bundle', async () => {
    const bundle = '/Applications/Calculator.app';
    apps.mockResolvedValue([
      { name: 'Calculator', lnkPath: '', target: '', aumid: bundle, openWith: null, path: bundle },
    ]);
    const [row] = await appsSource().query('calc');
    expect(row.key).toBe(`app:${bundle}`);
    expect(row.iconKey).toBe(`file/${bundle}`);
    expect(row.reveal).toBeTypeOf('function');
    await row.run();
    expect(launchApp).toHaveBeenCalledWith(bundle);
    expect(openPath).not.toHaveBeenCalled();
    await row.reveal?.();
    expect(emitReveal).toHaveBeenCalled();
  });

  it('an Ubuntu app launches by desktop id, draws its theme icon and reveals the .desktop file', async () => {
    const id = 'org.gnome.Calculator.desktop';
    const path = '/usr/share/applications/org.gnome.Calculator.desktop';
    apps.mockResolvedValue([
      { name: 'Calculator', lnkPath: '', target: '', aumid: id, openWith: null, path },
    ]);
    const [row] = await appsSource().query('calc');
    expect(row.iconKey).toBe(`file/${path}`);
    expect(row.glyph).toBeUndefined();
    expect(row.reveal).toBeTypeOf('function');
    await row.run();
    expect(launchApp).toHaveBeenCalledWith(id);
  });
});

/**
 * ⛔ The bug: *"the palette can't find a file I know exists."*
 * `C:\Users\alex\Downloads\Telegram Desktop\Quarterly Review.pptx` returned **0 rows** for
 * `Quarterly Review` — near pass 267 ms → 0 hits, wide pass 495 ms → 0 hits (from `C:\`
 * that file is depth 5, one past the limit).
 *
 * The cause is the ORDER of the near roots, not the budget. `recentFolders` came first and
 * Joy's contains four **drive roots** — `E:\`, `G:`, `G:\`, `C:\` — because he navigates to
 * drive roots and they get remembered like any other folder. `C:\` was reached as root #8 and
 * absorbed the remaining ~180–210 ms of the 250 ms budget without finishing (full `C:\` at
 * depth 4 is 24,426 entries / 240–269 ms), then `find_files` gave up. Desktop, Downloads,
 * Documents, Pictures, Music and Videos sat at positions 13–18 and were scanned **zero**
 * entries, in every run. Measured: those six cost 20 ms at depth 4. They were not expensive,
 * they were queued behind a drive.
 *
 * Worse for common queries: `readme` filled all 20 slots from `G:\01_tauri` in 16 ms, so the
 * near pass cleared `FILES_NEAR_ENOUGH` and the wide pass never ran at all — nothing under
 * Desktop/Downloads/Documents could appear for any such query, ever.
 *
 * So this pins the ordering contract, not a timing: known folders first, then recents, and no
 * drive root in the near list at all (the wide pass already owns every drive).
 */
describe('the files source near pass', () => {
  const DESKTOP = 'C:\\Users\\alex\\Desktop';
  const DOWNLOADS = 'C:\\Users\\alex\\Downloads';
  const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\alex';
  const filesSource = () => sourceNamed('files');

  beforeEach(() => {
    files.mockReset();
    files.mockResolvedValue([]);
    // `load()` skips on this, so the mocked `$lib/api/shell` is never asked for places
    places.loaded = true;
    places.drives = [];
    places.knownFolders = [
      { key: 'desktop', label: 'Desktop', path: DESKTOP },
      { key: 'downloads', label: 'Downloads', path: DOWNLOADS },
    ];
    settings.recentFolders = [];
  });

  it('searches the known folders before the recents, and no drive root', async () => {
    // Joy's real list, shape for shape: drive roots scattered through it, `G:` spelled with no
    // trailing separator, two UNC WSL shares, and `E:\WINDOWS` for good measure
    settings.recentFolders = [
      'G:\\01_tauri\\trove',
      'E:\\',
      'E:\\WINDOWS',
      'G:\\01_tauri',
      'G:',
      WSL_HOME,
      'G:\\',
      'C:\\',
      'E:\\WINDOWS\\Logs',
    ];

    await filesSource().query('Quarterly Review');

    expect(files).toHaveBeenCalledTimes(1);
    const [text, roots, max, budget, depth] = files.mock.calls[0];
    expect(text).toBe('Quarterly Review');
    expect(roots).toEqual([
      DESKTOP,
      DOWNLOADS,
      'G:\\01_tauri\\trove',
      'E:\\WINDOWS',
      'G:\\01_tauri',
      WSL_HOME,
      'E:\\WINDOWS\\Logs',
    ]);
    // both spellings of a drive root are gone — `C:\` with a separator and `G:` without
    expect(roots).not.toContain('C:\\');
    expect(roots).not.toContain('G:');
    expect(roots).not.toContain('G:\\');
    expect(roots).not.toContain('E:\\');
    // and the budget the responsiveness guarantee rests on is untouched
    expect([max, budget, depth]).toEqual([20, 250, 4]);
  });

  it('skips `/` and any listed drive in the near pass, keeps other mounts', async () => {
    places.drives = [{ path: '/media/alex/DATADRIVE', label: 'Z', totalBytes: 0, freeBytes: 0 }];
    settings.recentFolders = ['/', '/media/alex/DATADRIVE', '/mnt/data', '/home/alex/src'];

    await filesSource().query('report');

    const [, roots] = files.mock.calls[0];
    expect(roots).toEqual([DESKTOP, DOWNLOADS, '/mnt/data', '/home/alex/src']);
  });

  it('does not search a folder twice when a recent repeats a known folder', async () => {
    settings.recentFolders = [DOWNLOADS, 'G:\\01_tauri', 'c:\\users\\alex\\desktop'];

    await filesSource().query('report');

    const [, roots] = files.mock.calls[0];
    expect(roots).toEqual([DESKTOP, DOWNLOADS, 'G:\\01_tauri']);
  });

  it('still hands every drive to the wide pass, which is what owns them', async () => {
    settings.recentFolders = ['C:\\', 'G:\\01_tauri'];
    places.drives = [
      { path: 'C:\\', label: 'OS', totalBytes: 0, freeBytes: 0 },
      { path: 'G:\\', label: 'Data', totalBytes: 0, freeBytes: 0 },
    ];

    await filesSource().query('Quarterly Review');

    // near returned 0 hits, under FILES_NEAR_ENOUGH, so the wide pass runs
    expect(files).toHaveBeenCalledTimes(2);
    expect(files.mock.calls[0][1]).toEqual([DESKTOP, DOWNLOADS, 'G:\\01_tauri']);
    expect(files.mock.calls[1][1]).toEqual(['C:\\', 'G:\\']);
    expect(files.mock.calls[1][3]).toBe(900);
  });

  it('leaves a network share out of the wide pass', async () => {
    settings.recentFolders = [];
    places.drives = [
      { path: '/', label: 'Mac', totalBytes: 0, freeBytes: 0 },
      { path: '/Volumes/media', label: 'media', totalBytes: null, freeBytes: null, network: true },
    ];

    await filesSource().query('report');

    expect(files).toHaveBeenCalledTimes(2);
    expect(files.mock.calls[1][1]).toEqual(['/']);
  });

  it('skips a WSL distro root like a drive, keeps the folders below it', async () => {
    settings.recentFolders = ['\\\\wsl.localhost\\Ubuntu', '\\\\wsl$\\Debian\\', WSL_HOME];

    await filesSource().query('report');

    const [, roots] = files.mock.calls[0];
    expect(roots).toEqual([DESKTOP, DOWNLOADS, WSL_HOME]);
  });
});

/**
 * Plan 21C.1d: Trove's own name index holds the home folder at every depth, so the palette asks
 * it first and walks only the near roots it does not hold. While its first walk runs it says
 * `ready: false`, and the walks run exactly as before.
 */
describe('the files source with the name index', () => {
  const HOME = 'C:\\Users\\alex';
  const DESKTOP = `${HOME}\\Desktop`;
  const OUTSIDE = 'G:\\01_tauri\\trove';
  const filesSource = () => sourceNamed('files');
  const hit = (path: string) =>
    ({ name: path.slice(path.lastIndexOf('\\') + 1), path, isDir: false }) as FileEntry;

  beforeEach(() => {
    files.mockReset();
    files.mockResolvedValue([]);
    indexed.mockReset();
    indexed.mockResolvedValue(NOT_READY);
    places.loaded = true;
    places.drives = [{ path: 'C:\\', label: 'OS', totalBytes: 0, freeBytes: 0 }];
    places.knownFolders = [{ key: 'desktop', label: 'Desktop', path: DESKTOP }];
    settings.recentFolders = [OUTSIDE];
    settings.pins = [];
  });

  it('filesSource uses index hits and still walks uncovered roots', async () => {
    const deep = `${HOME}\\a\\b\\c\\d\\e\\f\\deep-report.txt`;
    indexed.mockResolvedValue({ ready: true, roots: [HOME], hits: [hit(deep)], total: 1 });
    files.mockResolvedValueOnce([hit(`${OUTSIDE}\\report.md`), hit(deep)]);

    const rows = await filesSource().query('report');

    expect(indexed).toHaveBeenCalledWith('report', 200);
    // Desktop is inside the indexed home: not walked; the G: folder is
    expect(files.mock.calls[0][1]).toEqual([OUTSIDE]);
    expect(files.mock.calls[0][2]).toBe(20);
    // ranked together: `report.md` starts with the text, `deep-report.txt` only contains a word
    // of it; the walk's copy of the same file is dropped
    expect(rows.map((r) => r.key)).toEqual([
      `file:${OUTSIDE}\\report.md`,
      `file:${deep}`,
      'files:everywhere',
    ]);
  });

  it('twenty index hits do not hide a recent folder, and a cache file ranks under it', async () => {
    const caches = Array.from({ length: 20 }, (_, i) => hit(`${HOME}\\.vscode\\note-${i}.json`));
    indexed.mockResolvedValue({ ready: true, roots: [HOME], hits: caches, total: 300 });
    const mine = `${OUTSIDE}\\note-mine.md`;
    files.mockResolvedValueOnce([hit(mine)]);

    const rows = await filesSource().query('note-');

    expect(files).toHaveBeenCalledTimes(1);
    expect(rows[0].key).toBe(`file:${mine}`);
    expect(rows.slice(1, 20).every((r) => r.key.includes('.vscode'))).toBe(true);
    expect(rows).toHaveLength(21);
  });

  it('an exact name in a cache folder ranks below a word match in a recent folder', async () => {
    // replaces "a cache exact match still beats a recent-folder partial match": now the opposite
    const cached = `${HOME}\\.bun\\README`;
    indexed.mockResolvedValue({ ready: true, roots: [HOME], hits: [hit(cached)], total: 1 });
    const mine = `${OUTSIDE}\\my-readme.md`;
    files.mockResolvedValueOnce([hit(mine)]);

    const rows = await filesSource().query('readme');

    expect(rows[0].key).toBe(`file:${mine}`);
    expect(rows[1].key).toBe(`file:${cached}`);
  });

  it('readme puts the recent folder readme.txt above twenty dot-folder README hits', async () => {
    const dots = Array.from({ length: 20 }, (_, i) =>
      hit(`${HOME}\\.${['bun', 'vscode', 'config'][i % 3]}\\p${i}\\README`),
    );
    indexed.mockResolvedValue({ ready: true, roots: [HOME], hits: dots, total: 300 });
    const mine = `${OUTSIDE}\\s2\\readme.txt`;
    files.mockResolvedValueOnce([hit(mine)]);

    const rows = await filesSource().query('readme');

    expect(rows[0].key).toBe(`file:${mine}`);
  });

  it('a home recent boosts nothing: the specific recent folder wins the stem tie', async () => {
    settings.recentFolders = [HOME, `${OUTSIDE}\\s`];
    const readmes = Array.from({ length: 12 }, (_, i) =>
      hit(`${HOME}\\Projects\\p${i}\\README.md`),
    );
    indexed.mockResolvedValue({ ready: true, roots: [HOME], hits: readmes, total: 12 });
    const mine = `${OUTSIDE}\\s\\readme.txt`;
    files.mockResolvedValueOnce([hit(mine)]);

    const rows = await filesSource().query('readme');

    expect(rows[0].key).toBe(`file:${mine}`);
    expect(files.mock.calls[0][1]).toEqual([`${OUTSIDE}\\s`]);
  });

  it('a home recent alone leaves the index order alone', async () => {
    settings.recentFolders = [HOME];
    const a = `${HOME}\\Documents\\README.md`;
    const b = `${HOME}\\Projects\\README.md`;
    indexed.mockResolvedValue({ ready: true, roots: [HOME], hits: [hit(a), hit(b)], total: 2 });

    const rows = await filesSource().query('readme');

    expect(rows.slice(0, 2).map((r) => r.key)).toEqual([`file:${a}`, `file:${b}`]);
  });

  it('the most recently opened recent folder wins, even when an older one is deeper', async () => {
    // recents keep their order: index 0 is the most recent
    settings.recentFolders = [`${OUTSIDE}\\s`, `${OUTSIDE}\\Projects\\deep\\er`];
    const older = `${OUTSIDE}\\Projects\\deep\\er\\x\\README`;
    const newest = `${OUTSIDE}\\s\\readme.txt`;
    files.mockResolvedValueOnce([hit(older), hit(newest)]);

    const rows = await filesSource().query('readme');

    expect(rows[0].key).toBe(`file:${newest}`);
  });

  it('a bare README and readme.txt in one folder keep the order they came in', async () => {
    settings.recentFolders = [`${OUTSIDE}\\s`];
    const a = `${OUTSIDE}\\s\\readme.txt`;
    const b = `${OUTSIDE}\\s\\README`;
    files.mockResolvedValueOnce([hit(a), hit(b)]);

    const rows = await filesSource().query('readme');

    expect(rows.slice(0, 2).map((r) => r.key)).toEqual([`file:${a}`, `file:${b}`]);
  });

  it('a deeper folder wins only between equally recent ones (pinned)', async () => {
    settings.recentFolders = [];
    settings.pins = [`${OUTSIDE}`, `${OUTSIDE}\\deep\\er`];
    const shallow = `${OUTSIDE}\\readme.txt`;
    const deep = `${OUTSIDE}\\deep\\er\\readme.txt`;
    // a pin is only a boost, never walked: the hits come from the index
    indexed.mockResolvedValue({
      ready: true,
      roots: [HOME],
      hits: [hit(shallow), hit(deep)],
      total: 2,
    });

    const rows = await filesSource().query('readme');

    expect(rows[0].key).toBe(`file:${deep}`);
  });

  it('asks the index for 200 so a user file below its dot-folder top 20 still reaches the rank', async () => {
    const dots = Array.from({ length: 199 }, (_, i) => hit(`${HOME}\\.cargo\\p${i}\\README`));
    const mine = `${HOME}\\Documents\\work\\README`;
    indexed.mockImplementation(async (_t, max) => ({
      ready: true,
      roots: [HOME],
      hits: [...dots, hit(mine)].slice(0, max),
      total: 900,
    }));

    const rows = await filesSource().query('readme');

    expect(indexed).toHaveBeenCalledWith('readme', 200);
    expect(rows[0].key).toBe(`file:${mine}`);
    expect(rows).toHaveLength(21);
  });

  it('a recent folder under %TEMP% (AppData) is not a cache path', async () => {
    const temp = `${HOME}\\AppData\\Local\\Temp\\claude\\s2`;
    settings.recentFolders = [temp];
    const dots = Array.from({ length: 20 }, (_, i) => hit(`${HOME}\\.vscode\\p${i}\\README`));
    // the index holds AppData too, so the recent is not walked: the index gives its file
    indexed.mockResolvedValue({
      ready: true,
      roots: [HOME],
      hits: [...dots, hit(`${temp}\\readme1.txt`), hit(`${HOME}\\AppData\\Roaming\\x\\README`)],
      total: 300,
    });

    const rows = await filesSource().query('readme');

    // only a word match, yet above every dot-folder README: the AppData above it is the recent's
    expect(rows[0].key).toBe(`file:${temp}\\readme1.txt`);
    // AppData outside that recent folder is still a cache path
    expect(rows.slice(1, 20).every((r) => !r.key.includes('Roaming'))).toBe(true);
  });

  it('a README and a readme.txt share the top rung, in the order they came', async () => {
    indexed.mockResolvedValue({
      ready: true,
      roots: [HOME],
      hits: [hit(`${HOME}\\docs\\README`), hit(`${HOME}\\docs\\readme.txt`)],
      total: 2,
    });

    const rows = await filesSource().query('readme');

    expect(rows.slice(0, 2).map((r) => r.key)).toEqual([
      `file:${HOME}\\docs\\README`,
      `file:${HOME}\\docs\\readme.txt`,
    ]);
  });

  it('a name whose stem is the text ranks first, and CoreSimulator is a cache path', async () => {
    const sim = `${HOME}\\Library\\Developer\\CoreSimulator\\sub2.plist`;
    indexed.mockResolvedValue({
      ready: true,
      roots: [HOME],
      hits: [hit(`${HOME}\\note-10.txt`), hit(`${HOME}\\note-11.txt`), hit(`${HOME}\\note-1.txt`)],
      total: 3,
    });
    let rows = await filesSource().query('note-1');
    expect(rows[0].key).toBe(`file:${HOME}\\note-1.txt`);

    indexed.mockResolvedValue({
      ready: true,
      roots: [HOME],
      hits: [hit(sim)],
      total: 1,
    });
    files.mockResolvedValueOnce([hit(`${OUTSIDE}\\sub2.md`)]);
    rows = await filesSource().query('sub2');
    expect(rows[0].key).toBe(`file:${OUTSIDE}\\sub2.md`);
  });

  it('enough index hits and no near root left: no walk at all', async () => {
    settings.recentFolders = [];
    const many = Array.from({ length: 20 }, (_, i) => hit(`${HOME}\\n${i}.txt`));
    indexed.mockResolvedValue({ ready: true, roots: [HOME], hits: many, total: 300 });

    const rows = await filesSource().query('note');

    expect(files).not.toHaveBeenCalled();
    expect(rows).toHaveLength(21);
  });

  it('falls back to the walks while the index is still building, or failed', async () => {
    await filesSource().query('report');
    expect(files.mock.calls[0][1]).toEqual([DESKTOP, OUTSIDE]);
    expect(files.mock.calls[0][2]).toBe(20);

    files.mockClear();
    indexed.mockRejectedValueOnce(new Error('no such command'));
    await filesSource().query('report');
    expect(files.mock.calls[0][1]).toEqual([DESKTOP, OUTSIDE]);
  });

  it('a drive the index holds is not walked again; one still filling is, and the footer hears', async () => {
    settings.recentFolders = [];
    places.drives = [
      { path: 'C:\\', label: 'OS', totalBytes: 0, freeBytes: 0 },
      { path: 'D:\\', label: 'Data', totalBytes: 0, freeBytes: 0 },
    ];
    const filling = [{ label: 'D:', seen: 412000 }];
    indexed.mockResolvedValue({ ready: true, roots: [HOME, 'C:\\'], hits: [], total: 0, filling });

    await filesSource().query('report');

    expect(files.mock.calls.at(-1)![1]).toEqual(['D:\\']);
    expect(indexProgress.filling).toEqual(filling);
    expect(indexProgress.label).toBe('indexing D: — 412,000 so far');

    // an answer from before 21C.2a has no `filling`: nothing is left showing
    indexed.mockResolvedValue({ ready: true, roots: [HOME], hits: [], total: 0 });
    await filesSource().query('report');
    expect(indexProgress.label).toBeNull();
  });

  it('stopped distro is never snapshotted: the index refresh gets only the running ones', async () => {
    const { indexWsl } = await import('$lib/api/palette');
    const { wslRunningDistros } = await import('$lib/api/wsl');
    vi.mocked(indexWsl).mockClear();
    vi.mocked(wslRunningDistros).mockResolvedValue(['Ubuntu']);
    wsl.distros = [
      { name: 'Ubuntu', uid: 1000 },
      { name: 'Debian', uid: 1000 },
    ] as typeof wsl.distros;
    wsl.loaded = true;
    // far past any earlier query's ask, so the 60 s gate is open
    const now = vi.spyOn(Date, 'now').mockReturnValue(4e15);
    try {
      await filesSource().query('report');
      // a second query inside the minute asks nothing more
      await filesSource().query('report');
      await vi.waitFor(() => expect(indexWsl).toHaveBeenCalled());
      expect(indexWsl).toHaveBeenCalledTimes(1);
      expect(vi.mocked(indexWsl).mock.calls[0][0]).toEqual(['Ubuntu']);
    } finally {
      now.mockRestore();
      vi.mocked(wslRunningDistros).mockResolvedValue([]);
      wsl.distros = [];
      wsl.loaded = false;
    }
  });
});

/** Plan 10, D.2: a Linux filesystem holds `/data` and `/Data`, `report.txt` and `Report.txt` apart. */
describe('the files source on Linux', () => {
  const filesSource = () => sourceNamed('files');
  const hit = (path: string) =>
    ({ name: path.slice(path.lastIndexOf('/') + 1), path, isDir: false }) as FileEntry;

  beforeEach(() => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' } });
    files.mockReset();
    files.mockResolvedValue([]);
    indexed.mockReset();
    indexed.mockResolvedValue(NOT_READY);
    places.loaded = true;
    places.drives = [{ path: '/', label: 'root', totalBytes: 0, freeBytes: 0 }];
    places.knownFolders = [];
    settings.recentFolders = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('searches two folders that differ only by case, once each', async () => {
    settings.recentFolders = ['/data', '/Data', '/data/'];

    await filesSource().query('report');

    expect(files.mock.calls[0][1]).toEqual(['/data', '/Data']);
  });

  it('readme: 200 dot-folder README index hits rank under a /tmp/claude-1000 recent folder', async () => {
    // BUG-S2 on Ubuntu, shape for shape: the index (home) answers with 200 dot-folder READMEs
    // first, as Rust ranks them by path length; the test folder is a recent outside home
    const s2 = '/tmp/claude-1000/-home-sam-trove/5f1c/scratchpad/s2';
    settings.recentFolders = [s2];
    const dots = Array.from({ length: 200 }, (_, i) =>
      hit(`/home/sam/.${['config', 'vscode', 'cargo'][i % 3]}/p${i}/README.md`),
    );
    indexed.mockResolvedValue({ ready: true, roots: ['/home/sam'], hits: dots, total: 900 });
    files.mockResolvedValueOnce([hit(`${s2}/readme1.txt`), hit(`${s2}/readme.txt`)]);

    const rows = await filesSource().query('readme');

    expect(files.mock.calls[0][1]).toEqual([s2]);
    expect(rows[0].key).toBe(`file:${s2}/readme.txt`);
    expect(rows[1].key).toBe(`file:${s2}/readme1.txt`);
    expect(rows).toHaveLength(21);
  });

  it('holds the wide pass to 20 rows now that Rust caps per drive', async () => {
    files.mockResolvedValueOnce(Array.from({ length: 30 }, (_, i) => hit(`/srv/report-${i}.txt`)));

    const rows = await filesSource().query('report');

    expect(rows).toHaveLength(21);
  });

  it('keeps a wide-pass file that differs from a near one only by case', async () => {
    settings.recentFolders = ['/home/alex'];
    files.mockResolvedValueOnce([hit('/home/alex/report.txt')]);
    files.mockResolvedValueOnce([hit('/home/alex/report.txt'), hit('/home/alex/Report.txt')]);

    const rows = await filesSource().query('report');

    expect(rows.map((r) => r.key)).toEqual([
      'file:/home/alex/report.txt',
      'file:/home/alex/Report.txt',
      expect.any(String),
    ]);
  });
});

describe('the places source, WSL rows', () => {
  it("opens the distro's home, as the sidebar does", async () => {
    places.loaded = true;
    places.drives = [];
    places.knownFolders = [];
    settings.pins = [];
    wsl.distros = [{ name: 'Ubuntu', uid: 1000 } as (typeof wsl.distros)[number]];
    wsl.loaded = true;
    const navigate = vi.fn();
    const sources = makePaletteSources({
      navigate,
      reveal: vi.fn(),
      searchEverywhere: vi.fn(),
      runAction: vi.fn(),
    });
    const rows = await sources.find((s) => s.key === 'places')!.query('');
    await rows.find((r) => r.key === 'wsl:Ubuntu')!.run();
    expect(wslHome).toHaveBeenCalledWith('Ubuntu', 1000);
    expect(navigate).toHaveBeenCalledWith('\\\\wsl.localhost\\Ubuntu\\home\\alex');
  });
});

describe('the places source, drive rows', () => {
  const drive = (path: string, label: string, bytes: number | null) => ({
    path,
    label,
    totalBytes: bytes,
    freeBytes: bytes,
  });
  const driveRows = async () =>
    (await sourceNamed('places').query('')).filter((r) => r.key.startsWith('drive:'));

  beforeEach(() => {
    places.loaded = true;
    places.knownFolders = [];
    settings.pins = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps `Label (C:)` on Windows, and omits space the OS would not give', async () => {
    places.drives = [drive('C:\\', 'Windows', 2 ** 30), drive('D:\\', 'Data', null)];
    const rows = await driveRows();
    expect(rows.map((r) => r.title)).toEqual(['Windows (C:)', 'Data (D:)']);
    expect(rows[0].detail).toContain('free of');
    expect(rows[1].detail).toBe('');
  });

  it('off Windows uses the label, or the mount path when there is none', async () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' } });
    places.drives = [drive('/media/alex/USB', 'USB', 2 ** 30), drive('/mnt/data', '', 2 ** 30)];
    expect((await driveRows()).map((r) => r.title)).toEqual(['USB', '/mnt/data']);
  });
});

/**
 * Where a result acts. The Spotlight window has no target and hands everything to the main
 * window by event; Find anything — a panel inside an explorer window, which may be a second one
 * (Ctrl+N) — hands its own window's bridge, and a folder must open THERE, not in the main window.
 */
describe('where a result acts', () => {
  const FOLDER = 'C:\\Users\\alex\\Projects';
  const FILE = 'C:\\Users\\alex\\notes.txt';
  const target = () => ({
    navigate: vi.fn(),
    reveal: vi.fn(),
    searchEverywhere: vi.fn(),
    runAction: vi.fn(),
  });
  const rowsFrom = async (sources: PaletteSource[], key: string, text = 'no') => {
    const s = sources.find((x) => x.key === key);
    if (!s) throw new Error(`no ${key} source`);
    return s.query(text);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    settings.recentFolders = [FOLDER];
    vi.mocked(recentFiles).mockResolvedValue([
      { name: 'notes.txt', path: FILE, isDir: false } as FileEntry,
    ]);
    places.loaded = true;
    places.drives = [];
    places.knownFolders = [];
    files.mockReset();
    files.mockResolvedValue([]);
  });

  it('a panel target gets the folder, the reveal, the search and the action — no event, no raise', async () => {
    const t = target();
    const sources = makePaletteSources(t);
    const [folder, file] = await rowsFrom(sources, 'recent');
    await folder.run();
    await folder.reveal?.();
    await file.reveal?.();
    expect(t.navigate).toHaveBeenCalledWith(FOLDER);
    expect(t.reveal).toHaveBeenNthCalledWith(1, FOLDER);
    expect(t.reveal).toHaveBeenNthCalledWith(2, FILE);

    const everywhere = (await rowsFrom(sources, 'files', 'notes')).at(-1);
    await everywhere?.run();
    expect(t.searchEverywhere).toHaveBeenCalledWith('notes');

    const [action] = await rowsFrom(sources, 'actions');
    await action.run();
    expect(t.runAction).toHaveBeenCalledWith(action.key.slice('action:'.length));

    expect(showMain).not.toHaveBeenCalled();
    expect(emitNavigate).not.toHaveBeenCalled();
    expect(emitReveal).not.toHaveBeenCalled();
    expect(emitSearch).not.toHaveBeenCalled();
    expect(emitAction).not.toHaveBeenCalled();
    expect(hidePalette).not.toHaveBeenCalled();
  });

  it('a panel target still opens a file itself, and hides no Spotlight window', async () => {
    const [, file] = await rowsFrom(makePaletteSources(target()), 'recent');
    await file.run();
    expect(openPath).toHaveBeenCalledWith(FILE);
    expect(hidePalette).not.toHaveBeenCalled();
  });

  it('no target: the old event path to the main window, raised, then the palette hides', async () => {
    const [folder, file] = await rowsFrom(paletteSources, 'recent');
    await folder.run();
    expect(showMain).toHaveBeenCalled();
    expect(emitNavigate).toHaveBeenCalledWith(FOLDER);
    await file.reveal?.();
    expect(emitReveal).toHaveBeenCalledWith(FILE);
    await file.run();
    expect(openPath).toHaveBeenCalledWith(FILE);
    expect(hidePalette).toHaveBeenCalledTimes(3);
  });
});

describe('the path source and hidden items', () => {
  const entry = (name: string, isHidden: boolean) =>
    ({ name, path: `/tmp/x/${name}`, isDir: false, isHidden, iconKey: 'ext/txt' }) as FileEntry;

  afterEach(() => vi.unstubAllGlobals());

  it('lists a hidden name only while Show hidden is on', async () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' } });
    vi.mocked(readDir).mockResolvedValue({
      path: '/tmp/x',
      entries: [entry('.hid.txt', true), entry('seen.txt', false)],
    });
    const was = settings.showHidden;
    try {
      settings.showHidden = false;
      let rows = await sourceNamed('path').query('/tmp/x/');
      expect(rows.map((r) => r.title)).toEqual(['seen.txt']);
      settings.showHidden = true;
      rows = await sourceNamed('path').query('/tmp/x/');
      expect(rows.map((r) => r.title)).toEqual(['.hid.txt', 'seen.txt']);
    } finally {
      settings.showHidden = was;
    }
  });
});

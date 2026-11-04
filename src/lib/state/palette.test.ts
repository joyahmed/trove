import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaletteResult, PaletteSource } from '$lib/types/palette';

vi.mock('$lib/api/palette', () => ({
  hidePalette: vi.fn(async () => {}),
  resizePalette: vi.fn(async () => {}),
}));
vi.mock('$lib/api/log', () => ({ logError: vi.fn() }));

import { logError } from '$lib/api/log';
import { hidePalette, resizePalette } from '$lib/api/palette';
import {
  COLLAPSED_HEIGHT,
  FOOTER_HEIGHT,
  HEADER_HEIGHT,
  LIST_CHROME,
  MAX_HEIGHT,
  palette,
  QUERY_DEBOUNCE_MS,
  ROW_HEIGHT,
} from './palette.svelte';

const result = (
  title: string,
  category: PaletteResult['category'],
  run = vi.fn(),
): PaletteResult => ({
  key: `${category}:${title}`,
  category,
  title,
  detail: '',
  run,
});

const source = (key: string, items: PaletteResult[]): PaletteSource => ({
  key,
  query: vi.fn(async () => items),
});

/** A source that answers only when the test lets it, so "late" is a thing a test can arrange. */
const held = (key: string) => {
  let release: (v: PaletteResult[]) => void = () => {};
  return {
    source: { key, query: () => new Promise<PaletteResult[]>((r) => (release = r)) },
    answer: (items: PaletteResult[]) => release(items),
  };
};

const titles = () => palette.results.map((r) => r.title);
/** The rows in the order they are DRAWN: the groups, flattened, headers aside. */
const rendered = () => palette.groups.flatMap((g) => g.items.map((r) => r.title));
/** Past the debounce and past any paint the palette coalesces, without importing its interval. */
const settled = () => vi.advanceTimersByTimeAsync(200);

describe('palette', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    palette.reset();
  });
  afterEach(() => vi.useRealTimers());

  it('debounces typing, merges the sources and ranks the result', async () => {
    const apps = source('apps', [result('Notepad', 'apps'), result('Paint', 'apps')]);
    const files = source('files', [result('my-notes.txt', 'files')]);
    palette.configure([files, apps]);
    palette.setQuery('no');
    palette.setQuery('not');
    expect(apps.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 5);
    expect(apps.query).toHaveBeenCalledTimes(1);
    expect(apps.query).toHaveBeenCalledWith('not');
    expect(palette.results.map((r) => r.title)).toEqual(['Notepad', 'my-notes.txt']);
    expect(palette.groups.map((g) => g.label)).toEqual(['Apps', 'Files']);
    expect(palette.selected).toBe(0);
  });

  it('a pinLast row stays last, outside the ranking, and carries the text', async () => {
    const files = source('files', [
      result('zzz-unrelated', 'files'),
      { ...result('Search everywhere for "no"', 'files'), matched: true, pinLast: true },
      result('notes.txt', 'files'),
    ]);
    palette.configure([files]);
    palette.setQuery('no');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 1);
    expect(palette.results.map((r) => r.title)).toEqual([
      'notes.txt',
      'Search everywhere for "no"',
    ]);
  });

  it('a stale answer is dropped when the query moved on', async () => {
    let release: (v: PaletteResult[]) => void = () => {};
    const slow: PaletteSource = {
      key: 'slow',
      query: vi.fn(() => new Promise<PaletteResult[]>((r) => (release = r))),
    };
    palette.configure([slow]);
    palette.setQuery('a');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 5);
    const firstRelease = release;
    palette.setQuery('ab');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 5);
    firstRelease([result('a-old', 'files')]);
    await vi.advanceTimersByTimeAsync(1);
    expect(palette.results).toEqual([]);
    release([result('ab-new', 'files')]);
    await vi.advanceTimersByTimeAsync(1);
    expect(palette.results.map((r) => r.title)).toEqual(['ab-new']);
  });

  it('arrows wrap, Tab jumps to the next category, Enter runs the selected row', async () => {
    const run = vi.fn();
    palette.configure([
      source('s', [
        result('Alpha', 'actions'),
        result('Alpha file', 'files', run),
        result('Alpha app', 'apps'),
      ]),
    ]);
    palette.setQuery('alpha');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 5);
    expect(palette.results.map((r) => r.category)).toEqual(['actions', 'apps', 'files']);
    palette.move(-1);
    expect(palette.selected).toBe(2);
    palette.move(1);
    expect(palette.selected).toBe(0);
    palette.nextCategory();
    expect(palette.current?.category).toBe('apps');
    palette.nextCategory();
    expect(palette.current?.category).toBe('files');
    await palette.run();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a slow source does not keep the fast ones off the screen', async () => {
    // "the supersearch can't find anything on the machine": `filesSource` waits on the drive
    // enumeration, which is tens of seconds on a machine with a dead network mapping, and the
    // whole merge used to wait with it.
    let release: (v: PaletteResult[]) => void = () => {};
    const slow: PaletteSource = {
      key: 'files',
      query: vi.fn(() => new Promise<PaletteResult[]>((r) => (release = r))),
    };
    palette.configure([source('actions', [result('New tab', 'actions')]), slow]);
    palette.setQuery('new');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 5);
    expect(palette.results.map((r) => r.title)).toEqual(['New tab']);
    expect(palette.busy).toBe(true);
    release([result('new-notes.txt', 'files')]);
    await vi.advanceTimersByTimeAsync(1);
    expect(palette.results.map((r) => r.title)).toEqual(['New tab', 'new-notes.txt']);
    expect(palette.busy).toBe(false);
  });

  it('Enter answers the query in the box: 1+2 copies 3, it does not open a log', async () => {
    // Joy's bug. He typed `1`, the fast sources answered with a recent log, he finished typing
    // `1+2` and pressed Enter while the file search was still out — and the palette ran the row
    // the previous query had left lit.
    const openLog = vi.fn();
    const copy = vi.fn();
    let release: (v: PaletteResult[]) => void = () => {};
    const files: PaletteSource = {
      key: 'files',
      query: (text) =>
        text.trim() === '1+2'
          ? new Promise<PaletteResult[]>((r) => (release = r))
          : Promise.resolve([]),
    };
    const calc: PaletteSource = {
      key: 'calc',
      query: async (text) =>
        text.trim() === '1+2' ? [{ ...result('= 3', 'calc', copy), matched: true }] : [],
    };
    palette.configure([calc, source('recent', [result('trove-1.log', 'recent', openLog)]), files]);

    palette.setQuery('1');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 5);
    expect(palette.current?.title).toBe('trove-1.log');

    palette.setQuery('1+2');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 5);
    expect(palette.busy).toBe(true);
    expect(palette.results.map((r) => r.title)).toEqual(['= 3']);
    expect(palette.current?.title).toBe('= 3');
    await palette.run();
    expect(copy).toHaveBeenCalledTimes(1);
    expect(openLog).not.toHaveBeenCalled();
    release([]);
    await vi.advanceTimersByTimeAsync(1);
  });

  it('the answer is the lit row, even against a file whose name contains the sum', async () => {
    const copy = vi.fn();
    const openLog = vi.fn();
    palette.configure([
      { key: 'calc', query: async () => [{ ...result('= 3', 'calc', copy), matched: true }] },
      source('files', [result('build-1+2.log', 'files', openLog)]),
    ]);
    palette.setQuery('1+2');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 5);
    expect(palette.results.map((r) => r.title)).toEqual(['= 3', 'build-1+2.log']);
    expect(palette.selected).toBe(0);
    expect(palette.groups[0].label).toBe('Calculator');
    await palette.run();
    expect(copy).toHaveBeenCalledTimes(1);
    expect(openLog).not.toHaveBeenCalled();
  });

  it('a late source re-ranks, but never moves a selection the person made', async () => {
    let release: (v: PaletteResult[]) => void = () => {};
    const slow: PaletteSource = {
      key: 'calc',
      query: vi.fn(() => new Promise<PaletteResult[]>((r) => (release = r))),
    };
    palette.configure([
      source('actions', [result('New tab', 'actions'), result('New folder here', 'actions')]),
      slow,
    ]);
    palette.setQuery('new');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 5);
    palette.move(1);
    expect(palette.current?.title).toBe('New folder here');
    release([{ ...result('= 3', 'calc'), matched: true }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(palette.results.map((r) => r.title)).toEqual(['= 3', 'New tab', 'New folder here']);
    expect(palette.current?.title).toBe('New folder here');
  });

  it('a source that fails is logged, not mistaken for a source that found nothing', async () => {
    palette.configure([
      { key: 'apps', query: async () => Promise.reject(new Error('spotlight_apps blew up')) },
      source('files', [result('notes.txt', 'files')]),
    ]);
    palette.setQuery('notes');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 5);
    expect(palette.results.map((r) => r.title)).toEqual(['notes.txt']);
    expect(logError).toHaveBeenCalledWith('palette.source.apps', expect.any(Error));
  });

  it('Escape hides and clears; an empty query clears without asking the sources', async () => {
    const s = source('s', [result('x', 'apps')]);
    palette.configure([s]);
    palette.setQuery('x');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 5);
    expect(palette.results).toHaveLength(1);
    expect(palette.height).toBeGreaterThan(64);
    await palette.hide();
    expect(hidePalette).toHaveBeenCalled();
    expect(palette.query).toBe('');
    expect(palette.results).toEqual([]);
    expect(palette.height).toBe(64);
    palette.setQuery('   ');
    await vi.advanceTimersByTimeAsync(QUERY_DEBOUNCE_MS + 5);
    expect(s.query).toHaveBeenCalledTimes(1);
  });

  /**
   * ⛔ One list. `results` is the order the rows are DRAWN in, the order the keyboard walks and
   * the order `selected` indexes into — the same order, always. Confirmed on the running build by
   * screenshot: `chrome` drew **Google Chrome** first under APPS while the highlight sat on
   * `ChromeSetup.exe` under FILES, so **Enter ran an installer**, one Down skipped Google Chrome
   * onto a `.pak`, and Up from the top wrapped to a row off screen. Two orders — flat by score for
   * the selection, `paletteCategories` for the rendering — is the whole bug.
   *
   * ⛔ The other half was the ranking itself: the installer scored *higher* than the app, so one
   * honest order still lit `ChromeSetup.exe`. `matchScore` now scores a whole word (`Google
   * `**`Chrome`**, 2.5) above a prefix of a longer one (**`Chrome`**`Setup.exe`, 2), which is why
   * these expectations draw APPS first. See `utils/palette-rank`.
   */
  describe('the lit row is the drawn row', () => {
    const chromeSources = () => [
      source('apps', [result('Google Chrome', 'apps')]),
      source('files', [result('ChromeSetup.exe', 'files'), result('chrome_100.pak', 'files')]),
    ];

    it('the highlight is on the first row of the first group that is drawn', async () => {
      palette.configure(chromeSources());
      palette.setQuery('chrome');
      await settled();
      // `chrome` is a whole word of `Google Chrome` (2.5) and only a prefix of the two files
      // (2) — so APPS is the group the ranking draws first, and Enter runs the app.
      expect(rendered()).toEqual(['Google Chrome', 'ChromeSetup.exe', 'chrome_100.pak']);
      expect(rendered()).toEqual(titles());
      expect(palette.groups[0].items[0]).toBe(palette.current);
      expect(palette.current).toBe(palette.results[0]);
    });

    it('Down goes to the row below the one on screen, and Up from the top to the last', async () => {
      palette.configure(chromeSources());
      palette.setQuery('chrome');
      await settled();
      expect(rendered()).toEqual(titles());
      palette.move(1);
      expect(palette.current?.title).toBe('ChromeSetup.exe');
      palette.move(1);
      expect(palette.current?.title).toBe('chrome_100.pak');
      palette.move(1);
      expect(palette.current?.title).toBe('Google Chrome');
      palette.move(-1);
      expect(palette.current?.title).toBe('chrome_100.pak');
    });

    it('Tab still walks the groups, in the order they are drawn', async () => {
      palette.configure(chromeSources());
      palette.setQuery('chrome');
      await settled();
      expect(palette.groups.map((g) => g.label)).toEqual(['Apps', 'Files']);
      expect(palette.current?.title).toBe('Google Chrome');
      palette.nextCategory();
      expect(palette.current?.title).toBe('ChromeSetup.exe');
      palette.nextCategory();
      expect(palette.current?.title).toBe('Google Chrome');
    });

    it('the pinned fallbacks are the last rows drawn, under every group', async () => {
      const everywhere = {
        ...result('Search everywhere for "chrome"', 'files'),
        matched: true,
        pinLast: true,
      };
      const web = { ...result('Search the web for "chrome"', 'web'), matched: true, pinLast: true };
      palette.configure([
        source('apps', [result('Google Chrome', 'apps')]),
        source('files', [result('ChromeSetup.exe', 'files'), everywhere]),
        source('web', [web]),
      ]);
      palette.setQuery('chrome');
      await settled();
      expect(rendered()).toEqual([
        'Google Chrome',
        'ChromeSetup.exe',
        'Search everywhere for "chrome"',
        'Search the web for "chrome"',
      ]);
      expect(rendered()).toEqual(titles());
      // they are fallback actions, not a category: one trailing block, drawn without a header
      expect(palette.groups.map((g) => g.label)).toEqual(['Apps', 'Files', '']);
      expect(palette.current?.title).toBe('Google Chrome');
    });
  });

  /**
   * ⛔ Nine sources answer one query, most of them late. `refresh` merges each answer as it lands
   * — which is what keeps the rows honest — but every merge used to re-rank the whole list, redraw
   * it, and resize the OS window: "the search is behaving like react re-render with useEffect
   * badly". The freshness stays; the thrash does not.
   */
  describe('one query, one settled list', () => {
    it('a late source is inserted, it does not reorder the rows already on screen', async () => {
      const late = held('apps-late');
      palette.configure([
        source('recent', [result('notes-2026.md', 'recent')]), // starts with "note" → 2
        source('apps', [result('Keynote', 'apps')]), // contains it → 1
        source('files', [result('my-note.txt', 'files')]), // a word starts with it → 1.5
        late.source,
      ]);
      palette.setQuery('note');
      await settled();
      expect(rendered()).toEqual(['notes-2026.md', 'my-note.txt', 'Keynote']);
      expect(rendered()).toEqual(titles());

      // `Notepad` scores 2 and is an app, so the ranking alone would lift the whole APPS group
      // above FILES and drag `Keynote` up over `my-note.txt` — a row moving after it was drawn.
      late.answer([result('Notepad', 'apps')]);
      await settled();
      expect(rendered()).toEqual(['notes-2026.md', 'my-note.txt', 'Notepad', 'Keynote']);
      expect(rendered()).toEqual(titles());
      // the three rows that were on screen kept their order; the newcomer was inserted
      expect(titles().filter((t) => t !== 'Notepad')).toEqual([
        'notes-2026.md',
        'my-note.txt',
        'Keynote',
      ]);
    });

    it('the window never shrinks mid-query, and settles to the list when the query is done', async () => {
      const slow = held('files');
      const three = ['note-a.md', 'note-b.md', 'note-c.md'].map((t) => result(t, 'recent'));
      palette.configure([source('recent', three), slow.source]);
      palette.setQuery('note');
      await settled();
      slow.answer([]);
      await settled();
      const tall = COLLAPSED_HEIGHT + LIST_CHROME + FOOTER_HEIGHT + HEADER_HEIGHT + 3 * ROW_HEIGHT;
      expect(palette.busy).toBe(false);
      expect(palette.height).toBe(tall);

      // a second query: one row this time, and the slow source still out. The window holds the
      // height it has — it does not collapse to the input row and then accordion back open.
      const slower = held('files');
      palette.configure([source('recent', [result('note-a.md', 'recent')]), slower.source]);
      palette.setQuery('note-a');
      await settled();
      expect(palette.busy).toBe(true);
      expect(palette.height).toBe(tall);
      slower.answer([]);
      await settled();
      expect(palette.height).toBe(
        COLLAPSED_HEIGHT + LIST_CHROME + FOOTER_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT,
      );
      expect(palette.fitHeight).toBeGreaterThanOrEqual(
        COLLAPSED_HEIGHT + LIST_CHROME + FOOTER_HEIGHT + ROW_HEIGHT,
      );
      await palette.hide();
      expect(palette.height).toBe(COLLAPSED_HEIGHT);
    });

    it('nine sources are two paints and two resizes, not nine of each', async () => {
      const answers = Array.from({ length: 9 }, (_, i) => held(`s${i}`));
      palette.configure(answers.map((a) => a.source));
      palette.setQuery('note');
      await settled();
      vi.mocked(resizePalette).mockClear();

      const paints = new Set<PaletteResult[]>();
      for (let i = 0; i < answers.length; i++) {
        answers[i].answer([result(`note-${i}.md`, 'files')]);
        // a millisecond apart: nine answers inside one coalescing window
        await vi.advanceTimersByTimeAsync(1);
        paints.add(palette.results);
      }
      expect(palette.results).toHaveLength(9);
      // one `results` identity per paint; at most one OS resize per paint
      expect(paints.size).toBeLessThanOrEqual(2);
      expect(resizePalette).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * Find anything is this palette as a panel inside an explorer window. The Spotlight window is
   * hidden there and is not what the person sees, so the panel never sizes it.
   */
  it('as a panel, never resizes the Spotlight window', async () => {
    palette.configure([source('apps', [result('Notepad', 'apps')])], { sizesWindow: false });
    vi.mocked(resizePalette).mockClear();
    palette.syncWindow();
    palette.setQuery('note');
    await settled();
    expect(titles()).toEqual(['Notepad']);
    palette.reset();
    expect(resizePalette).not.toHaveBeenCalled();
  });

  it('as the Spotlight window, sizes it again once configured without the flag', async () => {
    palette.configure([source('apps', [result('Notepad', 'apps')])], { sizesWindow: false });
    palette.configure([source('apps', [result('Notepad', 'apps')])]);
    vi.mocked(resizePalette).mockClear();
    palette.setQuery('note');
    await settled();
    expect(resizePalette).toHaveBeenCalled();
  });

  /**
   * ⛔ Seen on Ubuntu at 82e2ee7: `calc` drew **GNOME Calculator** at the top, but the highlight sat
   * on `/usr/share/doc/gnome-calculator` below it and Enter opened the folder. The pointer was
   * resting over the list: the files source answered first, its folder row was drawn under the
   * still pointer, the webview fired a hover for it, and the hover counted as the person choosing
   * that row — so when the app answered late and was inserted above, the selection stayed on the
   * folder. A row re-rendering under a still pointer is not a choice.
   */
  describe('a still pointer does not choose a row', () => {
    const calc = () => {
      const apps = held('apps');
      palette.configure([source('files', [result('gnome-calculator', 'files')]), apps.source]);
      return apps;
    };

    it('a row drawn under a still pointer does not take the highlight from the top row', async () => {
      const apps = calc();
      palette.setQuery('calc');
      await settled();
      expect(titles()).toEqual(['gnome-calculator']);
      // the folder row appeared under the resting pointer: the webview reports a hover on it
      palette.hover(0, 300, 120);
      // the app answers late and ranks above the folder: inserted on top
      apps.answer([result('Calculator', 'apps')]);
      await settled();
      expect(rendered()).toEqual(['Calculator', 'gnome-calculator']);
      // rows re-rendered under the same still pointer: still not a choice
      palette.hover(1, 300, 120);
      expect(palette.selected).toBe(0);
      expect(palette.current?.title).toBe('Calculator');
      await palette.run();
      expect(palette.results[0].run).toHaveBeenCalledTimes(1);
      expect(palette.results[1].run).not.toHaveBeenCalled();
    });

    it('a new query puts the highlight on its first row even after a still-pointer hover', async () => {
      const apps = calc();
      palette.setQuery('calc');
      await settled();
      palette.hover(0, 300, 120);
      apps.answer([result('Calculator', 'apps')]);
      await settled();
      palette.setQuery('calcu');
      await settled();
      apps.answer([result('Calculator', 'apps')]);
      await settled();
      expect(rendered()).toEqual(['Calculator', 'gnome-calculator']);
      palette.hover(1, 300, 120);
      expect(palette.selected).toBe(0);
    });

    it('a real pointer move still selects the row under it', async () => {
      const apps = calc();
      palette.setQuery('calc');
      await settled();
      apps.answer([result('Calculator', 'apps')]);
      await settled();
      palette.hover(0, 300, 120);
      palette.hover(1, 300, 160);
      expect(palette.current?.title).toBe('gnome-calculator');
      expect(palette.selected).toBe(1);
    });
  });

  describe('the preview pane (plan 04 4.4)', () => {
    afterEach(() => palette.setPreview(false));

    it('pins the window to its full height while it is on and a row can be previewed', async () => {
      const file = { ...result('note.md', 'files'), previewPath: 'C:\\note.md' };
      palette.configure([source('files', [file])]);
      palette.setQuery('note');
      await settled();
      const short = COLLAPSED_HEIGHT + LIST_CHROME + FOOTER_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT;
      expect(palette.fitHeight).toBe(short);
      palette.setPreview(true);
      expect(palette.fitHeight).toBe(MAX_HEIGHT);
      expect(palette.height).toBe(MAX_HEIGHT);
      palette.setPreview(false);
      expect(palette.height).toBe(short);
    });

    it('leaves the height alone when no row is a file or folder', async () => {
      palette.setPreview(true);
      palette.configure([source('actions', [result('New tab', 'actions')])]);
      palette.setQuery('tab');
      await settled();
      expect(palette.fitHeight).toBeLessThan(MAX_HEIGHT);
    });
  });
});

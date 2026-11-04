import { describe, expect, it } from 'vitest';
import type { PaletteResult } from '$lib/types/palette';
import { paletteActions } from '$lib/data/palette-actions';
import {
  keywordScore,
  MATCH_EXACT,
  MATCH_KEYWORD,
  matchScore,
  rank,
  renderOrder,
} from './palette-rank';

const r = (title: string, category: PaletteResult['category']): PaletteResult => ({
  key: `${category}:${title}`,
  category,
  title,
  detail: '',
  run: () => {},
});

describe('matchScore', () => {
  it('whole word beats prefix beats word-prefix beats substring beats nothing', () => {
    expect(matchScore('Notepad', 'note')).toBe(2);
    // `code` is a whole word of it, so Visual Studio Code sits above `code.ts` (a prefix, 2)
    expect(matchScore('Visual Studio Code', 'code')).toBe(2.5);
    expect(matchScore('Visual Studio Code', 'stud')).toBe(1.5);
    expect(matchScore('renamed-report.txt', 'port')).toBe(1);
    expect(matchScore('Calculator', 'zzz')).toBe(0);
    expect(matchScore('anything', '  ')).toBe(1);
  });
});

/**
 * ⛔ **The installer bug.** `chrome` scored `ChromeSetup.exe` 2 (the text is a prefix of the whole
 * title) and `Google Chrome` 1.5 (a prefix of a *word* in it), so FILES was drawn above APPS and
 * Enter ran an installer. A person typing a complete word means that word: an **exact** word beats
 * a **prefix of a longer** one, at every source.
 */
describe('the match ladder', () => {
  it('3 — the whole title is the text', () => {
    expect(matchScore('Chrome', 'chrome')).toBe(3);
    expect(matchScore('Chrome', 'CHROME')).toBe(3);
  });

  it('2.5 — a whole word of the title is the text, which beats a prefix of a longer word', () => {
    expect(matchScore('Google Chrome', 'chrome')).toBe(2.5);
    expect(matchScore('Google Chrome', 'chrome')).toBeGreaterThan(
      matchScore('ChromeSetup.exe', 'chrome'),
    );
  });

  it('2 — the title starts with the text', () => {
    expect(matchScore('ChromeSetup.exe', 'chrome')).toBe(2);
    expect(matchScore('Notepad', 'note')).toBe(2);
  });

  it('1.5 — a word of the title starts with the text', () => {
    expect(matchScore('Google Chrome', 'chr')).toBe(1.5);
    expect(matchScore('my-note.txt', 'note')).toBe(1.5);
  });

  it('1 — the title merely contains the text', () => {
    expect(matchScore('renamed-report.txt', 'port')).toBe(1);
  });

  it('0 — the title does not contain the text at all', () => {
    expect(matchScore('Calculator', 'zzz')).toBe(0);
  });

  it('a hyphen or underscore token is not a whole word, so `doc` and `term` do not move', () => {
    // ⛔ the wider split (space, -, _, .) belongs to the PREFIX tier only. Counting `doc-notes.md`
    // and `term_notes.txt` as exact matches for `doc`/`term` would lift a text file over the
    // Documents folder and over Terminal — the installer bug again, wearing a different name.
    expect(matchScore('doc-notes.md', 'doc')).toBe(2);
    expect(matchScore('term_notes.txt', 'term')).toBe(2);
    expect(matchScore('chrome_100_percent.pak', 'chrome')).toBe(2);
  });

  it('an extension is part of the title, so `chrome.exe` does not outrank the installed app', () => {
    expect(matchScore('chrome.exe', 'chrome')).toBe(2);
    expect(matchScore('chrome.exe', 'chrome')).toBeLessThan(matchScore('Google Chrome', 'chrome'));
  });

  it('a source that matched a row itself puts it at the top of the ladder', () => {
    expect(MATCH_EXACT).toBe(matchScore('Chrome', 'chrome'));
  });
});

describe('rank', () => {
  it('the app beats an installer whose name only starts with the text', () => {
    // the `chrome` screenshot: Enter used to run `ChromeSetup.exe`
    const out = rank(
      [r('Google Chrome', 'apps'), r('ChromeSetup.exe', 'files'), r('chrome_100.pak', 'files')],
      'chrome',
    );
    expect(out.map((x) => x.title)).toEqual(['Google Chrome', 'ChromeSetup.exe', 'chrome_100.pak']);
  });

  it('an exactly-named file still beats an app that only loosely matches', () => {
    // the bias is not inverted: the app is preferred only when it matches at least as well
    const loose = rank(
      [r('Microsoft Budgeting Tool', 'apps'), r('budget.xlsx', 'files')],
      'budget',
    );
    expect(loose.map((x) => x.title)).toEqual(['budget.xlsx', 'Microsoft Budgeting Tool']);
    const named = rank([r('Google Chrome', 'apps'), r('chrome', 'files')], 'chrome');
    expect(named.map((x) => x.title)).toEqual(['chrome', 'Google Chrome']);
  });

  it('a calculator answer still wins its own query', () => {
    const out = rank(
      [r('4', 'files'), { ...r('= 4', 'calc'), matched: true }, r('2+2.txt', 'files')],
      '2+2',
    );
    expect(out[0].title).toBe('= 4');
  });

  it('drops non-matches and puts prefix matches first; a source-matched row stays', () => {
    const out = rank(
      [
        r('my-notes.txt', 'files'),
        r('Notepad', 'apps'),
        r('Other', 'apps'),
        { ...r('Users', 'path'), matched: true },
      ],
      'note',
    );
    expect(out.map((x) => x.title)).toEqual(['Users', 'Notepad', 'my-notes.txt']);
  });

  it('breaks ties by category order, then by input order', () => {
    const out = rank(
      [
        r('Downloads', 'places'),
        r('Downloads', 'recent'),
        r('Downloads', 'files'),
        r('Down', 'files'),
      ],
      'down',
    );
    expect(out.map((x) => `${x.category}:${x.title}`)).toEqual([
      // `Down` IS the text, so it tops the ladder whatever category it came from; the three
      // Downloads score the same and it is category, then input order, that separates them
      'files:Down',
      'recent:Downloads',
      'places:Downloads',
      'files:Downloads',
    ]);
  });

  it('lists one thing offered by two sources once, under the winning category', () => {
    const same = (category: PaletteResult['category']) => ({
      ...r('Downloads', category),
      detail: 'C:/Users/alex/Downloads',
      identity: 'C:/Users/alex/Downloads',
    });
    const out = rank([same('places'), same('recent'), same('files')], 'down');
    expect(out.map((x) => x.category)).toEqual(['recent']);
  });
});

describe('renderOrder', () => {
  const drawn = (blocks: ReturnType<typeof renderOrder>) =>
    blocks.flatMap((b) => b.items.map((x) => x.title));

  it('nothing drawn yet: blocks in the order the ranking reaches them', () => {
    // the `chrome` screenshot, both halves fixed: `chrome` is a whole word of `Google Chrome`
    // (2.5) and only a prefix of `ChromeSetup.exe` (2), so APPS is the block drawn first — and
    // its first row is the one the highlight is on, so Enter no longer runs an installer
    const ideal = rank(
      [r('Google Chrome', 'apps'), r('ChromeSetup.exe', 'files'), r('chrome_100.pak', 'files')],
      'chrome',
    );
    const blocks = renderOrder(ideal, [], [], 12);
    expect(blocks.map((b) => b.category)).toEqual(['apps', 'files']);
    expect(drawn(blocks)).toEqual(['Google Chrome', 'ChromeSetup.exe', 'chrome_100.pak']);
  });

  it('a row already drawn holds its place; a newcomer is inserted where it ranks', () => {
    const rows = [r('notes-2026.md', 'recent'), r('my-note.txt', 'files'), r('Keynote', 'apps')];
    const first = renderOrder(rank(rows, 'note'), [], [], 12);
    expect(drawn(first)).toEqual(['notes-2026.md', 'my-note.txt', 'Keynote']);

    // `Notepad` scores 2 and is an app: the ranking alone would lift APPS over FILES and drag
    // `Keynote` up over `my-note.txt`, moving a row that is already on screen
    const late = r('Notepad', 'apps');
    const keys = first.flatMap((b) => b.items.map((x) => x.key));
    const second = renderOrder(rank([...rows, late], 'note'), keys, [], 12);
    expect(drawn(second)).toEqual(['notes-2026.md', 'my-note.txt', 'Notepad', 'Keynote']);
    // and with nothing drawn, the same input DOES put the newcomer's block second
    expect(drawn(renderOrder(rank([...rows, late], 'note'), [], [], 12))).toEqual([
      'notes-2026.md',
      'Notepad',
      'Keynote',
      'my-note.txt',
    ]);
  });

  it('the cap counts down the blocks as they are drawn; pinned rows sit outside it', () => {
    const rows = Array.from({ length: 4 }, (_, i) => r(`note-${i}.md`, 'files'));
    const pin = { ...r('Search everywhere for "note"', 'files'), matched: true, pinLast: true };
    const blocks = renderOrder(rank(rows, 'note'), [], [pin], 2);
    expect(drawn(blocks)).toEqual(['note-0.md', 'note-1.md', 'Search everywhere for "note"']);
    // the pinned rows are their own block, drawn under everything and without a header
    expect(blocks.map((b) => b.pinned ?? false)).toEqual([false, true]);
  });
});

describe('rank dedupe', () => {
  const file = (
    name: string,
    key: string,
    identity: string,
    category: PaletteResult['category'],
  ) => ({
    ...r(name, category),
    key,
    identity,
    detail: 'C:/trove-test',
  });

  it('keeps every file that shares a folder', () => {
    const rows = Array.from({ length: 12 }, (_, i) => {
      const path = `C:/trove-test/note-${i + 1}.txt`;
      return file(`note-${i + 1}.txt`, `files:${path}`, path, 'files');
    });
    expect(rank(rows, 'note-')).toHaveLength(12);
  });

  it('lists the same path from two sources once, under the better category', () => {
    const a = file('a.txt', 'recent:C:/x/a.txt', 'C:/x/a.txt', 'recent');
    const b = file('a.txt', 'files:C:/x/A.TXT', 'C:/x/A.TXT', 'files');
    const out = rank([b, a], 'a.txt');
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('recent');
  });

  it('falls back to the key when there is no identity', () => {
    expect(rank([r('note', 'files'), r('note', 'apps')], 'note')).toHaveLength(2);
  });
});

describe('action keywords (real-app click test, 2026-11-04)', () => {
  const actionRows = (): PaletteResult[] =>
    paletteActions.map((a) => ({
      key: `action:${a.key}`,
      category: 'actions',
      title: a.label,
      detail: a.keywords,
      keywords: a.keywords,
      run: () => {},
    }));
  const top = (text: string) => rank(actionRows(), text)[0]?.key;

  it('"tab set" finds Save tabs as… (every typed word starts a title or keyword word)', () => {
    expect(top('tab set')).toBe('action:save-tab-set');
    expect(top('set tab')).toBe('action:save-tab-set');
  });
  it('the obvious synonyms find their action', () => {
    expect(top('preferences')).toBe('action:open-settings');
    expect(top('options')).toBe('action:open-settings');
    expect(top('shell')).toBe('action:open-terminal');
    expect(top('console')).toBe('action:open-terminal');
    for (const q of ['trash', 'bin', 'recycle'])
      expect(rank(actionRows(), q).map((x) => x.key)).toContain('action:open-recycle-bin');
  });
  it('a keyword hit is the bottom rung, so a title match always sorts above it', () => {
    expect(keywordScore('Save tabs as…', 'tab set', 'tab set')).toBe(MATCH_KEYWORD);
    expect(keywordScore('Save tabs as…', 'tab set', 'tab zzz')).toBe(0);
    const file = r('settings.json', 'files');
    const settingsAction = { ...r('Open settings', 'actions'), keywords: 'preferences' };
    const pref = { ...r('Folder preferences.txt', 'files') };
    expect(rank([settingsAction, pref, file], 'preferences').map((x) => x.title)).toEqual([
      'Folder preferences.txt',
      'Open settings',
    ]);
  });
});

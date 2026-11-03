// How the palette orders what its sources return. Written down, not tuned by feel: a name that
// IS the text beats one that starts with it, which beats one that merely contains it; ties go by
// category order. `rank` is the ideal order of the merge; `renderOrder` is the order the rows are
// actually DRAWN in, which is also the order the keyboard walks — there is only ever one of those.
import { categoryOrder } from '$lib/data/palette-categories';
import type { PaletteCategory, PaletteResult } from '$lib/types/palette';

/**
 * The top of the ladder, and what a source's own `matched: true` is worth: the source already
 * decided this row answers the query, so it is treated as an exact hit. `calc`'s `= 84` can
 * never contain what was typed, and `calc` is the first category, so the answer stays first.
 */
export const MATCH_EXACT = 3;

/**
 * How well `title` answers `text`, high is better. The ladder, best first:
 *
 * | 3   | the whole title is the text                      | `Chrome` for `chrome`        |
 * | 2.5 | a whole **word** of the title is the text         | `Google `**`Chrome`**        |
 * | 2   | the title starts with the text                   | **`Chrome`**`Setup.exe`      |
 * | 1.5 | a word of the title starts with the text          | `Google `**`Chr`**`ome`      |
 * | 1   | the title contains the text (or the text is blank) | `renamed-re`**`port`**`.txt` |
 * | 0   | no match — the row is dropped                    |                              |
 *
 * ⛔ **The installer bug lived on rungs 2 and 2.5.** There was no whole-word rung: `chrome` scored
 * `ChromeSetup.exe` 2 (a prefix of the whole title) and `Google Chrome` only 1.5 (a prefix of a
 * *word*), so FILES was drawn above APPS, the lit row was an installer, and **Enter ran it**.
 * Somebody who types a complete word means that word.
 *
 * ⚠️ Two deliberate limits on "word", both there to stop this fix from re-creating the same bug
 * under a different name — a file lit where an app was meant:
 *
 * 1. **Only whitespace separates words on rung 2.5.** The wider split (space, `-`, `_`, `.`) is
 *    the *prefix* rung's, where it has always been. Counting `-`/`_`/`.` tokens as whole words
 *    would score `doc-notes.md`, `term_notes.txt` and `chrome_100_percent.pak` as exact hits for
 *    `doc`, `term` and `chrome` — lifting a text file over the Documents folder and over Terminal.
 * 2. **A CamelCase hump does not start a word.** `ChromeSetup.exe` stays rung 2 for `chrome`; it
 *    is not `Chrome`, it is the setup *for* Chrome, and this is the row the bug was about. The
 *    cost is paid by the other half: `setup` finds `ChromeSetup.exe` only on rung 1 (contains),
 *    so it sorts under `setup.log`. That is the right way round — and it keeps one notion of
 *    "word" in this file instead of two.
 *
 * An extension is part of the title and is not stripped, so `chrome.exe` is rung 2, under the
 * installed app. Stripping it would put any downloaded `chrome.exe` on rung 3, above Google
 * Chrome, which is the original complaint wearing a different filename.
 */
export const matchScore = (title: string, text: string): number => {
  const t = text.trim().toLowerCase();
  if (!t) return 1;
  const name = title.toLowerCase();
  if (name === t) return MATCH_EXACT;
  if (name.split(/\s+/).includes(t)) return 2.5;
  if (name.startsWith(t)) return 2;
  if (name.split(/[\s\-_.]+/).some((w) => w.startsWith(t))) return 1.5;
  return name.includes(t) ? 1 : 0;
};

/**
 * Matches only, best first; the input order breaks remaining ties (sources list newest first).
 * The same thing offered by two sources (a recent folder that is also a place) is listed
 * once, under the first category that wins — `identity` (a full path) says it is the same thing.
 * ⛔ Never the detail line: a file's detail is its parent folder, so twelve files in one folder
 * used to collapse into one row.
 *
 * ⭐ **Category stays a tie-break, deliberately.** `paletteCategories` encodes a real precedence
 * (an installed app is a better answer to a bare word than a file that merely starts with it) and
 * it does most of the work here, because the ladder above puts an app and a file that match
 * *equally well* on the same rung: for `chrome`, `Google Chrome`, `chrome.exe` and
 * `chrome_100_percent.pak` all land on a rung where APPS then wins outright. What category is NOT
 * allowed to do is cross a rung. A bonus big enough to lift an app over a better-matching file
 * (the rungs are 0.5 apart) would bury `budget.xlsx` under `Microsoft Budgeting Tool`, and a bonus
 * smaller than that changes no order at all — it would only be a tie-break spelled expensively.
 */
export const rank = (results: PaletteResult[], text: string): PaletteResult[] => {
  const seen: Record<string, true> = {};
  return results
    .map((r, i) => ({ r, i, score: r.matched ? MATCH_EXACT : matchScore(r.title, text) }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || categoryOrder(a.r.category) - categoryOrder(b.r.category) || a.i - b.i,
    )
    .map((x) => x.r)
    .filter((r) => {
      const id = (r.identity || r.key).toLowerCase();
      if (seen[id]) return false;
      seen[id] = true;
      return true;
    });
};

/** One category's rows, in the order they are drawn. `pinned` blocks carry no header. */
export interface RankedBlock {
  category: PaletteCategory;
  items: PaletteResult[];
  pinned?: boolean;
}

/**
 * The order the rows are DRAWN in — which is also the order the keyboard walks and the order
 * `selected` indexes into.
 *
 * ⛔ **Two orders was the bug.** The palette used to rank flat (so `selected = 0` meant the
 * best-scoring row) and render grouped strictly by `paletteCategories`. For `chrome` that drew
 * **Google Chrome** first, under APPS, while the highlight sat on `ChromeSetup.exe` under FILES:
 * Enter ran an installer, one Down skipped Google Chrome onto a `.pak`, and Up from the top
 * wrapped to a row the list never scrolled to. So the grouping is computed once, here, and the
 * flat list is that grouping flattened — the two cannot disagree any more.
 *
 * `ideal` is `rank()`'s total order. `drawn` is the keys already on screen for this query, in the
 * order they are on screen. The rules, in order:
 *
 * 1. **A row already on screen holds its place** — inside its block, and its block relative to
 *    the other blocks already drawn. Nine sources answer one query and most of them answer late;
 *    a row the eye has settled on must not slide out from under the cursor because a later source
 *    outranked it.
 * 2. **A row nobody has seen yet goes where it ranks**: into its own block when that category is
 *    already drawn, otherwise as a new block placed by its rank against the best row of every
 *    block already there — so a late calculator answer still reaches the top.
 * 3. **`pinLast` rows are one trailing block**, outside `max`, drawn without a header. They are
 *    fallback actions ("Search everywhere for …", "Search the web for …"), not a category, and
 *    they must sit under everything — including under the FILES group that `everywhereResult`
 *    shares a category with, which is why they are not grouped with it.
 *
 * The trade between 1 and 2: a newcomer may be *inserted* above a row already on screen, but it
 * may never *reorder* the rows around it. "Best row first" wins for rows nobody has seen yet;
 * "nothing jumps" wins for rows already drawn.
 */
export const renderOrder = (
  ideal: PaletteResult[],
  drawn: string[],
  pins: PaletteResult[],
  max: number,
): RankedBlock[] => {
  const at = new Map(ideal.map((r, i) => [r.key, i] as const));
  const byKey = new Map(ideal.map((r) => [r.key, r] as const));
  const pos = (r: PaletteResult) => at.get(r.key) ?? Number.MAX_SAFE_INTEGER;
  const blocks: RankedBlock[] = [];
  const blockOf = (c: PaletteCategory) => blocks.find((b) => b.category === c);

  // 1. what is already on screen, in the order it is on screen
  for (const key of drawn) {
    const r = byKey.get(key);
    // gone: deduped away by a better source, or ranked out of the list entirely
    if (!r) continue;
    const b = blockOf(r.category);
    if (b) b.items.push(r);
    else blocks.push({ category: r.category, items: [r] });
  }
  // 2. the newcomers, best first
  const held = new Set(drawn);
  for (const r of ideal) {
    if (held.has(r.key)) continue;
    const b = blockOf(r.category);
    if (b) {
      const i = b.items.findIndex((x) => pos(x) > pos(r));
      b.items.splice(i < 0 ? b.items.length : i, 0, r);
      continue;
    }
    const best = (blk: RankedBlock) => Math.min(...blk.items.map(pos));
    const i = blocks.findIndex((blk) => best(blk) > pos(r));
    blocks.splice(i < 0 ? blocks.length : i, 0, { category: r.category, items: [r] });
  }
  // 3. the cap, counted down the blocks as they are drawn, then the pinned rows under them all
  const out: RankedBlock[] = [];
  let room = max;
  for (const b of blocks) {
    if (room <= 0) break;
    const items = b.items.slice(0, room);
    room -= items.length;
    out.push({ category: b.category, items });
  }
  if (pins.length > 0) out.push({ category: pins[0].category, items: [...pins], pinned: true });
  return out;
};

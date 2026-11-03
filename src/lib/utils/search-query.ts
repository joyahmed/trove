// The search box's text → a SearchQuery. Explorer's words are understood: `*.png`, `ext:png`,
// `name:foo`, `kind:folder`, `size:>10mb` / `size:<1kb` / `size:empty` / a size band,
// `modified:today|thisweek|thismonth|thisyear`; everything else is name text. A chip set in
// the command bar wins over the typed word for its axis.
import {
  dateAfter,
  sizePresets,
  type DatePeriod,
  type SearchChips,
  type SizeKey,
} from '$lib/data/search-filters';
import type { SearchKind, SearchQuery } from '$lib/types/search';

const UNIT: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

const PERIODS = new Set<string>(['today', 'thisweek', 'thismonth', 'thisyear']);
const KINDS = new Set<string>(['any', 'file', 'folder']);

/** `>10mb` → min, `<1kb` → max, `empty` / a band name → both. */
const parseSize = (spec: string): { min: number | null; max: number | null } | null => {
  const band = sizePresets.find((p) => p.key === spec);
  if (band) return { min: band.min, max: band.max };
  const m = /^([<>])=?\s*(\d+(?:\.\d+)?)\s*([kmgt]?b)?$/.exec(spec);
  if (!m) return null;
  const bytes = Math.round(parseFloat(m[2]) * UNIT[m[3] ?? 'b']);
  return m[1] === '>' ? { min: bytes, max: null } : { min: null, max: bytes };
};

export const parseQuery = (text: string, chips: SearchChips, now = new Date()): SearchQuery => {
  const words: string[] = [];
  let ext: string | null = null;
  let kind: SearchKind = 'any';
  let modifiedAfterMs: number | null = null;
  let minBytes: number | null = null;
  let maxBytes: number | null = null;

  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    const colon = lower.indexOf(':');
    const key = colon > 0 ? lower.slice(0, colon) : '';
    const value = colon > 0 ? token.slice(colon + 1) : '';
    if (lower.startsWith('*.') && lower.length > 2) ext = lower.slice(2);
    else if (key === 'ext' && value) ext = value.toLowerCase().replace(/^\*?\./, '');
    else if (key === 'name' && value) words.push(value);
    else if (key === 'kind' && KINDS.has(value.toLowerCase()))
      kind = value.toLowerCase() as SearchKind;
    else if (key === 'modified' && PERIODS.has(value.toLowerCase()))
      modifiedAfterMs = dateAfter(value.toLowerCase() as DatePeriod, now);
    else if (key === 'size' && parseSize(value.toLowerCase()))
      ({ min: minBytes, max: maxBytes } = parseSize(value.toLowerCase())!);
    else words.push(token);
  }

  if (chips.kind !== null) kind = chips.kind;
  if (chips.modified !== null) modifiedAfterMs = dateAfter(chips.modified, now);
  if (chips.size !== null) {
    const band = sizePresets.find((p) => p.key === (chips.size as SizeKey))!;
    minBytes = band.min;
    maxBytes = band.max;
  }

  return { text: words.join(' '), ext, kind, modifiedAfterMs, minBytes, maxBytes };
};

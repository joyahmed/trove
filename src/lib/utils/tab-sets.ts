// Named tab sets (plan 08 F3): the folders open in a window, saved under a name and recalled
// later — the answer to "6 project folders open, then a reboot". A set holds `tabToken`s (a
// folder's path or a place's fixed token, as the session file does) and the active index.
// Pure functions only; the settings own the list and `state/tab-sets` does the asking.
/** how many sets are kept; saving a new name past the cap is refused, never a silent drop */
export const MAX_TAB_SETS = 30;
/** tabs per set — the same 20 a session remembers (`MAX_OPEN_TABS`) */
export const MAX_TAB_SET_TABS = 20;
/** the longest name, in characters */
export const MAX_TAB_SET_NAME = 60;

export interface TabSet {
  name: string;
  /** `tabToken`s, as the session file writes them */
  tabs: string[];
  /** index of the tab that was active */
  active: number;
  /** ms since the epoch */
  savedAt: number;
}

/** A name as stored: trimmed, inner runs of whitespace folded to one space. */
export const cleanTabSetName = (name: string): string => name.replace(/\s+/g, ' ').trim();

/** Names match without regard to case: "Work" and "work" are one set. */
export const tabSetKey = (name: string): string => cleanTabSetName(name).toLowerCase();

/** Why `name` cannot be used, or null. */
export const tabSetNameProblem = (name: string): string | null => {
  const n = cleanTabSetName(name);
  if (n === '') return 'Type a name for the tab set';
  if (n.length > MAX_TAB_SET_NAME) return `Use ${MAX_TAB_SET_NAME} characters or fewer`;
  return null;
};

/** Settings file → a clean list: bad entries dropped, a repeated name (any case) keeps the first. */
export const sanitizeTabSets = (raw: unknown): TabSet[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TabSet[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    if (typeof o.name !== 'string' || !Array.isArray(o.tabs)) continue;
    const name = cleanTabSetName(o.name).slice(0, MAX_TAB_SET_NAME).trim();
    const key = name.toLowerCase();
    if (name === '' || seen.has(key)) continue;
    const tabs = o.tabs
      .filter((t): t is string => typeof t === 'string' && t !== '')
      .slice(0, MAX_TAB_SET_TABS);
    if (tabs.length === 0) continue;
    const active =
      typeof o.active === 'number' && Number.isInteger(o.active) && o.active >= 0
        ? Math.min(o.active, tabs.length - 1)
        : 0;
    const savedAt = typeof o.savedAt === 'number' && Number.isFinite(o.savedAt) ? o.savedAt : 0;
    seen.add(key);
    out.push({ name, tabs, active, savedAt });
    if (out.length >= MAX_TAB_SETS) break;
  }
  return out;
};

export const findTabSet = (sets: TabSet[], name: string): TabSet | undefined => {
  const key = tabSetKey(name);
  return sets.find((s) => tabSetKey(s.name) === key);
};

/** Save `set`: an existing name (any case) is replaced in place, a new one goes first. Null at the cap. */
export const withTabSet = (sets: TabSet[], set: TabSet): TabSet[] | null => {
  const key = tabSetKey(set.name);
  const at = sets.findIndex((s) => tabSetKey(s.name) === key);
  if (at >= 0) return sets.map((s, i) => (i === at ? set : s));
  if (sets.length >= MAX_TAB_SETS) return null;
  return [set, ...sets];
};

/** `from` renamed to `to`; null when `to` is another set's name or `from` is gone. */
export const renamedTabSet = (sets: TabSet[], from: string, to: string): TabSet[] | null => {
  const fromKey = tabSetKey(from);
  const toKey = tabSetKey(to);
  if (!sets.some((s) => tabSetKey(s.name) === fromKey)) return null;
  if (toKey !== fromKey && sets.some((s) => tabSetKey(s.name) === toKey)) return null;
  return sets.map((s) => (tabSetKey(s.name) === fromKey ? { ...s, name: cleanTabSetName(to) } : s));
};

export const withoutTabSet = (sets: TabSet[], name: string): TabSet[] => {
  const key = tabSetKey(name);
  return sets.filter((s) => tabSetKey(s.name) !== key);
};

/** The palette's per-set rows: `tab-set-open:<name>` … (the name follows the colon). */
export const TAB_SET_VERBS = ['open', 'rename', 'delete'] as const;
export const tabSetActionKey = (verb: (typeof TAB_SET_VERBS)[number], name: string) =>
  `tab-set-${verb}:${name}`;

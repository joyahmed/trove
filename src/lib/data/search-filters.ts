// Explorer's search filters as data: the Kind / Date modified / Size presets behind the chips
// and the `kind:` `modified:` `size:` words in the box. Pure; the parser and the chip menus
// both read this file.
import type { SearchKind } from '$lib/types/search';

export type DatePeriod = 'today' | 'thisweek' | 'thismonth' | 'thisyear';
export type SizeKey = 'empty' | 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gigantic';

/** What the three chips hold; null = not filtering on that axis. */
export interface SearchChips {
  kind: SearchKind | null;
  modified: DatePeriod | null;
  size: SizeKey | null;
}

export const emptyChips = (): SearchChips => ({ kind: null, modified: null, size: null });

export const kindOptions: { key: SearchKind; label: string }[] = [
  { key: 'any', label: 'Anything' },
  { key: 'file', label: 'Files' },
  { key: 'folder', label: 'Folders' },
];

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** Explorer's size bands; `max` is exclusive of the next band's `min`. */
export const sizePresets: {
  key: SizeKey;
  label: string;
  min: number | null;
  max: number | null;
}[] = [
  { key: 'empty', label: 'Empty (0 KB)', min: 0, max: 0 },
  { key: 'tiny', label: 'Tiny (0 – 16 KB)', min: 0, max: 16 * KB },
  { key: 'small', label: 'Small (16 KB – 1 MB)', min: 16 * KB, max: MB },
  { key: 'medium', label: 'Medium (1 – 128 MB)', min: MB, max: 128 * MB },
  { key: 'large', label: 'Large (128 MB – 1 GB)', min: 128 * MB, max: GB },
  { key: 'huge', label: 'Huge (1 – 4 GB)', min: GB, max: 4 * GB },
  { key: 'gigantic', label: 'Gigantic (> 4 GB)', min: 4 * GB, max: null },
];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** The earliest modified time a period includes, as Unix ms, relative to `now`. */
export const dateAfter = (period: DatePeriod, now: Date): number => {
  const day = startOfDay(now);
  switch (period) {
    case 'today':
      return day.getTime();
    case 'thisweek': {
      const monday = new Date(day);
      monday.setDate(day.getDate() - ((day.getDay() + 6) % 7));
      return monday.getTime();
    }
    case 'thismonth':
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    case 'thisyear':
      return new Date(now.getFullYear(), 0, 1).getTime();
  }
};

export const datePeriods: { key: DatePeriod; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'thisweek', label: 'This week' },
  { key: 'thismonth', label: 'This month' },
  { key: 'thisyear', label: 'This year' },
];

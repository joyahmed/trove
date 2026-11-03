// How far the name index's first walks have got (plan 21C.2a), for the palette footer:
// "indexing D: — 412,000 so far". Fed by every index answer (`filesSource`) and, while a root is
// still filling, by the footer asking again (`use-index-footer`).
import type { IndexFilling } from '$lib/api/palette';

class IndexProgressState {
  /** the roots still on their first walk, in walk order: the first is the one walking */
  filling = $state.raw<IndexFilling[]>([]);

  set(filling: IndexFilling[]) {
    this.filling = filling;
  }

  /** "indexing D: — 412,000 so far, 2 more after", or null once every root is ready */
  get label(): string | null {
    const [now, ...rest] = this.filling;
    if (!now) return null;
    const more = rest.length > 0 ? `, ${rest.length} more after` : '';
    return `indexing ${now.label} — ${now.seen.toLocaleString()} so far${more}`;
  }
}

export const indexProgress = new IndexProgressState();

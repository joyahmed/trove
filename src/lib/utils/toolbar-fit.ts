// Which toolbar parts give way as the window narrows (plan 15 G.73). Pure: the hook measures the
// toolbar and asks; the toolbar hides what this says and its "…" button offers the rest.
//
// Every px below is the part's own Tailwind size in `NavBar` and its parts — change both together.

/** A part that can give way, in the order it does. */
export type ToolbarPart = 'view' | 'trailing' | 'newLabel' | 'refresh' | 'search';

/** px between the toolbar's parts (`gap-2`) */
const GAP_PX = 8;

/**
 * What never gives way: the side padding (`px-3`), back / forward / up (three `size-8` with
 * `gap-0.5`) and the address bar at its `min-w-40`. The address bar always keeps its minimum.
 */
export const TOOLBAR_FLOOR_PX = 24 + (3 * 32 + 2 * 2) + 160;

/** the "…" button (`w-9`) and its gap, paid once something has moved into it */
export const OVERFLOW_BUTTON_PX = 36 + GAP_PX;

/**
 * The parts in the order they give way — the least used first — and the px each frees.
 * `newLabel` keeps the button and drops its words ("+ New" becomes "+"); the rest move into the
 * "…" menu whole.
 */
export const toolbarParts: { key: ToolbarPart; px: number; overflows: boolean }[] = [
  // Icons / List / Details / Gallery (Gallery shows in any folder, so count it): 4 × w-8 +
  // 3 × gap-0.5 + p-0.5 + border. Counted as 3 segments this left the gear cut off at 800px.
  { key: 'view', px: 4 * 32 + 3 * 2 + 4 + 2 + GAP_PX, overflows: true },
  // Details pane and Settings: two w-9 squares
  { key: 'trailing', px: 2 * 36 + GAP_PX, overflows: true },
  // "+ New ▾" / "Filters ▾" (px-2.5, glyph, gap, label, chevron; Filters is the wider) down to w-9
  { key: 'newLabel', px: 110 - 36, overflows: false },
  // the fourth nav button (w-8 + gap-0.5)
  { key: 'refresh', px: 32 + 2, overflows: true },
  // the search box at its min-w-36
  { key: 'search', px: 144 + GAP_PX, overflows: true },
];

/** px the toolbar needs with every part showing: the floor, the parts, and New as a w-9 square */
export const TOOLBAR_FULL_PX =
  TOOLBAR_FLOOR_PX + GAP_PX + 36 + toolbarParts.reduce((sum, p) => sum + p.px, 0);

export interface ToolbarFit {
  /** the parts that have given way */
  collapsed: ToolbarPart[];
  /** the "…" button shows: at least one part moved into its menu */
  overflow: boolean;
}

/**
 * The parts that give way at `width` px, fewest first: each one in turn until what is left fits.
 * The first part that moves into the "…" menu also pays for the "…" button. Below the floor
 * everything has given way and the address bar keeps its minimum (the row clips, never wraps).
 */
export const toolbarFit = (width: number): ToolbarFit => {
  const collapsed: ToolbarPart[] = [];
  let need = TOOLBAR_FULL_PX;
  let overflow = false;
  for (const part of toolbarParts) {
    if (need <= width) break;
    collapsed.push(part.key);
    need -= part.px;
    if (part.overflows && !overflow) {
      overflow = true;
      need += OVERFLOW_BUTTON_PX;
    }
  }
  return { collapsed, overflow };
};

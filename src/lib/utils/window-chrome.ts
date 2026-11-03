// Who draws the window's buttons. Windows and Linux: Trove does (`CaptionButtons.svelte`, the
// window is undecorated). macOS: the system does — `tauri.macos.conf.json` and
// `commands/windows.rs` give every explorer window the native traffic lights over the tab strip
// (titleBarStyle Overlay, hidden title), so Trove's own buttons hide and the strip moves right.
// Plan 12 F / plan 10 E. Off Tauri nothing is injected and Windows' layout applies.
import { onMac } from '$lib/utils/platform';

type Platform = Parameters<typeof onMac>[0];

/** Room the traffic lights take at the left of the tab strip, in px. The lights sit at x 14
 * (`trafficLightPosition`) and the three of them span ~54 px, so 78 leaves a ~10 px gap. */
export const MAC_TRAFFIC_LIGHT_INSET_PX = 78;

/** The strip's ordinary left padding (`pl-2.5`), in px. */
export const TAB_STRIP_PAD_PX = 10;

// ⛔ `undefined` means "read what Rust injected" — the default parameter fills it — not "no OS".

/** Whether Trove draws its own minimize / maximize / close. Not on a Mac: the system's are there. */
export const drawsCaptionButtons = (platform?: Platform): boolean => !onMac(platform);

/** Classes for one caption button. Close gets its own hover (red, white icon) and never the grey
 * one: both set `background-color`, and whichever Tailwind emits last wins — the grey did.
 * `-outline-offset-2` draws the keyboard focus ring INSIDE the button: the buttons fill the title
 * bar from the window's top edge, so the app-wide ring (`app.css`, 1px outside) lost its top to the
 * window edge and its bottom under the toolbar. Utilities beat that `@layer base` rule. */
export const captionButtonClass = (key: string): string =>
  `w-caption active:bg-subtle-pressed grid h-full place-items-center -outline-offset-2 ${
    key === 'close' ? 'hover:bg-close-hover hover:text-white' : 'hover:bg-subtle-hover'
  }`;

/** Left padding of the tab strip, in px: clear of the traffic lights on a Mac, the ordinary
 * 10 px everywhere else — and on a Mac in full screen, where the system hides the lights. */
export const tabStripInsetPx = (fullscreen = false, platform?: Platform): number =>
  drawsCaptionButtons(platform) || fullscreen ? TAB_STRIP_PAD_PX : MAC_TRAFFIC_LIGHT_INSET_PX;

/** The slice of an element `isTauriDragRegion` reads — kept narrow so tests need no DOM. */
export interface DragPathNode {
  tagName?: string;
  getAttribute?: (name: string) => string | null;
}

const CLICKABLE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY']);
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'option',
]);

const isClickable = (el: Required<DragPathNode>): boolean => {
  const editable = el.getAttribute('contenteditable');
  const tabindex = el.getAttribute('tabindex');
  return (
    CLICKABLE_TAGS.has(el.tagName) ||
    (editable !== null && editable !== 'false') ||
    (tabindex !== null && tabindex !== '-1') ||
    INTERACTIVE_ROLES.has(el.getAttribute('role') ?? '')
  );
};

/**
 * Whether Tauri's own drag script treats a click with this composed path as a click on a drag
 * region — and so, on a Mac, zooms the window itself on a double-click there. A line-for-line
 * mirror of `isDragRegion` in tauri 2.11.6 `src/window/scripts/drag.js`; ⛔ change both or
 * neither, or a double-click zooms twice (and undoes itself) or not at all.
 */
export const isTauriDragRegion = (path: readonly unknown[]): boolean => {
  for (const node of path) {
    const el = node as DragPathNode;
    if (typeof el?.getAttribute !== 'function' || typeof el.tagName !== 'string') continue;
    const full = el as Required<DragPathNode>;
    const attr = full.getAttribute('data-tauri-drag-region');
    if (isClickable(full) && attr === null) return false;
    if (attr === null) continue;
    if (attr === 'false') return false;
    if (attr === 'deep') return true;
    if (attr === '' || attr === 'true') return node === path[0];
  }
  return false;
};

/**
 * Whether the title bar's own double-click handler should toggle maximize: only where Tauri's
 * drag script did not already do it — a gap in the tab list, say — so a double-click anywhere on
 * the bar toggles exactly once, on every OS. On Windows and Linux the script toggles on the
 * second mousedown, on a Mac on its mouseup; the `dblclick` still arrives afterwards.
 * ⛔ Toggling here too undid the script's toggle: on Linux `max=true,max=false` in one
 * double-click (seen 2026-10-23, hidden GNOME shell), on Windows a double-click restored nothing
 * (4 of 4 on Windows, 2026-10-23) — both read `is_maximized` and flip it, so they race.
 */
export const titleBarDblclickZooms = (path: readonly unknown[]): boolean =>
  !isTauriDragRegion(path);

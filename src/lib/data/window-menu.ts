// The window menu (plan 20): a right-click on the title bar's empty part. The frameless window
// gets neither the OS title bar's menu nor Windows' taskbar menu, so this is both in one —
// Minimize, Maximize / Restore, the Snap halves where Trove binds their keys, the three arrange
// commands, Close. Data only: the actions come in from the hook (or `windowMenuApi`).
import type { MenuItem } from '$lib/hooks/use-menu.svelte';
import * as win from '$lib/api/window';
import type { WindowLayout } from '$lib/api/window';
import { notices } from '$lib/state/notices.svelte';
import { snapHint, snapKeysOn, type SnapKey } from '$lib/utils/key-label';
import { comingFrom, hostStyle, type OsStyle } from '$lib/state/coming-from.svelte';

export interface WindowMenuHandlers {
  minimize: () => unknown;
  toggleMaximize: () => unknown;
  snap: (key: SnapKey) => unknown;
  arrange: (layout: WindowLayout) => unknown;
  close: () => unknown;
}

/** The three arrange rows, Windows' taskbar words; also Find anything's (data/palette-actions). */
export const ARRANGE_ROWS: { key: string; label: string; layout: WindowLayout }[] = [
  { key: 'cascade-windows', label: 'Cascade windows', layout: 'cascade' },
  { key: 'stack-windows', label: 'Show windows stacked', layout: 'stacked' },
  { key: 'windows-side-by-side', label: 'Show windows side by side', layout: 'side-by-side' },
];

export const windowMenuFor = (
  maximized: boolean,
  on: WindowMenuHandlers,
  style: OsStyle = comingFrom.style,
  host: OsStyle = hostStyle(),
): MenuItem[] => {
  const snap = snapKeysOn(style, host);
  return [
    { kind: 'item', key: 'minimize', label: 'Minimize', glyph: 'minimize', run: on.minimize },
    {
      kind: 'item',
      key: 'maximize',
      label: maximized ? 'Restore' : 'Maximize',
      glyph: maximized ? 'restore' : 'maximize',
      run: on.toggleMaximize,
    },
    ...(snap
      ? ([
          {
            kind: 'item',
            key: 'snap-left',
            label: 'Snap left',
            shortcut: snapHint('left', style, host),
            run: () => on.snap('left'),
          },
          {
            kind: 'item',
            key: 'snap-right',
            label: 'Snap right',
            shortcut: snapHint('right', style, host),
            run: () => on.snap('right'),
          },
        ] satisfies MenuItem[])
      : []),
    { kind: 'divider', key: 'd-arrange' },
    ...ARRANGE_ROWS.map((row): MenuItem => ({
      kind: 'item',
      key: row.key,
      label: row.label,
      run: () => on.arrange(row.layout),
    })),
    { kind: 'divider', key: 'd-close' },
    { kind: 'item', key: 'close', label: 'Close', glyph: 'close', run: on.close },
  ];
};

/** A window call that fails says so in a notice instead of vanishing. */
const said = (p: Promise<unknown>) =>
  p.catch((e) => notices.push({ kind: 'warning', message: String(e) }));

/** Arrange every Trove window; the window menu and Find anything both run this. */
export const arrangeWindows = (layout: WindowLayout) => said(win.arrangeWindows(layout));

/** The real handlers for this window. */
export const windowMenuApi: WindowMenuHandlers = {
  minimize: () => said(win.minimize()),
  toggleMaximize: () => said(win.toggleMaximize()),
  snap: (key) => said(win.snapWindow(key)),
  arrange: arrangeWindows,
  close: () => said(win.close()),
};

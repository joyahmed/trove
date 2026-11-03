import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAC_TRAFFIC_LIGHT_INSET_PX,
  TAB_STRIP_PAD_PX,
  captionButtonClass,
  drawsCaptionButtons,
  isTauriDragRegion,
  tabStripInsetPx,
  titleBarDblclickZooms,
} from '$lib/utils/window-chrome';

const mac = { os: 'macos', thisPcLabel: 'This Mac' };
const windows = { os: 'windows', thisPcLabel: 'This PC' };
const linux = { os: 'linux', thisPcLabel: 'This Computer' };

/** A stand-in element: a tag and its attributes, all `drag.js` reads. */
const el = (tagName: string, attrs: Record<string, string> = {}) => ({
  tagName,
  getAttribute: (name: string) => attrs[name] ?? null,
});

describe('who draws the window buttons', () => {
  it('is the system on a Mac: no caption buttons, the strip clears the traffic lights', () => {
    expect(drawsCaptionButtons(mac)).toBe(false);
    expect(tabStripInsetPx(false, mac)).toBe(MAC_TRAFFIC_LIGHT_INSET_PX);
    expect(MAC_TRAFFIC_LIGHT_INSET_PX).toBe(78);
  });

  it('drops the inset in Mac full screen, where the system hides the lights', () => {
    expect(tabStripInsetPx(true, mac)).toBe(TAB_STRIP_PAD_PX);
  });

  it('is Trove on Windows and Linux, with the strip where it always was', () => {
    for (const p of [windows, linux]) {
      expect(drawsCaptionButtons(p)).toBe(true);
      expect(tabStripInsetPx(false, p)).toBe(10);
      expect(tabStripInsetPx(true, p)).toBe(10);
    }
  });

  it("is Trove when nothing was injected (tests, a plain browser): Windows' layout", () => {
    expect(drawsCaptionButtons()).toBe(true);
    expect(tabStripInsetPx()).toBe(10);
  });
});

describe('read from what Rust injected', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hides the buttons when `platform_init_script` said macos', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: mac });
    expect(drawsCaptionButtons()).toBe(false);
    expect(tabStripInsetPx()).toBe(MAC_TRAFFIC_LIGHT_INSET_PX);
  });

  it('keeps them when it said windows', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: windows });
    expect(drawsCaptionButtons()).toBe(true);
  });
});

describe("isTauriDragRegion — the mirror of Tauri's drag.js", () => {
  const header = el('HEADER', { 'data-tauri-drag-region': '', role: 'toolbar', tabindex: '-1' });
  const tablist = el('DIV', { role: 'tablist' });

  it('is a bare drag region only when it was clicked directly', () => {
    expect(isTauriDragRegion([header])).toBe(true);
    // a gap in the tab list: the header is above it but was not the target
    expect(isTauriDragRegion([tablist, header])).toBe(false);
  });

  it('is the lights spacer, clicked directly', () => {
    const spacer = el('DIV', { 'data-tauri-drag-region': '', 'aria-hidden': 'true' });
    expect(isTauriDragRegion([spacer, tablist, header])).toBe(true);
  });

  it('is never a tab or a button without the attribute', () => {
    expect(isTauriDragRegion([el('DIV', { role: 'tab' }), tablist, header])).toBe(false);
    expect(isTauriDragRegion([el('BUTTON'), header])).toBe(false);
  });

  it('follows "deep" and "false"', () => {
    expect(isTauriDragRegion([el('SPAN'), el('DIV', { 'data-tauri-drag-region': 'deep' })])).toBe(
      true,
    );
    expect(isTauriDragRegion([el('SPAN', { 'data-tauri-drag-region': 'false' }), header])).toBe(
      false,
    );
  });

  it('skips nodes that are not elements (document, window)', () => {
    expect(isTauriDragRegion([header, {}, null])).toBe(true);
    expect(isTauriDragRegion([])).toBe(false);
  });
});

describe('titleBarDblclickZooms — a double-click zooms exactly once', () => {
  const header = el('HEADER', { 'data-tauri-drag-region': '' });
  const gap = [el('DIV', { role: 'tablist' }), header];

  // ⛔ Tauri's script toggles on the drag region on every OS; a second toggle here undid it —
  // on GNOME (max=true,max=false) and on Windows (restore by double-click failed 4 of 4 on Windows)
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['a Mac', mac],
    ['Windows', windows],
    ['Linux', linux],
  ])('on %s, leaves a drag region to Tauri and zooms only in a gap', (_, platform) => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: platform });
    expect(titleBarDblclickZooms([header])).toBe(false);
    expect(titleBarDblclickZooms(gap)).toBe(true);
  });
});

describe('captionButtonClass', () => {
  it('turns Close red on hover and never carries the grey hover', () => {
    const classes = captionButtonClass('close').split(/\s+/);
    expect(classes).toContain('hover:bg-close-hover');
    expect(classes).toContain('hover:text-white');
    expect(classes).not.toContain('hover:bg-subtle-hover');
  });

  it('keeps the grey hover on minimize and maximize', () => {
    for (const key of ['minimize', 'maximize']) {
      const classes = captionButtonClass(key).split(/\s+/);
      expect(classes).toContain('hover:bg-subtle-hover');
      expect(classes).not.toContain('hover:bg-close-hover');
    }
  });

  it('draws the focus ring inside every button, so the window edge cannot clip it', () => {
    for (const key of ['minimize', 'maximize', 'close']) {
      expect(captionButtonClass(key).split(/\s+/)).toContain('-outline-offset-2');
    }
  });
});

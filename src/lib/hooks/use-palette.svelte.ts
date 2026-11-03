// The palette's reactivity: sources wired in, focus on show, and the keyboard. Two homes: the
// Spotlight window (the palette route, no `host`) and Find anything, the same palette as a panel
// inside an explorer window (`host` given). The Spotlight window's own height is the state's job,
// not an effect's.
import { untrack } from 'svelte';
import { keyedIcon } from '$lib/utils/file-icon';
import { onPaletteShown } from '$lib/api/palette';
import { onSettingsChanged, readSettings } from '$lib/api/settings';
import { currentWindowLabel } from '$lib/api/window';
import { makePaletteSources, paletteSources, type PaletteTarget } from '$lib/data/palette-sources';
import { palette } from '$lib/state/palette.svelte';
import { settings } from '$lib/state/settings.svelte';
import { PaletteSettings } from '$lib/state/palette-settings';
import type { PaletteResult } from '$lib/types/palette';
import { logError } from '$lib/api/log';
import { isRevealKey } from '$lib/utils/key-label';

/**
 * Find anything: whether the in-window panel is open, and where the keyboard goes back to when it
 * closes. Ctrl+K (⌘K) and the search box's chip open it (`data/shortcuts.ts`, SearchBox.svelte).
 */
/**
 * Ctrl+K must not open the panel where it cannot be seen or where the key belongs to someone else:
 * - under a modal dialog (Settings, a confirm): the panel would sit beneath it, take the keyboard,
 *   and Enter would run a result nobody can see;
 * - from inside the terminal: the shell already got ^K (kill-line), and the panel would steal its
 *   focus. Ctrl+` and the other chords are untouched; only Find anything stands down.
 */
export const canOpenFindAnything = (
  focused: Element | null,
  doc: Pick<Document, 'querySelector'> | null,
): boolean => {
  if (focused?.closest('[aria-label="Terminal pane"]')) return false;
  return !doc?.querySelector('[role="dialog"][aria-modal="true"]');
};

class FindAnything {
  open = $state(false);
  #returnTo: HTMLElement | null = null;

  show = () => {
    if (this.open) return;
    // no DOM in the unit tests, which drive this through the shortcut table
    const el = typeof document === 'undefined' ? null : document.activeElement;
    if (!canOpenFindAnything(el, typeof document === 'undefined' ? null : document)) return;
    this.#returnTo = el !== null && 'focus' in el ? (el as HTMLElement) : null;
    this.open = true;
  };

  /** `restore: false` when the keyboard already went somewhere else on purpose (Ctrl+F). */
  close = (restore = true) => {
    if (!this.open) return;
    this.open = false;
    const el = this.#returnTo;
    this.#returnTo = null;
    if (restore) el?.focus();
  };

  toggle = () => (this.open ? this.close() : this.show());
}

export const findAnything = new FindAnything();

/**
 * The window the palette is a panel inside, rather than a window of its own: what Esc and a run
 * close, and what a result acts on — this window, not the main one the Spotlight events reach.
 */
export interface PaletteHost {
  close: () => void;
  target: PaletteTarget;
}

export const usePalette = (host?: PaletteHost) => {
  let input = $state<HTMLInputElement | null>(null);
  // a panel never sizes the Spotlight window: it is hidden, and not this palette
  palette.configure(host ? makePaletteSources(host.target) : paletteSources, {
    sizesWindow: !host,
  });

  // Shown by the hotkey: start clean, take the keyboard, and re-read settings.json — pins and
  // recent folders are written by the explorer window; this window only ever reads them
  // (`settings.loaded` stays false here, so nothing is ever saved from the palette).
  // ⚠️ It also listens to `settings:changed` while hidden, so a theme picked in the explorer is
  // already applied when Rust shows the window — the first frame is the new theme, not the old.
  // A re-read can be up to `SAVE_DELAY_MS` older than that live value; `PaletteSettings` holds
  // the live value over the file until the file catches up (state/palette-settings.ts).
  const sync = new PaletteSettings(settings);
  const syncSettings = async () => {
    const done = sync.beginRead();
    try {
      done(await readSettings());
    } catch (e) {
      logError('palette.readSettings', e);
      // the defaults are fine for a palette
    }
  };
  $effect(() => {
    // In a window: mounted when opened, so start clean and stop whatever is in flight on close.
    // Settings are this window's own, live — nothing to re-read.
    if (host) {
      untrack(() => palette.reset());
      return () => untrack(() => palette.reset());
    }
    // ⚠️ untracked: `syncWindow` reads the height, and a tracked read here would re-run this
    // effect on every paint — tearing down and re-registering the listener, and re-reading
    // settings.json, once per source per query. It is a mount-time push, nothing more.
    untrack(() => palette.syncWindow());
    const unlistenSettings = onSettingsChanged(currentWindowLabel(), (patch) =>
      untrack(() => sync.live(patch)),
    );
    void syncSettings();
    const unlisten = onPaletteShown(() => {
      palette.reset();
      input?.focus();
      void syncSettings();
    });
    return () => {
      void unlisten.then((f) => f());
      void unlistenSettings.then((f) => f()).catch(() => {});
    };
  });

  // ⛔ The window height is NOT an effect any more. `$effect(() => resizePalette(palette.height))`
  // over a height derived from `results.length` + `groups.length` meant one physical OS resize per
  // source per query — nine of them, the window accordioning open and shut while the rows moved
  // underneath: "the search is behaving like react re-render with useEffect badly". The state
  // resizes the window itself, once per paint, and only when the height actually changed.

  // Every arrow/Tab move bumps this, and the row that is lit scrolls itself into view. The mouse
  // deliberately does not bump it: see the note in ResultRow.svelte.
  let keyMove = $state(0);

  const onkeydown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        palette.move(1);
        keyMove++;
        break;
      case 'ArrowUp':
        palette.move(-1);
        keyMove++;
        break;
      case 'Tab':
        palette.nextCategory();
        keyMove++;
        break;
      case 'Enter':
        void (isRevealKey(e) ? palette.reveal() : palette.run());
        host?.close();
        break;
      case 'Escape':
        if (host) host.close();
        else void palette.hide();
        break;
      default:
        return;
    }
    e.preventDefault();
    // in a window, the shell's own keys must not act on what the palette already handled
    if (host) e.stopPropagation();
  };

  /** `use:` action for the input: remember it for focusing, focus it now */
  const attach = (el: HTMLInputElement) => {
    input = el;
    el.focus();
    return {
      destroy() {
        if (input === el) input = null;
      },
    };
  };

  return {
    get query() {
      return palette.query;
    },
    set query(v: string) {
      palette.setQuery(v);
    },
    get groups() {
      return palette.groups;
    },
    get busy() {
      return palette.busy;
    },
    get keyMove() {
      return keyMove;
    },
    isSelected: (r: PaletteResult) => palette.current === r,
    /** a row reports the pointer over it; only a real move selects (state/palette.svelte.ts) */
    hover: (r: PaletteResult, x: number, y: number) =>
      palette.hover(palette.results.indexOf(r), x, y),
    pointerLeft: () => palette.pointerLeft(),
    run: (r: PaletteResult) => {
      palette.select(palette.results.indexOf(r));
      void palette.run();
      host?.close();
    },
    /** how the row's shell-keyed icon is drawn, or null when it has only a glyph */
    icon: (r: PaletteResult) => (r.iconKey ? keyedIcon(r.iconKey, 16) : null),
    onkeydown,
    attach,
  };
};

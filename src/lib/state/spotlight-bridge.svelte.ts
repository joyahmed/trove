// The explorer window's side of Spotlight: it owns the chord (registered once it is up, so a
// clash is a notice) and does what the palette asks — an action, a folder, a file to reveal.
import {
  onHotkeyFailed,
  onSpotlightAction,
  onSpotlightNavigate,
  onSpotlightOpenFailed,
  onSpotlightReveal,
  onSpotlightSearch,
  registerHotkey,
} from '$lib/api/palette';
import { paletteActionRunners } from '$lib/data/palette-action-runners';
import { actions } from '$lib/state/actions.svelte';
import { search } from '$lib/state/search.svelte';
import { selection } from '$lib/state/selection.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { THIS_PC, pathLocation } from '$lib/utils/location';
import { parentOf } from '$lib/utils/path';

class SpotlightBridge {
  hotkeyError = $state<string | null>(null);
  /**
   * The chord registered, but the desktop binds it too (GNOME, D.5.2), so the press may never
   * arrive. Not an error: the chord is saved, and clearing the GNOME key makes it work.
   */
  hotkeyConflict = $state<string | null>(null);

  runAction(key: string) {
    const run = paletteActionRunners[key];
    if (run) void run();
  }

  navigate(path: string) {
    void tabs.active.navigate(pathLocation(path));
  }

  /** Show the file's folder with the file selected — `/select,` semantics. */
  async reveal(path: string) {
    const parent = parentOf(path);
    if (!parent) return this.navigate(path);
    await tabs.active.navigate(pathLocation(parent));
    selection.reveal(path);
  }

  /** "Search everywhere": every drive, from This PC, in the explorer's own search. */
  async searchEverywhere(text: string) {
    await tabs.active.navigate(THIS_PC);
    await search.start(text);
  }

  /**
   * Take the chord the settings ask for. Re-callable: the Rust side releases the previous
   * registration first, so changing the shortcut does not leave the old one live. Resolves
   * true when the OS took the chord, false when it refused (the Rust side then keeps the
   * previous chord live), so a caller can save the chord only once it is known to work.
   */
  register(chord: string): Promise<boolean> {
    this.hotkeyError = null;
    this.hotkeyConflict = null;
    return registerHotkey(chord).then(
      (conflict) => {
        this.hotkeyConflict = conflict ?? null;
        // The conflict's toast rides the `hotkey-failed` event, whose listener may have run
        // first and filed it as an error; it is not one.
        if (conflict && this.hotkeyError === conflict) this.hotkeyError = null;
        return true;
      },
      (e) => {
        // The warning toast comes from the `hotkey-failed` event (once per run); toasting here
        // too showed it twice.
        this.hotkeyError = String(e);
        return false;
      },
    );
  }

  /**
   * Subscribe; returns the detach fn.
   *
   * ⛔ Does NOT register the chord. This runs synchronously inside the shell's startup effect
   * while `settings.load()` is still in flight, so registering here would always take the
   * DEFAULT and silently ignore the chord the person chose. The caller registers once settings
   * have landed.
   */
  attach() {
    const subs = [
      onHotkeyFailed((m) => {
        if (m !== this.hotkeyConflict) this.hotkeyError = m;
        actions.notify(m, 'warning');
      }),
      onSpotlightAction((k) => this.runAction(k)),
      onSpotlightNavigate((p) => this.navigate(p)),
      onSpotlightReveal((p) => void this.reveal(p)),
      onSpotlightSearch((t) => void this.searchEverywhere(t)),
      // The palette could not open something (no default browser, most likely). It has its own
      // JS realm and no toast of its own, so this is the only place the person is told.
      onSpotlightOpenFailed((m) => actions.notify(m, 'error')),
    ];
    return () => subs.forEach((s) => void s.then((f) => f()));
  }
}

export const spotlight = new SpotlightBridge();

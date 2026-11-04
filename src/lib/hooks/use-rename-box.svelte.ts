// The inline rename field: Enter commits, Escape cancels, blur commits (Explorer's behaviour),
// and the name is pre-selected without its extension so typing replaces the stem. With
// "File name extensions" off the box holds the base name only and the extension is kept
// (`actions.startRename`), as Explorer does. A box that
// unmounts while still open (its row scrolled out of the virtual window) commits a changed
// draft rather than losing it.
import { tick } from 'svelte';
import { findAnythingShortcut, matchShortcut } from '$lib/data/shortcuts';
import { actions } from '$lib/state/actions.svelte';
import { listing } from '$lib/state/listing.svelte';
import { refocusFileList } from '$lib/utils/focus-return';
import { onMac } from '$lib/utils/platform';
import { unmountAction } from '$lib/utils/rename-unmount';

const MIN_SIZE = 8;

export const useRenameBox = () => {
  const path = actions.renaming;

  // The row can leave the DOM with the box open; WebView2 does not fire blur for that.
  // ⛔ `renamingNow`, not `renaming`: in a teardown `renaming` still reads the path after Escape
  // or Ctrl K closed the box, and the half-typed name would be committed.
  $effect(() => {
    return () => {
      if (path === null || actions.renamingNow !== path) return;
      const name = listing.rows.find((e) => e.path === path)?.name ?? '';
      if (unmountAction(actions.draft, name) === 'commit') void actions.commitRename();
      else actions.cancelRename();
    };
  });

  const onkeydown = (e: KeyboardEvent) => {
    e.stopPropagation();
    // Ctrl K / ⌘K still opens Find anything from here; it cancels the rename first (the box
    // stops the key reaching the window, so the chord is run here)
    const palette = matchShortcut(e, true, [findAnythingShortcut(onMac())]);
    if (palette) {
      e.preventDefault();
      void palette.run();
      return;
    }
    if (e.key === 'Enter') void actions.commitRename();
    else if (e.key === 'Escape') actions.cancelRename();
    else return;
    // the box unmounts with the key; without this focus falls to <body> and the arrows, Delete
    // and F2 do nothing until a click. The list is one grid (rows are not focusable), so the
    // renamed row stays selected and focused through selection.
    void tick().then(() => refocusFileList());
  };

  /** `use:` action: focus, select the stem (before the last dot), and scroll into view. */
  const focus = (el: HTMLInputElement) => {
    el.focus();
    // extensions hidden: the box already holds only the base name, so all of it is the stem
    const dot = actions.renameHidesExtension ? -1 : el.value.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  return {
    get draft() {
      return actions.draft;
    },
    set draft(v: string) {
      actions.draft = v;
    },
    /** columns for a box that grows with the text (the horizontal list view) */
    get size() {
      return Math.max(MIN_SIZE, actions.draft.length + 1);
    },
    onkeydown,
    onblur: () => void actions.commitRename(),
    focus,
  };
};

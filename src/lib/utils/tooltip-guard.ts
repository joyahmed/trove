/**
 * No native tooltip over an open context menu. Tiles and rows carry their path as a plain
 * `title`, and the webview draws that bubble where the pointer rests, right on top of the menu
 * a right-click just opened. A `title` cannot be told to hide, so while a menu is up (or a
 * right-click is on its way to opening one) the hovered element's `title` is held back and put
 * back once the menu is gone. One document-level guard, installed once by the root layout, covers
 * every `title` in the app; the hover infotip (`use-infotip`) has its own rule for the same thing.
 * Returns a cleanup.
 */
export function guardTooltips(doc: Document = document): () => void {
  const held = new Map<Element, string>();
  const menuOpen = () => doc.querySelector('[role="menu"]') !== null;

  const hold = (target: EventTarget | null) => {
    const el = (target as Element | null)?.closest?.('[title]') ?? null;
    const title = el?.getAttribute('title');
    if (!el || title === null || title === undefined) return;
    held.set(el, title);
    el.removeAttribute('title');
  };

  const release = () => {
    for (const [el, title] of held) el.setAttribute('title', title);
    held.clear();
  };

  // the menu is not rendered yet when `contextmenu` fires, so a right-click always holds
  const onContext = (e: Event) => hold(e.target);
  const onPointer = (e: Event) => {
    if (menuOpen()) hold(e.target);
    else if (held.size > 0) release();
  };

  doc.addEventListener('contextmenu', onContext, true);
  doc.addEventListener('pointerover', onPointer, true);
  doc.addEventListener('pointermove', onPointer, true);
  return () => {
    doc.removeEventListener('contextmenu', onContext, true);
    doc.removeEventListener('pointerover', onPointer, true);
    doc.removeEventListener('pointermove', onPointer, true);
    release();
  };
}

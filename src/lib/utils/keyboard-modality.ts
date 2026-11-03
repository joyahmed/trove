/** Marks <html data-keyboard> after a Tab/arrow key and clears it on pointerdown, so dialog focus
 *  rings show for keyboard users even where WebKitGTK skips :focus-visible. Returns a cleanup. */
export function trackKeyboardModality(root: HTMLElement = document.documentElement): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab' || e.key.startsWith('Arrow')) root.setAttribute('data-keyboard', '');
  };
  const onPointer = () => root.removeAttribute('data-keyboard');
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onPointer, true);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onPointer, true);
  };
}

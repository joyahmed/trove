// What to do when the rename box disappears while still open — its row scrolled out of the
// virtual window. Explorer commits on losing the box, unless nothing was typed.
export type UnmountAction = 'commit' | 'cancel';

export const unmountAction = (draft: string, name: string): UnmountAction => {
  const typed = draft.trim();
  return typed !== '' && typed !== name ? 'commit' : 'cancel';
};

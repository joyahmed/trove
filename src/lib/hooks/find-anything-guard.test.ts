import { describe, expect, it } from 'vitest';
import { canOpenFindAnything } from './use-palette.svelte';

/** A focused element whose ancestors match the given selectors. */
const focusedIn = (...matches: string[]) =>
  ({ closest: (s: string) => (matches.includes(s) ? {} : null) }) as unknown as Element;
const docWith = (modal: boolean) => ({ querySelector: () => (modal ? ({} as Element) : null) });

describe('canOpenFindAnything', () => {
  it('opens in a plain window, focused anywhere or nowhere', () => {
    expect(canOpenFindAnything(focusedIn(), docWith(false))).toBe(true);
    expect(canOpenFindAnything(null, docWith(false))).toBe(true);
    expect(canOpenFindAnything(null, null)).toBe(true);
  });

  it('stands down under a modal dialog, so Enter cannot run a result nobody sees', () => {
    expect(canOpenFindAnything(focusedIn(), docWith(true))).toBe(false);
  });

  it('stands down when the key came from the terminal (the shell already took ^K)', () => {
    expect(canOpenFindAnything(focusedIn('[aria-label="Terminal pane"]'), docWith(false))).toBe(
      false,
    );
  });
});

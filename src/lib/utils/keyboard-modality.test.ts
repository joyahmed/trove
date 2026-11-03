import { describe, expect, it, vi } from 'vitest';
import { trackKeyboardModality } from './keyboard-modality';

describe('trackKeyboardModality', () => {
  it('sets on Tab, clears on pointerdown, cleans up', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal('window', {
      addEventListener: (t: string, f: (e: unknown) => void) => (handlers[t] = f),
      removeEventListener: (t: string) => delete handlers[t],
    });
    const attrs = new Set<string>();
    const root = {
      setAttribute: (n: string) => attrs.add(n),
      removeAttribute: (n: string) => attrs.delete(n),
    } as unknown as HTMLElement;
    const off = trackKeyboardModality(root);
    handlers.keydown({ key: 'a' });
    expect(attrs.has('data-keyboard')).toBe(false);
    handlers.keydown({ key: 'Tab' });
    expect(attrs.has('data-keyboard')).toBe(true);
    handlers.pointerdown({});
    expect(attrs.has('data-keyboard')).toBe(false);
    off();
    expect(handlers.keydown).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

import { describe, expect, it } from 'vitest';
import { contrastRatio, luminance, textOnAccent } from './contrast';

describe('contrast', () => {
  it('black on white is 21:1, and a non-colour is null', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(luminance('blue')).toBeNull();
    expect(contrastRatio('#fff', '#000000')).toBeNull();
  });

  it('picks white on the sapphire accent and black on its dark-theme tint', () => {
    expect(textOnAccent('#2f4bd0')).toBe('#fff');
    expect(textOnAccent('#8ea2ff')).toBe('#000');
  });

  it('picks black on a yellow and white on a dark red', () => {
    expect(textOnAccent('#ffd400')).toBe('#000');
    expect(textOnAccent('#8b0000')).toBe('#fff');
  });

  it('falls back to white for a value that is not a colour', () => {
    expect(textOnAccent('')).toBe('#fff');
  });
});

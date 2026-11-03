import { describe, expect, it } from 'vitest';
import { wheelToScrollLeft, type ScrollBox } from './wheel-scroll';

const sideways: ScrollBox = {
  scrollWidth: 2000,
  clientWidth: 500,
  scrollHeight: 300,
  clientHeight: 300,
};
const wheel = (deltaY: number, deltaMode = 0, deltaX = 0) => ({ deltaX, deltaY, deltaMode });

describe('wheelToScrollLeft', () => {
  it('maps a pixel deltaY to the same scrollLeft step', () => {
    expect(wheelToScrollLeft(wheel(100), sideways)).toBe(100);
    expect(wheelToScrollLeft(wheel(-100), sideways)).toBe(-100);
  });
  it('turns lines into 16 px each and pages into a client width', () => {
    expect(wheelToScrollLeft(wheel(3, 1), sideways)).toBe(48);
    expect(wheelToScrollLeft(wheel(-1, 2), sideways)).toBe(-500);
  });
  it('passes a wheel that has its own deltaX through', () => {
    expect(wheelToScrollLeft(wheel(10, 0, 30), sideways)).toBeNull();
    expect(wheelToScrollLeft(wheel(0, 0, 30), sideways)).toBeNull();
  });
  it('leaves a list that overflows vertically, or not sideways, alone', () => {
    expect(wheelToScrollLeft(wheel(100), { ...sideways, scrollHeight: 900 })).toBeNull();
    expect(wheelToScrollLeft(wheel(100), { ...sideways, scrollWidth: 500 })).toBeNull();
  });
});

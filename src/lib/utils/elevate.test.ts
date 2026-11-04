import { describe, expect, it } from 'vitest';
import { isAccessDenied } from './elevate';

describe('isAccessDenied', () => {
  it('is os error 5 only', () => {
    expect(isAccessDenied('Access is denied. (os error 5)')).toBe(true);
    expect(isAccessDenied(new Error('Access is denied. (os error 5)'))).toBe(true);
    expect(isAccessDenied('The process cannot access the file (os error 32)')).toBe(false);
    expect(isAccessDenied('(os error 50)')).toBe(false);
    expect(isAccessDenied('not found')).toBe(false);
  });
});

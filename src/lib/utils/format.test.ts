import { describe, expect, it } from 'vitest';
import { fmtSize, fmtSpace } from './format';

const GB = 1024 ** 3;

describe('fmtSpace', () => {
  it('keeps three significant digits like Explorer', () => {
    expect(fmtSpace(45.3 * GB)).toBe('45.3 GB');
    expect(fmtSpace(237 * GB)).toBe('237 GB');
    expect(fmtSpace(1.81 * 1024 * GB)).toBe('1.81 TB');
    expect(fmtSpace(512 * 1024 * 1024)).toBe('512 MB');
  });

  it('handles the small end', () => {
    expect(fmtSpace(0)).toBe('0 B');
    expect(fmtSpace(1023)).toBe('1023 B');
    expect(fmtSpace(1024)).toBe('1.00 KB');
  });
});

describe('fmtSize', () => {
  it('rounds KB up and keeps one decimal above 1 MB', () => {
    expect(fmtSize(500)).toBe('500 B');
    expect(fmtSize(1025)).toBe('2 KB');
    expect(fmtSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

import { expect, test } from 'bun:test';
import { countOf, leaks, needles } from './path-leak-check';

test('counts every copy of a path in a binary', () => {
  const bin = Buffer.from('\0G:\\w\\src-tauri\0x\0G:\\w\\src-tauri__CHANNEL__:\0');
  expect(countOf(bin, 'G:\\w\\src-tauri')).toBe(2);
  expect(countOf(bin, 'G:/w')).toBe(0);
  expect(countOf(bin, '')).toBe(0);
});

test('checks both slash forms', () => {
  expect(needles(['G:\\06\\trove'])).toEqual(['G:\\06\\trove', 'G:/06/trove']);
  expect(needles(['/home/alex'])).toEqual(['/home/alex', '\\home\\alex']);
});

test('a clean binary reports all zero', () => {
  const counts = leaks(Buffer.from('trove/src/main.rs ~/x'), ['/home/alex', 'G:\\06\\trove']);
  expect(Object.values(counts).every((c) => c === 0)).toBe(true);
});

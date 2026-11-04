import { expect, test } from 'bun:test';
import { isDropped, parseRules, scan } from './private-words-check';

// Built at run time so this file itself carries no private word.
const NAME = 'St' + 'eph';
const rules = parseRules(`# comment\n\nw:${NAME}\nw:emon\nexample.invalid\n`);

test('a whole private word fails', () => {
  expect(scan('a.rs', `// took 5 ms on ${NAME},`, rules)).toEqual([
    { file: 'a.rs', line: 1, rule: `w:${NAME}` },
  ]);
});

test('a word inside another word does not', () => {
  expect(scan('a.rs', 'the daemon and Stephen', rules)).toEqual([]);
});

test('whole-word rules are case-sensitive, plain rules are not', () => {
  expect(scan('a', NAME.toLowerCase(), rules)).toEqual([]);
  expect(scan('a', 'see EXAMPLE.invalid', rules).length).toBe(1);
});

test('reports the line number and skips binary content', () => {
  expect(scan('a', `ok\nok\n${NAME}`, rules)[0].line).toBe(3);
  expect(scan('a.bin', `\0${NAME}`, rules)).toEqual([]);
});

test('paths the public export drops are skipped', () => {
  expect(isDropped('docs/ai-memory/private-words.txt')).toBe(true);
  expect(isDropped('PLAN.md')).toBe(true);
  expect(isDropped('docs/plans-extra.md')).toBe(false);
  expect(isDropped('src/a.ts')).toBe(false);
});

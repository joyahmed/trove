import { describe, expect, it } from 'vitest';
import {
  MAX_TAB_SETS,
  MAX_TAB_SET_NAME,
  MAX_TAB_SET_TABS,
  cleanTabSetName,
  findTabSet,
  renamedTabSet,
  sanitizeTabSets,
  tabSetActionKey,
  tabSetNameProblem,
  withTabSet,
  withoutTabSet,
  type TabSet,
} from './tab-sets';

const set = (name: string, tabs = ['/a', '/b'], active = 0, savedAt = 1): TabSet => ({
  name,
  tabs,
  active,
  savedAt,
});

describe('sanitizeTabSets', () => {
  it('keeps a good set as it is', () => {
    expect(sanitizeTabSets([set('Work')])).toEqual([set('Work')]);
  });
  it('drops non-lists and bad entries', () => {
    expect(sanitizeTabSets('x')).toEqual([]);
    expect(sanitizeTabSets([null, 4, 'a', {}, { name: 'x' }, { name: 3, tabs: ['/a'] }])).toEqual(
      [],
    );
    expect(sanitizeTabSets([{ name: '  ', tabs: ['/a'] }])).toEqual([]);
  });
  it('drops empty and non-string tabs, and a set left with none', () => {
    expect(sanitizeTabSets([{ name: 'A', tabs: ['/a', '', 4, null] }])[0]?.tabs).toEqual(['/a']);
    expect(sanitizeTabSets([{ name: 'A', tabs: ['', 4] }])).toEqual([]);
  });
  it('keeps the first of a repeated name, in any case', () => {
    const out = sanitizeTabSets([set('Work', ['/1']), set('work', ['/2']), set(' WORK ', ['/3'])]);
    expect(out.map((s) => s.tabs)).toEqual([['/1']]);
  });
  it('trims, folds spaces and cuts a long name', () => {
    expect(sanitizeTabSets([set('  my   set ')])[0]?.name).toBe('my set');
    expect(sanitizeTabSets([set('x'.repeat(200))])[0]?.name).toHaveLength(MAX_TAB_SET_NAME);
  });
  it('caps tabs per set and the number of sets', () => {
    const many = Array.from({ length: 50 }, (_, i) => `/t${i}`);
    expect(sanitizeTabSets([set('A', many)])[0]?.tabs).toHaveLength(MAX_TAB_SET_TABS);
    const sets = Array.from({ length: 80 }, (_, i) => set(`s${i}`));
    expect(sanitizeTabSets(sets)).toHaveLength(MAX_TAB_SETS);
  });
  it('brings a bad active index and savedAt back to sane values', () => {
    const [a] = sanitizeTabSets([{ name: 'A', tabs: ['/a', '/b'], active: 9, savedAt: 'x' }]);
    expect(a).toMatchObject({ active: 1, savedAt: 0 });
    const [b] = sanitizeTabSets([{ name: 'A', tabs: ['/a'], active: -2, savedAt: 5 }]);
    expect(b).toMatchObject({ active: 0, savedAt: 5 });
  });
});

describe('name rules', () => {
  it('refuses empty and too long names', () => {
    expect(tabSetNameProblem('   ')).not.toBeNull();
    expect(tabSetNameProblem('x'.repeat(MAX_TAB_SET_NAME + 1))).not.toBeNull();
    expect(tabSetNameProblem('Work')).toBeNull();
  });
  it('cleans spaces', () => expect(cleanTabSetName('  a \t b ')).toBe('a b'));
});

describe('save, rename, delete', () => {
  it('a new name goes first; the same name (any case) replaces in place', () => {
    const a = withTabSet([], set('A'))!;
    const b = withTabSet(a, set('B'))!;
    expect(b.map((s) => s.name)).toEqual(['B', 'A']);
    const again = withTabSet(b, set('a', ['/new']))!;
    expect(again.map((s) => s.name)).toEqual(['B', 'a']);
    expect(findTabSet(again, 'A')?.tabs).toEqual(['/new']);
  });
  it('refuses a new name at the cap but still replaces an old one', () => {
    const full = Array.from({ length: MAX_TAB_SETS }, (_, i) => set(`s${i}`));
    expect(withTabSet(full, set('new'))).toBeNull();
    expect(withTabSet(full, set('s3', ['/z']))).toHaveLength(MAX_TAB_SETS);
  });
  it('renames, keeps tabs, refuses a taken name or a missing set', () => {
    const l = [set('A', ['/a']), set('B')];
    expect(renamedTabSet(l, 'A', 'C')?.map((s) => s.name)).toEqual(['C', 'B']);
    expect(renamedTabSet(l, 'A', 'C')?.[0]?.tabs).toEqual(['/a']);
    expect(renamedTabSet(l, 'A', 'b')).toBeNull();
    expect(renamedTabSet(l, 'A', 'a')?.[0]?.name).toBe('a');
    expect(renamedTabSet(l, 'Z', 'Y')).toBeNull();
  });
  it('deletes by name, any case', () => {
    expect(withoutTabSet([set('A'), set('B')], 'a').map((s) => s.name)).toEqual(['B']);
  });
  it('builds the palette key', () =>
    expect(tabSetActionKey('open', 'A: b')).toBe('tab-set-open:A: b'));
});

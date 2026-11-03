import { describe, expect, it } from 'vitest';
import { selectPlan } from './launch-select';
import type { FileEntry } from '$lib/types/fs';

const entry = (path: string, isHidden = false): FileEntry => ({
  name: path.split('\\').at(-1) ?? path,
  path,
  isDir: false,
  size: 1,
  modifiedMs: null,
  createdMs: null,
  ext: 'txt',
  isHidden,
  iconKey: 'ext/txt',
  typeName: 'Text Document',
});

const shown = entry('C:\\a\\shown.txt');
const hidden = entry('C:\\a\\.secret', true);

describe('selectPlan', () => {
  it('selects an item that is listed, whatever its case', () => {
    expect(selectPlan('c:\\A\\SHOWN.txt', [shown], [shown, hidden])).toBe('select');
  });

  it('reveals a hidden item that the folder has but the list does not show', () => {
    expect(selectPlan('C:\\a\\.secret', [shown], [shown, hidden])).toBe('reveal-hidden');
  });

  it('reports an item the folder does not contain', () => {
    expect(selectPlan('C:\\a\\gone.txt', [shown], [shown, hidden])).toBe('missing');
  });
});

import { describe, expect, it } from 'vitest';
import { unmountAction } from './rename-unmount';

describe('unmountAction', () => {
  it('commits a changed draft when the box is lost', () => {
    expect(unmountAction('notes-v2.txt', 'notes.txt')).toBe('commit');
    expect(unmountAction('  renamed  ', 'old')).toBe('commit');
  });

  it('cancels when nothing changed or the draft is empty', () => {
    expect(unmountAction('notes.txt', 'notes.txt')).toBe('cancel');
    expect(unmountAction('', 'notes.txt')).toBe('cancel');
    expect(unmountAction('   ', 'notes.txt')).toBe('cancel');
  });
});

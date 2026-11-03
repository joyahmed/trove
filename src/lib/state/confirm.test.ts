import { describe, expect, it } from 'vitest';
import { confirm } from './confirm.svelte';

const question = { title: 'Delete', message: 'Sure?', okLabel: 'Delete', danger: true };

describe('confirm', () => {
  it('ask resolves with the answer and clears the question', async () => {
    const p = confirm.ask(question);
    expect(confirm.pending?.title).toBe('Delete');
    confirm.answer(true);
    await expect(p).resolves.toBe(true);
    expect(confirm.pending).toBeNull();
  });

  it('a second question answers the first one "no"', async () => {
    const first = confirm.ask(question);
    const second = confirm.ask({ ...question, title: 'Again' });
    await expect(first).resolves.toBe(false);
    expect(confirm.pending?.title).toBe('Again');
    confirm.answer(false);
    await expect(second).resolves.toBe(false);
  });
});

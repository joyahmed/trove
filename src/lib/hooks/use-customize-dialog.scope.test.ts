import { describe, expect, it } from 'vitest';
import { scopeOptionsFor } from './use-customize-dialog.svelte';

const keys = (o: ReturnType<typeof scopeOptionsFor>) => o.map((x) => x.key);

describe('the "Show on" boxes', () => {
  it('Windows lists WSL paths, editable', () => {
    const o = scopeOptionsFor(['file'], true);
    expect(keys(o)).toContain('wsl');
    expect(o.every((x) => !x.readOnly)).toBe(true);
  });
  it('Mac/Linux hide WSL paths when the command does not use it', () => {
    expect(keys(scopeOptionsFor(['file'], false))).toEqual(['file', 'folder', 'background']);
  });
  it('Mac/Linux keep a saved WSL scope, shown and read-only', () => {
    const wsl = scopeOptionsFor(['wsl'], false).find((x) => x.key === 'wsl');
    expect(wsl).toMatchObject({ label: 'WSL paths', readOnly: true });
  });
});

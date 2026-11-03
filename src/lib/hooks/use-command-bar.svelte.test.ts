import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/window', () => ({ close: vi.fn(), openWindow: vi.fn() }));
vi.mock('$lib/api/fs', () => ({}));
vi.mock('$lib/api/transfer', () => ({}));
vi.mock('$lib/api/clipboard', () => ({}));
vi.mock('$lib/api/pty', () => ({}));
vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => null),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => {}),
}));
vi.mock('$lib/api/default-handler', () => ({
  defaultHandlerStatus: vi.fn(async () => ({ kind: 'not-applied' })),
  defaultHandlerInfo: vi.fn(async () => ({ exePath: '', stable: true })),
  defaultHandlerApply: vi.fn(async () => {}),
  defaultHandlerRevert: vi.fn(async () => {}),
}));
vi.mock('$lib/api/shell-verbs', () => ({
  shellVerbs: vi.fn(async () => []),
  runShellVerb: vi.fn(async () => {}),
  runCustomCommand: vi.fn(async () => {}),
}));

const { filterCommand, newCommand } = await import('$lib/data/command-actions');
const { useCommandBar } = await import('./use-command-bar.svelte');

describe('useCommandBar.isExpanded', () => {
  it('is true for the button whose menu is showing, false for the others', () => {
    // Called straight: inside `$effect.root` the callback never ran, so these never executed.
    const bar = useCommandBar();
    const el = { getBoundingClientRect: () => ({ left: 0, bottom: 0 }), focus: vi.fn() };
    expect(bar.isExpanded(filterCommand)).toBe(false);
    bar.activate(filterCommand, { currentTarget: el } as unknown as MouseEvent);
    expect(bar.isExpanded(filterCommand)).toBe(true);
    expect(bar.isExpanded(newCommand)).toBe(false);
    bar.menu.close();
    expect(bar.isExpanded(filterCommand)).toBe(false);
    // the menu gives the keyboard back to the button it opened from
    expect(el.focus).toHaveBeenCalledOnce();
  });
});

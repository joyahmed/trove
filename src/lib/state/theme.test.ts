import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCENT, theme } from './theme.svelte';
import { systemTheme } from '$lib/api/theme';

vi.mock('$lib/api/theme', () => ({ systemTheme: vi.fn() }));

const mocked = vi.mocked(systemTheme);

describe('theme', () => {
  beforeEach(() => {
    theme.accent = DEFAULT_ACCENT;
    theme.transparency = true;
    theme.textScale = 1;
    theme.loaded = false;
    mocked.mockReset();
  });

  it('takes the accent and the transparency flag from the OS', async () => {
    mocked.mockResolvedValue({ accent: '#ff8c00', transparency: false, textScale: 1.25 });
    await theme.load();
    expect(theme.accent).toBe('#ff8c00');
    expect(theme.transparency).toBe(false);
    expect(theme.textScale).toBe(1.25);
    expect(theme.loaded).toBe(true);
  });

  it('keeps the defaults when the call fails or the colour is malformed', async () => {
    mocked.mockRejectedValue(new Error('no registry'));
    await theme.load();
    expect(theme.accent).toBe(DEFAULT_ACCENT);
    expect(theme.transparency).toBe(true);

    mocked.mockResolvedValue({ accent: 'blue', transparency: true, textScale: 1 });
    await theme.load();
    expect(theme.accent).toBe(DEFAULT_ACCENT);
  });

  it('ignores a text scale outside what Windows offers', async () => {
    mocked.mockResolvedValue({ accent: '#005fb8', transparency: true, textScale: 9 });
    await theme.load();
    expect(theme.textScale).toBe(1);
  });
});

describe('the light/dark theme', () => {
  it('resolves System from the OS and forces Light or Dark against it', async () => {
    const { resolveTheme } = await import('./theme.svelte');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('follows settings.theme and the OS live', async () => {
    const { settings } = await import('./settings.svelte');
    settings.theme = 'system';
    theme.systemDark = true;
    expect(theme.resolved).toBe('dark');
    theme.systemDark = false;
    expect(theme.resolved).toBe('light');
    settings.theme = 'dark';
    expect(theme.dark).toBe(true);
    settings.theme = 'system';
  });
});

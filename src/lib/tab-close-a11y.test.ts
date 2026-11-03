// E.5.2: the tab's accessible name is its title only. A role=tab has presentational children, so a
// close button inside it is folded into the name ("files Close tab") and a screen reader cannot
// land on it. The close button is a sibling of the tab, labelled with the tab's title.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/window', () => ({ close: vi.fn(), openWindow: vi.fn(async () => undefined) }));

const { useTabStrip } = await import('./hooks/use-tab-strip.svelte');
const { tabs } = await import('$lib/state/tabs.svelte');

const svelte = readFileSync('src/lib/components/shell/shell-parts/TabStrip.svelte', 'utf8');
const tabEl = svelte.match(/<div[^>]*role="tab"[\s\S]*?<\/div>/)?.[0] ?? '';

describe('tab close button', () => {
  it('has its own label naming the tab', () => {
    tabs.list = [tabs.list[0]];
    const [view] = useTabStrip().views;
    expect(view.closeLabel).toBe(`Close ${view.title}`);
    expect(svelte).toContain('aria-label={tab.closeLabel}');
    expect(svelte).not.toContain('aria-label="Close tab"');
  });
  it('sits outside the role=tab element, so the tab name excludes it', () => {
    expect(tabEl).toContain('{tab.title}');
    expect(tabEl).not.toContain('<button');
    expect(tabEl).not.toMatch(/Close/);
  });
  it('is roving: in the Tab order only on the active tab', () => {
    expect(svelte).toContain('tabindex={tab.active ? 0 : -1}');
  });
});

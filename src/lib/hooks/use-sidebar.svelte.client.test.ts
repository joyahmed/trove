import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAddressBar } from './use-address-bar.svelte';
import { useSidebar } from './use-sidebar.svelte';
import { DRIVES_KEY, sidebarSections, type SidebarItem } from '$lib/data/sidebar-sections';
import { places } from '$lib/state/places.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { wsl } from '$lib/state/wsl.svelte';
import type { DriveInfo } from '$lib/types/shell';
import { HOME, pathLocation } from '$lib/utils/location';

vi.mock('$lib/api/shell', () => ({
  drives: vi.fn(async () => []),
  knownFolders: vi.fn(async () => []),
  userProfile: vi.fn(async () => '/Users/alex'),
  oneDriveRoot: vi.fn(async () => null),
  openTerminal: vi.fn(async () => undefined),
}));
// a Mac: /tmp is a link to /private/tmp, and the read reports the folder by its real path
vi.mock('$lib/api/fs', () => ({
  readDir: vi.fn(async (path: string) => ({
    path: path.replace(/^\/tmp\//, '/private/tmp/'),
    entries: [],
  })),
  pathKind: vi.fn(async () => 'dir'),
  openPath: vi.fn(async () => undefined),
}));

const FX = '/private/tmp/claude-502/abc/scratchpad/fx/sub';

const rows = (): SidebarItem[] => sidebarSections.flatMap((s) => s.items());
const homeRow = () => rows().find((r) => r.key === 'home')!;

/** What a component would draw: which rows are lit, re-read on every change like the template. */
const watchLit = () => {
  const bar = useSidebar();
  const seen: string[][] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(
        rows()
          .filter((r) => bar.isActive(r))
          .map((r) => r.key),
      );
    });
  });
  flushSync();
  return { bar, seen, stop, lit: () => seen.at(-1) };
};

const typeInAddressBar = async (text: string) => {
  const address = useAddressBar();
  address.startEdit();
  address.draft = text;
  await address.commit();
  flushSync();
};

describe('useSidebar highlight after the address bar', () => {
  beforeEach(async () => {
    await tabs.active.navigate(HOME, { replace: true });
    flushSync();
  });

  it('Home is lit on Home', () => {
    const w = watchLit();
    expect(w.lit()).toEqual(['home']);
    expect(w.bar.isActive(homeRow())).toBe(true);
    w.stop();
  });

  it('folder view, then a typed path that is no row: nothing is lit (Mac, Mac)', async () => {
    const w = watchLit();
    await tabs.active.navigate(pathLocation('/Users/alex/Documents'));
    flushSync();
    expect(w.lit()).toEqual([]);
    await typeInAddressBar(FX);
    expect(tabs.active.location).toEqual(pathLocation(FX));
    expect(w.lit()).toEqual([]);
    expect(w.bar.isActive(homeRow())).toBe(false);
    w.stop();
  });

  it('Home, then a typed path through the /tmp link: Home goes out', async () => {
    const w = watchLit();
    expect(w.lit()).toEqual(['home']);
    await typeInAddressBar('/tmp/claude-502/abc/scratchpad/fx/sub');
    expect(tabs.active.location).toEqual(pathLocation(FX));
    expect(w.lit()).toEqual([]);
    w.stop();
  });
});

// plan 15 A.4.9: Drives folded, restart, and the whole section (header too) was gone, so it could
// not be unfolded. The drives are asked for at start whatever the fold, but that call waits ~21 s
// on a dead network letter, and until it answers the section has no rows and was skipped.
describe('useSidebar sections while a folded one has no rows yet', () => {
  beforeEach(() => {
    places.drives = [];
    places.drivesLoading = false;
    wsl.distros = [];
    settings.sidebarCollapsed = [];
  });

  /** the sections a component would draw, read inside an effect root like the template */
  const drawn = (check: (bar: ReturnType<typeof useSidebar>) => void) => {
    const stop = $effect.root(() => check(useSidebar()));
    stop();
  };
  const keys = (bar: ReturnType<typeof useSidebar>) => bar.sections.map((s) => s.key);

  it('folded Drives with no drives loaded yet: the section and its header are still drawn', () => {
    settings.sidebarCollapsed = [DRIVES_KEY];
    drawn((bar) => {
      expect(bar.sections.find((s) => s.key === DRIVES_KEY)?.title).toBe('Drives');
      expect(bar.isExpanded(DRIVES_KEY)).toBe(false);
    });
  });

  it('a folded Linux section with no distros yet is still drawn', () => {
    settings.sidebarCollapsed = ['linux'];
    drawn((bar) => expect(keys(bar)).toContain('linux'));
  });

  it('an unfolded empty section is still skipped (no Linux header off Windows)', () => {
    drawn((bar) => {
      expect(keys(bar)).not.toContain(DRIVES_KEY);
      expect(keys(bar)).not.toContain('linux');
    });
  });

  it('unfolded Drives while the drives call is still out: the section and header are drawn', () => {
    places.drivesLoading = true;
    drawn((bar) => {
      const drives = bar.sections.find((s) => s.key === DRIVES_KEY);
      expect(drives?.title).toBe('Drives');
      expect(drives?.items()).toEqual([]);
      expect(keys(bar)).not.toContain('linux'); // the Linux rule is unchanged
    });
  });

  it('unfolded Drives goes only once the call has answered with no drives', () => {
    places.drivesLoading = true;
    drawn((bar) => {
      expect(keys(bar)).toContain(DRIVES_KEY);
      places.drivesLoading = false;
      flushSync();
      expect(keys(bar)).not.toContain(DRIVES_KEY);
    });
  });

  it('once the drives land, the folded section holds every one of them', () => {
    settings.sidebarCollapsed = [DRIVES_KEY];
    drawn((bar) => {
      places.drives = [
        { path: 'C:\\', label: 'System', totalBytes: 100, freeBytes: 50 },
        { path: 'D:\\', label: 'Data', totalBytes: 100, freeBytes: 10 },
      ] as DriveInfo[];
      flushSync();
      const drives = bar.sections.find((s) => s.key === DRIVES_KEY);
      expect(drives?.items().map((i) => i.key)).toEqual(['C:\\', 'D:\\']);
    });
  });
});

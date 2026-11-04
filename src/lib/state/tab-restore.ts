// Showing a saved tab plan in this window (the session restore and the named tab sets).
import { pathKind } from '$lib/api/fs';
import { settings } from '$lib/state/settings.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { startLocation } from '$lib/utils/location';
import { onWindows } from '$lib/utils/platform';
import { resolveRestoredTab, type WindowPlan } from '$lib/utils/restore-tabs';

/** Show `plan`'s tabs (folders and places) in this window: the first replaces the start tab.
 * Every restored tab, of this window or another, goes through `resolveRestoredTab`: a path from
 * another OS or one that is gone opens the start place, quietly. */
export const openTabsHere = async (plan: WindowPlan) => {
  if (plan.tabs.length === 0 || tabs.list.length > 1) return;
  const deps = {
    windows: onWindows(),
    exists: async (path: string) => (await pathKind(path)) === 'dir',
    fallback: startLocation(settings.startPlace),
  };
  const at = await Promise.all(plan.tabs.map((t) => resolveRestoredTab(t, deps)));
  if (tabs.list.length > 1) return; // the user opened a tab while the paths were checked
  void tabs.active.navigate(at[0], { replace: true });
  for (const l of at.slice(1)) tabs.open(l);
  tabs.activate(plan.active);
};

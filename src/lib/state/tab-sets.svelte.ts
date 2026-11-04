// Named tab sets (plan 08 F3): save this window's tabs under a name, bring them back, rename,
// delete. Asking goes through `confirm` (a name box, a yes/no); opening goes through the same
// `openTabsHere` the session restore uses, so a saved path from another OS or a folder that is
// gone opens the start place instead of an error tab.
import { confirm } from '$lib/state/confirm.svelte';
import { actions } from '$lib/state/actions.svelte';
import { MAX_OPEN_TABS, settings } from '$lib/state/settings.svelte';
import { openTabsHere } from '$lib/state/tab-restore';
import { tabs } from '$lib/state/tabs.svelte';
import { tabToken } from '$lib/utils/location';
import { windowTabsOf } from '$lib/utils/restore-tabs';
import {
  MAX_TAB_SETS,
  findTabSet,
  renamedTabSet,
  tabSetNameProblem,
  withTabSet,
  withoutTabSet,
} from '$lib/utils/tab-sets';

class TabSetsState {
  /** "Save tabs as…": ask for a name, ask again before replacing a set of that name. */
  async saveAs() {
    const plan = windowTabsOf(
      tabs.list.map((t) => tabToken(t.location)),
      tabs.activeIndex,
      MAX_OPEN_TABS,
    );
    if (plan.tabs.length === 0) return actions.notify('There are no folder tabs to save');
    const name = await confirm.askText({
      title: 'Save tabs as…',
      message: `${plan.tabs.length} ${plan.tabs.length === 1 ? 'tab' : 'tabs'} will be saved under this name.`,
      okLabel: 'Save',
      placeholder: 'Tab set name',
      value: '',
      validate: (v) => tabSetNameProblem(v),
    });
    if (name === null) return;
    const clash = findTabSet(settings.tabSets, name);
    if (clash) {
      const ok = await confirm.ask({
        title: 'Replace tab set?',
        message: `A tab set named “${clash.name}” already exists. Replace it with these ${plan.tabs.length} tabs?`,
        okLabel: 'Replace',
        danger: true,
      });
      if (!ok) return;
    }
    const next = withTabSet(settings.tabSets, {
      name: clash?.name ?? name,
      tabs: plan.tabs,
      active: plan.active,
      savedAt: Date.now(),
    });
    if (!next) return actions.notify(`Trove keeps ${MAX_TAB_SETS} tab sets — delete one first`);
    settings.tabSets = next;
    actions.notify(`Saved tab set “${clash?.name ?? name}”`);
  }

  /** Open a set in this window, replacing its tabs. */
  async open(name: string) {
    const set = findTabSet(settings.tabSets, name);
    if (!set) return;
    while (tabs.list.length > 1) tabs.close(tabs.list.length - 1);
    await openTabsHere({ tabs: set.tabs, active: set.active });
  }

  async rename(name: string) {
    const set = findTabSet(settings.tabSets, name);
    if (!set) return;
    const to = await confirm.askText({
      title: 'Rename tab set',
      message: `New name for “${set.name}”.`,
      okLabel: 'Rename',
      placeholder: 'Tab set name',
      value: set.name,
      validate: (v) => {
        const p = tabSetNameProblem(v);
        if (p) return p;
        return renamedTabSet(settings.tabSets, set.name, v)
          ? null
          : 'A tab set has that name already';
      },
    });
    if (to === null) return;
    const next = renamedTabSet(settings.tabSets, set.name, to);
    if (next) settings.tabSets = next;
  }

  async remove(name: string) {
    const set = findTabSet(settings.tabSets, name);
    if (!set) return;
    const ok = await confirm.ask({
      title: 'Delete tab set?',
      message: `“${set.name}” (${set.tabs.length} ${set.tabs.length === 1 ? 'tab' : 'tabs'}) will be removed. The folders themselves are not touched.`,
      okLabel: 'Delete',
      danger: true,
    });
    if (ok) settings.tabSets = withoutTabSet(settings.tabSets, set.name);
  }
}

export const tabSets = new TabSetsState();

// "I'm coming from" (plan 19): copies the stored setting onto the live style every word reads
// (`comingFrom.choice`), and mirrors it to localStorage so the next window — explorer or
// Spotlight — paints the right words before its settings are read. Called once from the root
// layout. A change in another window arrives through `settings.applyRemote` and flows here too.
import { settings } from '$lib/state/settings.svelte';
import {
  COMING_FROM_STORAGE_KEY,
  comingFrom,
  type ComingFrom,
} from '$lib/state/coming-from.svelte';

/** One sync. ⚠️ Nothing before this window's settings are the person's (`settled`): until then
 * the stored default would overwrite the mirror that already painted the right words.
 * Exported for the node test, where `$effect` does not run. */
export const syncComingFrom = (choice: ComingFrom, settled: boolean) => {
  if (!settled) return;
  comingFrom.choice = choice;
  try {
    localStorage.setItem(COMING_FROM_STORAGE_KEY, choice);
  } catch {
    // storage blocked: the next window paints native words until its settings load
  }
};

export const useComingFrom = () => {
  $effect(() => syncComingFrom(settings.comingFrom, settings.settled));
};

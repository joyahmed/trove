// For the sidebar, the breadcrumbs and the tab strip: is this element the drag's current target?
// The list owns the drag itself (`use-drag`); these only light up.
import { drag, type DropKind } from '$lib/state/drag.svelte';

export const useDropTarget = () => ({
  isTarget: (path: string, surface: DropKind) => drag.isTarget(path, surface),
  isTargetTab: (index: number) => drag.isTargetTab(index),
});

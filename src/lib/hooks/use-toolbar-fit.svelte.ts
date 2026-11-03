// The toolbar's width and what it makes give way (plan 15 G.73): the parts that moved off the
// toolbar, and the "…" button whose menu offers them.
import type { Attachment } from 'svelte/attachments';
import type { CommandItem } from '$lib/data/command-actions';
import { toolbarOverflowItems } from '$lib/data/toolbar-overflow';
import { toolbarFit, type ToolbarPart } from '$lib/utils/toolbar-fit';

export const useToolbarFit = () => {
  // Infinity until measured: the first paint shows every part, none flashes away
  let width = $state(Infinity);
  const fit = $derived(toolbarFit(width));

  const attach: Attachment<HTMLElement> = (nav) => {
    const ro = new ResizeObserver(() => {
      width = nav.clientWidth;
    });
    ro.observe(nav);
    return () => ro.disconnect();
  };

  const collapsed = (part: ToolbarPart) => fit.collapsed.includes(part);

  const moreButton: Extract<CommandItem, { kind: 'icon' }> = {
    kind: 'icon',
    key: 'more',
    label: 'More',
    glyph: 'more',
    menu: toolbarOverflowItems(collapsed),
  };

  return {
    attach,
    collapsed,
    moreButton,
    get overflow() {
      return fit.overflow;
    },
  };
};

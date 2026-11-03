<!-- "+ New" at the toolbar's left (plan 12 G.1, D4): the one button the dropped command bar kept,
     opening the same New menu as the empty-space right-click "New ▸". While a search is on it
     becomes Filters — Kind / Date modified / Size — since nothing is made inside results. -->
<script lang="ts">
  import { filterCommand, newCommand, type CommandItem } from '$lib/data/command-actions';
  import { search } from '$lib/state/search.svelte';
  import CommandButton from '$lib/components/shell/shell-parts/CommandButton.svelte';

  interface Props {
    onactivate: (item: CommandItem, e: MouseEvent) => void;
    isExpanded?: (item: CommandItem) => boolean;
    /** the label gave way: the glyph alone */
    compact?: boolean;
  }
  let { onactivate, isExpanded, compact = false }: Props = $props();

  const item = $derived(search.active ? filterCommand : newCommand);
</script>

<div class="shrink-0">
  <CommandButton
    {item}
    iconOnly={compact}
    expanded={isExpanded?.(item) ?? false}
    onactivate={(e) => onactivate(item, e)}
  />
</div>

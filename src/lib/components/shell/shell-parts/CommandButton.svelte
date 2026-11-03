<script lang="ts">
  import { accessibleName, isEnabled, labelOf, type CommandItem } from '$lib/data/command-actions';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    item: CommandItem;
    onactivate: (e: MouseEvent) => void;
    /** a menu button's menu is showing */
    expanded?: boolean;
    /** show the glyph alone, as a w-9 square (a narrow toolbar's "+") */
    iconOnly?: boolean;
  }
  let { item, onactivate, expanded = false, iconOnly = false }: Props = $props();
</script>

{#if item.kind === 'divider'}
  <div class="bg-divider mx-2 h-6 w-px"></div>
{:else}
  <button
    type="button"
    class="rounded-control hover:bg-subtle-hover active:bg-subtle-pressed disabled:text-text-disabled flex h-9 items-center gap-2 px-2.5 text-sm disabled:hover:bg-transparent {item.kind ===
      'icon' || iconOnly
      ? 'w-9 justify-center px-0'
      : ''} {item.active?.() ? 'bg-subtle-selected' : ''}"
    title={labelOf(item)}
    aria-label={accessibleName(item)}
    aria-pressed={!item.menu && item.active ? item.active() : undefined}
    aria-haspopup={item.menu ? 'menu' : undefined}
    aria-expanded={item.menu ? expanded : undefined}
    disabled={!isEnabled(item)}
    onclick={onactivate}
  >
    <Glyph
      name={item.glyph}
      size={16}
      color={isEnabled(item) ? 'var(--color-accent)' : undefined}
    />
    {#if item.kind === 'labelled' && !iconOnly}
      <span>{labelOf(item)}</span>
      {#if item.menu}<Glyph name="chevronDown" size={8} class="ml-0.5" />{/if}
    {/if}
  </button>
{/if}

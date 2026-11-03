<!-- A collapsible section header (Explorer's "Quick access"): chevron + title, click folds. With
     `onopen` the title is its own button that navigates (Drives → This PC); the chevron folds. -->
<script lang="ts">
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    title: string;
    expanded: boolean;
    ontoggle: () => void;
    /** the title navigates; without it the whole row folds */
    onopen?: () => void;
    /** where the title goes, for its tooltip (`This PC`, per OS) */
    openLabel?: string;
    /** the Pinned title: serif italic, a touch larger, with a pin glyph before it */
    pinGlyph?: boolean;
  }
  let { title, expanded, ontoggle, onopen, openLabel, pinGlyph = false }: Props = $props();
</script>

{#snippet label()}
  {#if pinGlyph}
    <span class="flex min-w-0 flex-1 items-center gap-1.5">
      <Glyph name="pin" size={11} class="text-text-secondary shrink-0" />
      <span class="truncate">{title}</span>
    </span>
  {:else}
    <span class="flex-1 truncate">{title}</span>
  {/if}
{/snippet}

{#if onopen}
  <div class="h-navitem mr-1 flex shrink-0 items-center text-sm" data-mac="sidebar-head">
    <button
      type="button"
      class="rounded-control hover:bg-subtle-hover grid h-full w-6 shrink-0 place-items-center pl-3"
      aria-expanded={expanded}
      aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
      onclick={ontoggle}
    >
      <span
        class="grid w-3 place-items-center transition-transform {expanded ? 'rotate-90' : ''}"
        data-mac="head-chevron"
      >
        <Glyph name="chevronRight" size={9} />
      </span>
    </button>
    <button
      type="button"
      class="rounded-control hover:bg-subtle-hover h-full min-w-0 flex-1 truncate pr-2 pl-3 text-left"
      title={openLabel ? `Open ${openLabel}` : undefined}
      onclick={onopen}
    >
      {@render label()}
    </button>
  </div>
{:else}
  <button
    type="button"
    class="rounded-control hover:bg-subtle-hover h-navitem mr-1 flex shrink-0 items-center gap-3 pr-2 pl-3 text-left text-sm"
    data-mac="sidebar-head"
    aria-expanded={expanded}
    onclick={ontoggle}
  >
    <span
      class="grid w-3 place-items-center transition-transform {expanded ? 'rotate-90' : ''}"
      data-mac="head-chevron"
    >
      <Glyph name="chevronRight" size={9} />
    </span>
    {@render label()}
  </button>
{/if}

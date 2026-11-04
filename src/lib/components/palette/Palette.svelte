<!-- Spotlight: the input row, then the ranked results grouped by category. In its own window the
     window is transparent and sized by the hook, and this box is what the person sees; as Find
     anything (`host` given) it is a 560 px panel floating in an explorer window instead. Painted
     solid Mica so it reads the same with transparency effects off. -->
<script lang="ts">
  import { usePalette, type PaletteHost } from '$lib/hooks/use-palette.svelte';
  import PaletteInput from './palette-parts/PaletteInput.svelte';
  import CategoryHeader from './palette-parts/CategoryHeader.svelte';
  import PaletteFooter from './palette-parts/PaletteFooter.svelte';
  import ResultRow from './palette-parts/ResultRow.svelte';
  import PalettePreview from './palette-parts/PalettePreview.svelte';

  interface Props {
    /** set when the palette is a panel inside a window: what Esc and a run close */
    host?: PaletteHost;
  }
  let { host }: Props = $props();

  // svelte-ignore state_referenced_locally
  const pal = usePalette(host);
</script>

<div
  class="bg-mica text-text border-divider rounded-panel flex flex-col overflow-hidden border {host
    ? 'shadow-flyout max-h-[min(480px,calc(100vh-6rem))] max-w-[calc(100vw-2rem)]'
    : 'h-screen'}"
  style:width={host ? `${560 + (pal.showsPreview ? pal.previewWidth : 0)}px` : undefined}
  role="dialog"
  aria-modal={host ? 'true' : undefined}
  aria-label={host ? 'Find anything' : 'Spotlight'}
>
  <PaletteInput
    placeholder={host ? 'Find anything' : undefined}
    bind:value={pal.query}
    busy={pal.busy}
    onkeydown={pal.onkeydown}
    attach={pal.attach}
  />
  {#if pal.groups.length > 0}
    <div class="border-divider flex min-h-0 flex-1 border-t">
      <div
        class="min-h-0 min-w-0 flex-1 overflow-y-auto px-2 pt-1 pb-2"
        role="listbox"
        tabindex="-1"
        onmouseleave={pal.pointerLeft}
      >
        <!-- keyed by position: `groups` is rebuilt whole on every paint, and the trailing block of
           pinned fallback rows shares its `category` with the group it came from -->
        {#each pal.groups as group, i (i)}
          {#if group.label}
            <CategoryHeader label={group.label} />
          {/if}
          {#each group.items as item (item.key)}
            <ResultRow
              {item}
              icon={pal.icon(item)}
              selected={pal.isSelected(item)}
              keyMove={pal.keyMove}
              onhover={(x, y) => pal.hover(item, x, y)}
              onrun={() => pal.run(item)}
            />
          {/each}
        {/each}
      </div>
      {#if pal.showsPreview}
        <PalettePreview
          result={() => pal.current}
          savePrefs={pal.savePrefs}
          open={pal.run}
          reveal={pal.reveal}
          requery={pal.requery}
        />
      {/if}
    </div>
    <PaletteFooter />
  {/if}
</div>

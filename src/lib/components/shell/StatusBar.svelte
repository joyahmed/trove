<script lang="ts">
  import { useStatusBar } from '$lib/hooks/use-status-bar.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    status: string;
    selected: string;
  }
  let { status, selected }: Props = $props();

  const bar = useStatusBar();
</script>

<footer class="h-statusbar flex shrink-0 items-center gap-4 px-3 text-xs">
  <span class="min-w-0 flex-1 truncate">{bar.selectionLine ?? (selected || status)}</span>
  {#if bar.freeSpace}
    <span class="text-text-secondary shrink-0 truncate font-mono">{bar.freeSpace}</span>
  {/if}
  {#if bar.showsViewButtons}
    <div class="flex shrink-0 items-center gap-0.5" role="group" aria-label="View">
      {#each bar.viewButtons as b (b.key)}
        <button
          type="button"
          class="grid size-5 place-items-center rounded-xs {b.pressed
            ? 'bg-subtle-selected text-accent'
            : 'hover:bg-subtle-hover active:bg-subtle-pressed'}"
          title={b.label}
          aria-label={b.label}
          aria-pressed={b.pressed}
          onclick={() => bar.setView(b.key)}
        >
          <Glyph name={b.glyph} size={14} />
        </button>
      {/each}
    </div>
  {/if}
</footer>

<!-- Gallery / Icons / List / Details as one segmented control at the toolbar's right (plan 12 G.1;
     Gallery plan 15 G.52, in a folder only). Which segment is on follows the folder's view
     (`tabs.active.view`); the icon sizes stay on the right-click menu. -->
<script lang="ts">
  import { viewChoicesFor } from '$lib/data/nav-actions';
  import { tabs } from '$lib/state/tabs.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
</script>

<div
  class="rounded-control border-divider flex h-9 shrink-0 items-center gap-0.5 border p-0.5"
  role="group"
  aria-label="View"
>
  {#each viewChoicesFor(tabs.active.isFolder) as choice (choice.key)}
    <button
      type="button"
      class="grid h-full w-8 place-items-center rounded-xs {tabs.active.view === choice.key
        ? 'bg-subtle-selected text-accent'
        : 'hover:bg-subtle-hover active:bg-subtle-pressed'}"
      title={choice.label}
      aria-label={choice.label}
      aria-pressed={tabs.active.view === choice.key}
      onclick={() => tabs.active.setView(choice.key)}
    >
      <Glyph name={choice.glyph} size={14} />
    </button>
  {/each}
</div>

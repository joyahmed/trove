<!-- The 44 px Fluent field with the search glyph; keyboard goes to the hook. -->
<script lang="ts">
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    value: string;
    busy: boolean;
    onkeydown: (e: KeyboardEvent) => void;
    attach: (el: HTMLInputElement) => { destroy(): void };
    /** the in-window panel is "Find anything"; the Spotlight window keeps its longer hint */
    placeholder?: string;
  }
  let {
    value = $bindable(),
    busy,
    onkeydown,
    attach,
    placeholder = 'Search files, folders, apps, actions…',
  }: Props = $props();
</script>

<div class="flex h-16 shrink-0 items-center gap-3 px-4">
  <Glyph name="search" size={18} class="text-text-secondary" />
  <input
    class="placeholder:text-text-secondary h-11 flex-1 bg-transparent text-lg outline-none"
    type="text"
    autocorrect="off"
    autocapitalize="off"
    {placeholder}
    spellcheck="false"
    autocomplete="off"
    bind:value
    {onkeydown}
    use:attach
  />
  {#if busy}
    <span class="bg-accent size-2 animate-pulse rounded-full" aria-label="Searching"></span>
  {/if}
</div>

<!-- Explorer's search box: filters as you type, Enter searches the folder and its subfolders —
     Ctrl+F / Ctrl+E land here, as in Explorer. The chip at its end opens Find anything (the
     palette, in this window), which Ctrl+K / ⌘K opens too. The palette itself is mounted by Shell,
     not here: a narrow window takes this box off the toolbar and ⌘K must still open it. -->
<script lang="ts">
  import { useSearchBox } from '$lib/hooks/use-search-box.svelte';
  import { findAnything } from '$lib/hooks/use-palette.svelte';
  import { findAnythingHint } from '$lib/data/shortcuts';
  import { onMac } from '$lib/utils/platform';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  const box = useSearchBox();
  const hint = findAnythingHint(onMac());
</script>

<div
  class="rounded-control border-field-stroke bg-field flex h-8 w-[280px] min-w-36 shrink-[8] items-center gap-1 border pr-1 pl-3 text-sm"
>
  <input
    class="placeholder:text-text-secondary h-full min-w-0 flex-1 truncate bg-transparent outline-none"
    type="text"
    autocorrect="off"
    autocapitalize="off"
    autocomplete="off"
    placeholder={box.placeholder}
    aria-label={box.placeholder}
    spellcheck="false"
    data-search
    value={box.value}
    disabled={!box.enabled}
    oninput={box.oninput}
    onkeydown={box.onkeydown}
  />
  {#if box.nonEmpty}
    <button
      type="button"
      class="rounded-control hover:bg-subtle-hover grid size-6 shrink-0 place-items-center"
      title="Clear search"
      aria-label="Clear search"
      onclick={box.clear}
    >
      <Glyph name="close" size={9} />
    </button>
  {:else}
    <Glyph name="search" size={14} class="text-text-secondary shrink-0" />
  {/if}
  <button
    type="button"
    class="rounded-control border-divider text-text-secondary hover:bg-subtle-hover h-6 shrink-0 border px-1.5 text-xs whitespace-nowrap"
    title="Find anything ({hint})"
    aria-label="Find anything"
    onclick={findAnything.show}
  >
    {hint}
  </button>
</div>

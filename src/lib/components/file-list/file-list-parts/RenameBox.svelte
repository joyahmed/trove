<script lang="ts">
  import { useRenameBox } from '$lib/hooks/use-rename-box.svelte';

  interface Props {
    /** grow with the text instead of filling the row — the horizontal list view's items are narrow */
    wide?: boolean;
    /** under an icon (the tile views): the text is centred, as Explorer's is */
    centered?: boolean;
  }
  let { wide = false, centered = false }: Props = $props();

  const box = useRenameBox();
</script>

<!-- clicks inside the field must not reach the row's select handler; the input owns the keyboard -->
<span class={wide ? 'shrink-0' : 'flex-1'}>
  <input
    class="rounded-control border-accent bg-field h-6 border px-1 text-xs outline-none {wide
      ? ''
      : 'w-full'} {centered ? 'text-center' : ''}"
    type="text"
    autocorrect="off"
    autocapitalize="off"
    autocomplete="off"
    spellcheck="false"
    size={wide ? box.size : undefined}
    bind:value={box.draft}
    onclick={(e) => e.stopPropagation()}
    ondblclick={(e) => e.stopPropagation()}
    onkeydown={box.onkeydown}
    onblur={box.onblur}
    use:box.focus
  />
</span>

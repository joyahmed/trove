<script lang="ts">
  import type { CaptionButton } from '$lib/hooks/use-title-bar.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    buttons: CaptionButton[];
  }
  import { captionButtonClass, drawsCaptionButtons } from '$lib/utils/window-chrome';

  let { buttons }: Props = $props();
</script>

<!-- On a Mac the system draws these: the native traffic lights, top left (`tauri.macos.conf.json`). -->
{#if drawsCaptionButtons()}
  <div class="h-titlebar flex self-start">
    {#each buttons as b (b.key)}
      <button
        type="button"
        class={captionButtonClass(b.key)}
        title={b.label}
        aria-label={b.label}
        onclick={b.run}
      >
        <Glyph name={b.glyph} size={10} />
      </button>
    {/each}
  </div>
{/if}

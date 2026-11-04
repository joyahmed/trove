<!-- A list with nothing to show: empty, still loading, or broken. Centred on both axes rather
     than pinned to the top, because on a maximised window a single sentence at the top of a
     tall, otherwise bare list reads as misaligned. `flex-1` needs a flex-column parent to fill,
     which is what the two scroll areas that use this give it. -->
<script lang="ts">
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import type { GlyphName } from '$lib/data/glyphs';
  import type { Snippet } from 'svelte';

  interface Props {
    glyph?: GlyphName;
    message: string;
    /** `critical` is a failure: the glyph carries the colour and a reader announces the line */
    tone?: 'neutral' | 'critical';
    /** an action under the line (Cancel, Try again) */
    children?: Snippet;
    /** a stable hook for tests and screenshots */
    testid?: string;
    /** a live region for a state that appears on its own and should be announced */
    live?: boolean;
  }
  let { glyph, message, tone = 'neutral', children, testid, live = false }: Props = $props();
</script>

<div
  class="text-text-secondary flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center text-sm"
  role={tone === 'critical' ? 'alert' : live ? 'status' : undefined}
  data-testid={testid}
>
  {#if glyph}
    <Glyph name={glyph} size={32} class={tone === 'critical' ? 'text-critical' : ''} />
  {/if}
  <p>{message}</p>
  {@render children?.()}
</div>

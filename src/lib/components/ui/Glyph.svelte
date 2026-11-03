<!-- One drawn icon (Lucide paths, see data/glyph-icons.ts). `size` is the box in px; colour inherits unless given. -->
<script lang="ts">
  import { glyphIcons } from '$lib/data/glyph-icons';
  import type { GlyphName } from '$lib/data/glyphs';

  interface Props {
    name: GlyphName;
    size?: number;
    color?: string;
    class?: string;
  }
  let { name, size = 16, color, class: className = '' }: Props = $props();

  // A missing entry must never be invisible: draw a dashed box instead (the unit test makes this unreachable).
  const paths = $derived(glyphIcons[name] ?? ['M4 4h16v16H4z']);
</script>

<span
  class="inline-grid shrink-0 place-items-center leading-none {className}"
  style:width="{size}px"
  style:height="{size}px"
  style:color
  aria-hidden="true"
>
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="shrink-0"
  >
    {#each paths as d (d)}
      <path {d} />
    {/each}
  </svg>
</span>

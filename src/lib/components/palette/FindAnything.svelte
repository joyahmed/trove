<!-- Find anything: the Spotlight palette as a panel floating near the top of an explorer window —
     Ctrl+K (⌘K), or the chip in the search box. A click outside, Esc, or the keyboard moving
     elsewhere (Ctrl+F) closes it. Rare, so the palette is mounted only while open
     (CONTRIBUTING § 5). The Spotlight window is the same palette and is untouched by this. -->
<script lang="ts">
  import { findAnything, type PaletteHost } from '$lib/hooks/use-palette.svelte';
  import { spotlight } from '$lib/state/spotlight-bridge.svelte';

  /** a result acts on THIS window — the Spotlight events reach only the main one (Ctrl+N) */
  const host: PaletteHost = { close: () => findAnything.close(), target: spotlight };

  /** a mousedown on the layer itself, not on the panel: a click outside */
  const onmousedown = (e: MouseEvent) => {
    if (e.target === e.currentTarget) findAnything.close();
  };

  /** focus went somewhere outside the panel on purpose (Ctrl+F): close, and leave it there */
  const onfocusout = (e: FocusEvent) => {
    const to = e.relatedTarget;
    if (to instanceof Node && !(e.currentTarget as HTMLElement).contains(to)) {
      findAnything.close(false);
    }
  };
</script>

{#if findAnything.open}
  <div
    class="z-dialog fixed inset-0 flex items-start justify-center pt-14"
    role="presentation"
    {onmousedown}
    {onfocusout}
  >
    {#await import('./Palette.svelte') then { default: Palette }}
      <Palette {host} />
    {/await}
  </div>
{/if}

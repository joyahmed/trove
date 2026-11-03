<!-- A month heading in the Gallery, with the count. Its place is set by the line plan
     (`planGallery`), not by the flow, so it can be mounted on its own. -->
<script lang="ts">
  import type { GalleryGroup } from '$lib/state/gallery.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    group: GalleryGroup;
  }
  let { group }: Props = $props();
</script>

<h2 class="text-text-secondary mt-2 mb-1 flex h-8 items-center gap-2 text-sm font-normal">
  <Glyph name="chevronDown" size={9} />
  <span>{group.label} ({group.items.length})</span>
</h2>

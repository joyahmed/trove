<!-- A file's drawn icon, by category from its name (data/file-categories.ts). Used off Windows,
     where the shell has no per-file icon (plan 14). -->
<script lang="ts">
  import { fileTypeIconOf } from '$lib/data/file-categories';
  import Glyph from './Glyph.svelte';

  interface Props {
    name: string;
    size?: number;
  }
  let { name, size = 16 }: Props = $props();
  const icon = $derived(fileTypeIconOf(name));
</script>

<Glyph name={icon.glyph} {size} color={icon.tint} />

<!-- Explorer's Item check boxes (plan 06 6.3): a 16 px box before the icon, ticked when the row is
     selected. It is a picture of the selection, not a form control: `aria-hidden`, because the row
     already says `aria-selected`. The click lands on the row; `data-check` is how
     `use-file-list.onRowClick` tells a box click (toggle, like Ctrl) from a row click. -->
<script lang="ts">
  import { settings } from '$lib/state/settings.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    selected: boolean;
    /** Icons view: pinned to the tile's top-left corner instead of sitting in the line */
    corner?: boolean;
  }
  let { selected, corner = false }: Props = $props();
</script>

{#if settings.itemCheckboxes}
  <span
    class="grid size-4 shrink-0 place-items-center rounded-[3px] border {selected
      ? 'bg-accent border-accent text-accent-text'
      : 'border-text-secondary bg-transparent'} {corner ? 'absolute top-1.5 left-1.5' : ''}"
    data-check
    aria-hidden="true"
  >
    {#if selected}<Glyph name="check" size={12} />{/if}
  </span>
{/if}

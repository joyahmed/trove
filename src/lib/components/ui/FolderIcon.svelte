<!-- The Win11 yellow folder, as SVG so it scales and recolours. Real shell icons are Phase 2. -->
<script lang="ts">
  interface Props {
    size?: number;
  }
  let { size = 16 }: Props = $props();
</script>

<svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" class="shrink-0">
  <path
    d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.4a1.5 1.5 0 0 1 1.06.44L8 3.5h5.5A1.5 1.5 0 0 1 15 5v1H1V3.5Z"
    fill="var(--color-folder-shade)"
  />
  <path
    d="M1 6h14v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5V6Z"
    fill="var(--color-folder)"
  />
</svg>

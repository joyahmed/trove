<!-- An image at its natural size, scaled down to fit. -->
<script lang="ts">
  interface Props {
    src: string;
    alt: string;
  }
  let { src, alt }: Props = $props();
</script>

<div class="bg-layer grid min-h-0 flex-1 place-items-center">
  <img
    {src}
    {alt}
    class="max-h-full max-w-full object-contain"
    decoding="async"
    draggable="false"
  />
</div>

<!-- A category label above its rows: 24 px, caps. -->
<script lang="ts">
  interface Props {
    label: string;
  }
  let { label }: Props = $props();
</script>

<div
  class="text-text-secondary flex h-6 items-end px-3 pb-1 text-[11px] font-semibold tracking-wide uppercase"
>
  {label}
</div>

<!-- One label / value pair of the Details pane. -->
<script lang="ts">
  interface Props {
    label: string;
    value: string;
  }
  let { label, value }: Props = $props();
</script>

<span class="text-text-secondary whitespace-nowrap">{label}</span>
<span class="truncate" title={value}>{value}</span>

<!-- One label / value pair of the Details pane. -->
<script lang="ts">
  interface Props {
    label: string;
    value: string;
    /** the text printed when it differs from the tooltip `value` (home as `~`) */
    shown?: string;
  }
  let { label, value, shown }: Props = $props();
</script>

<span class="text-text-secondary whitespace-nowrap">{label}</span>
<span class="truncate" title={value}>{shown ?? value}</span>

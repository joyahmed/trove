<!-- One attribute checkbox (Read-only / Hidden) that writes back to the file. -->
<script lang="ts">
  interface Props {
    label: string;
    checked: boolean;
    disabled: boolean;
    onchange: (value: boolean) => void;
  }
  let { label, checked, disabled, onchange }: Props = $props();
</script>

<label class="flex items-center gap-2 {disabled ? 'text-text-disabled' : ''}">
  <input
    type="checkbox"
    class="trove-check"
    {checked}
    {disabled}
    onchange={(e) => onchange((e.currentTarget as HTMLInputElement).checked)}
  />
  <span>{label}</span>
</label>

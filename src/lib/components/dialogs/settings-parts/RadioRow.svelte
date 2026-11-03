<!-- A radio group as Fluent segmented choices: one button per option, the chosen one filled. -->
<script lang="ts">
  import type { RadioOption } from '$lib/data/settings-sections';

  interface Props {
    options: RadioOption[];
    value: string;
    label: string;
    onchange: (key: string) => void;
  }
  let { options, value, label, onchange }: Props = $props();
</script>

<div class="flex flex-wrap justify-end gap-1" role="radiogroup" aria-label={label}>
  {#each options as option (option.key)}
    <button
      type="button"
      role="radio"
      aria-checked={option.key === value}
      class="rounded-control h-8 border px-3 text-sm {option.key === value
        ? 'bg-accent text-accent-text border-accent'
        : 'border-divider hover:bg-subtle-hover'}"
      onclick={() => onchange(option.key)}>{option.label}</button
    >
  {/each}
</div>

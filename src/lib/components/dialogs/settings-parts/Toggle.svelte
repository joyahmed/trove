<!-- A Win11 toggle switch: 40×20 track, accent when on, a 12 px knob that slides. -->
<script lang="ts">
  interface Props {
    on: boolean;
    disabled?: boolean;
    label: string;
    onchange: (on: boolean) => void;
  }
  let { on, disabled = false, label, onchange }: Props = $props();
</script>

<button
  type="button"
  role="switch"
  aria-checked={on}
  aria-label={label}
  {disabled}
  class="relative h-5 w-10 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 {on
    ? 'bg-accent border-accent'
    : 'border-text-secondary bg-transparent'}"
  onclick={() => onchange(!on)}
>
  <span
    class="absolute top-1/2 size-3 -translate-y-1/2 rounded-full transition-[left] {on
      ? 'bg-accent-text left-[23px]'
      : 'bg-text-secondary left-[3px]'}"
  ></span>
</button>

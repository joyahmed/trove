<!-- A chord picker: click, press the keys you want, and that becomes the shortcut.
     Typing a chord into a text box means knowing the canonical spelling ("super+space"), which
     nobody should have to. Recording it is the only honest input for a keyboard shortcut. -->
<script lang="ts">
  import { prettyChord } from '$lib/utils/hotkeys';
  import { useHotkeyRecorder } from '$lib/hooks/use-hotkey-recorder.svelte';

  interface Props {
    value: string;
    label: string;
    onchange: (chord: string) => unknown;
  }
  let { value, label, onchange }: Props = $props();

  const rec = useHotkeyRecorder((chord) => onchange(chord));
</script>

<svelte:window onkeydown={rec.onkeydown} onkeyup={rec.onkeyup} onblur={rec.onblur} />

<div class="flex shrink-0 flex-col items-end gap-1">
  <button
    type="button"
    class="rounded-control border-divider hover:bg-subtle-hover h-8 min-w-[9rem] border px-3 {rec.recording
      ? 'border-accent'
      : ''}"
    aria-label={rec.recording ? 'Press the shortcut you want' : `${label}: ${prettyChord(value)}`}
    data-hotkey-recording={rec.recording ? '' : undefined}
    onclick={rec.toggle}
  >
    {rec.recording ? 'Press keys…' : prettyChord(value)}
  </button>
  {#if rec.refused}
    <div class="hotkey-refused text-text-secondary max-w-[16rem] text-right text-xs" role="status">
      {rec.refused}
    </div>
  {/if}
</div>

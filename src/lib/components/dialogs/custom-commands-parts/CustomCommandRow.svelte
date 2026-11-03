<!-- One of the person's commands in the customize list: label, program + args, its scopes.
     Two lines on the left, the scopes as chips on the right — so the eye gets a column of labels,
     a column of command lines and a column of chips rather than three ragged stacked strings, and
     a row costs two lines instead of three, which is two more rows visible in the same box. -->
<script lang="ts">
  import type { CustomCommand } from '$lib/types/shell-verbs';
  import Glyph from '$lib/components/ui/Glyph.svelte';

  interface Props {
    command: CustomCommand;
    onedit: () => void;
    ondelete: () => void;
  }
  let { command, onedit, ondelete }: Props = $props();
</script>

<div
  class="border-divider hover:bg-subtle-hover flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
>
  <div class="min-w-0 flex-1">
    <div class="truncate font-medium">{command.label}</div>
    <div class="text-text-secondary truncate font-mono text-xs">
      {command.program}
      {command.args}
    </div>
  </div>
  {#if command.scope.length > 0}
    <div class="flex shrink-0 flex-wrap justify-end gap-1">
      {#each command.scope as scope (scope)}
        <span class="border-divider text-text-secondary rounded-full border px-2 text-xs leading-5"
          >{scope}</span
        >
      {/each}
    </div>
  {:else}
    <!-- Not a chip: a command with no scope is never shown, and that is a fault, not a label. -->
    <span class="text-critical shrink-0 text-xs">no scope — never shown</span>
  {/if}
  <button
    type="button"
    class="rounded-control hover:bg-subtle-selected grid size-7 shrink-0 place-items-center"
    title="Edit"
    aria-label="Edit {command.label}"
    onclick={onedit}
  >
    <Glyph name="rename" size={14} />
  </button>
  <button
    type="button"
    class="rounded-control hover:bg-subtle-selected grid size-7 shrink-0 place-items-center"
    title="Delete"
    aria-label="Delete {command.label}"
    onclick={ondelete}
  >
    <Glyph name="delete" size={14} />
  </button>
</div>

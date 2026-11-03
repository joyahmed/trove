<!-- "Customize context menu…": the person's own commands (add / edit / delete) and a way to
     re-read Windows' registered entries. Mounted on demand from Shell.svelte.

     ⭐ Size comes from the family, not from this dialog's own taste. The repo sizes a dialog by
     what it *is*: 420 wide for a question (Confirm, Conflict), 560 for a one-field prompt
     (Shell's rename box), and a surface you work in gets a big box. This screen is both, so it
     takes both — the list is a working surface, the edit form is a prompt at 560 wide and as
     tall as its fields.

     ⭐ THE SURFACE GROWS WITH THE WINDOW. 880 × 560 was sized against the 800 × 500 minimum
     window and then left there, so on a 2560 × 1440 screen this box was a third of the width
     and scrolled its own content: the suggestion strip showed 4 of 10 detected apps and hid the
     other 6 behind a scrollbar with 900 unused pixels underneath it. The size is now a range —
     `min(1120px, max(880px, 62vw))` wide, `min(800px, max(560px, 66vh))` tall. The bottom of
     each range is exactly the old size, so nothing changed at 1280 × 800 or below.

     ⛔ The top of the range is a MAXIMUM ON PURPOSE, and it is not "as much as fits". 1120 is 44%
     of a 2560 screen and 800 is 56% of a 1440 one: big, and still plainly a dialog rather than a
     sheet. Both numbers come off the content. 800 is the smallest height at which the strip can
     show TWELVE detected apps unscrolled (six tile rows need 426px of cap, which needs 751px of
     dialog) — headroom over tonight's ten, because the catalogue went 4 → 9 in a night. Going
     past it only stretches the commands list, and an empty bordered box is the other failure:
     at 880 the list stood 190px taller than its three rows, at 800 it is 113 — about two rows of
     "there is room for more", which is what a list you add to should look like.
     SettingsDialog shares the width rule but keeps its 560 height, because its content is short
     and height there is only dead space — the reasoning is written out in that file.

     ⛔ The two `max-` caps are the floor behaviour and must stay: the window's minimum is
     800 × 500 and it gets dragged narrow, so the box has to be able to give the width and the
     height back rather than centre itself off the edge of the screen. -->
<script lang="ts">
  import { useCustomizeDialog } from '$lib/hooks/use-customize-dialog.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import CustomCommandRow from './custom-commands-parts/CustomCommandRow.svelte';
  import CustomCommandForm from './custom-commands-parts/CustomCommandForm.svelte';
  import DetectedCommands from './custom-commands-parts/DetectedCommands.svelte';

  import { customizeIntro, showsWindowsEntries } from '$lib/utils/customize-text';

  const dialog = useCustomizeDialog();
</script>

<svelte:window onkeydown={dialog.onkeydown} />

<div class="z-dialog-nested fixed inset-0 grid place-items-center bg-black/40" role="presentation">
  <div
    class="bg-layer border-divider rounded-dialog shadow-flyout flex max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] flex-col border p-5 text-sm outline-none {dialog.draft
      ? 'w-[560px]'
      : 'h-[min(800px,max(560px,66vh))] w-[min(1120px,max(880px,62vw))]'}"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    use:dialog.trap
    aria-labelledby="customize-title"
  >
    <div class="mb-4 flex shrink-0 items-start gap-4">
      <div class="min-w-0 flex-1">
        <h2 id="customize-title" class="text-lg font-semibold">Customize context menu</h2>
        {#if !dialog.draft}
          <p class="text-text-secondary mt-0.5">
            {customizeIntro(dialog.verbCount)}
          </p>
        {/if}
      </div>
      <button
        type="button"
        class="rounded-control hover:bg-subtle-hover grid size-7 shrink-0 place-items-center"
        title="Close"
        aria-label="Close"
        onclick={dialog.close}
      >
        <Glyph name="close" size={10} />
      </button>
    </div>

    {#if dialog.draft}
      <CustomCommandForm {dialog} />
    {:else}
      <DetectedCommands
        suggestions={dialog.suggestions}
        detecting={dialog.detecting}
        onadd={dialog.addDetected}
      />
      <!-- The subject of this dialog, and the only thing here allowed to take the leftover room. -->
      <div
        class="border-divider rounded-control min-h-0 flex-1 [scrollbar-gutter:stable] overflow-auto border"
      >
        {#each dialog.commands as command (command.id)}
          <CustomCommandRow
            {command}
            onedit={() => dialog.edit(command)}
            ondelete={() => dialog.remove(command.id)}
          />
        {:else}
          <p class="text-text-secondary px-4 py-12 text-center">
            No commands yet — “Add command” writes your first one.
          </p>
        {/each}
      </div>
      {#if dialog.hiddenCount > 0}
        <p class="text-text-secondary mt-2 shrink-0 text-xs">
          {dialog.hiddenCount} Windows-only {dialog.hiddenCount === 1 ? 'command' : 'commands'} hidden
        </p>
      {/if}
      <div class="mt-4 flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="rounded-control bg-accent text-accent-text h-8 px-4 hover:opacity-90"
          onclick={dialog.add}>Add command</button
        >
        {#if showsWindowsEntries()}
          <button
            type="button"
            class="rounded-control border-divider hover:bg-subtle-hover h-8 border px-4 disabled:opacity-50"
            disabled={dialog.refreshing}
            onclick={dialog.refresh}
            >{dialog.refreshing ? 'Reading…' : 'Refresh Windows entries'}</button
          >
        {/if}
        <div class="flex-1"></div>
        <button
          type="button"
          class="rounded-control border-divider hover:bg-subtle-hover h-8 border px-4"
          onclick={dialog.close}>Done</button
        >
      </div>
    {/if}
  </div>
</div>

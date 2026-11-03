<!-- One settings row: label and description on the left, the control on the right, an
     optional note under it. The control is chosen by the row's `kind`. -->
<script lang="ts">
  import type { SettingRow } from '$lib/data/settings-sections';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import Toggle from './Toggle.svelte';
  import RadioRow from './RadioRow.svelte';
  import HotkeyRow from './HotkeyRow.svelte';
  import SearchEngineRow from './SearchEngineRow.svelte';
  import FolderListRow from './FolderListRow.svelte';

  interface Props {
    row: SettingRow;
  }
  let { row }: Props = $props();
  const disabled = $derived(row.disabled?.() === true);
  const note = $derived(row.note?.() ?? null);
</script>

<!-- ⛔ The label column must keep a floor. With `min-w-0 flex-1` it was the only child
     flexbox could shrink, so a wide control (the five-button View group wants ~500px against
     a ~471px budget) drove it to min-content - the width of its longest single WORD - and the
     description rendered one word per line. `flex-wrap` is the other half: a control that
     still cannot fit now drops to its own line instead of squeezing the label sideways. -->
<div
  class="settings-row border-divider flex min-h-12 flex-wrap items-center gap-x-6 gap-y-2 border-b py-2 last:border-b-0"
>
  <div class="settings-row-text min-w-[14rem] flex-1">
    <div class="settings-row-label text-sm">{row.label}</div>
    {#if row.description}
      <div class="settings-row-desc text-text-secondary text-xs">{row.description}</div>
    {/if}
    {#if note}
      <div class="settings-row-note text-text-secondary mt-1 text-xs">{note}</div>
    {/if}
  </div>
  {#if row.kind === 'toggle'}
    <Toggle on={row.get()} {disabled} label={row.label} onchange={(on) => row.set(on)} />
  {:else if row.kind === 'radio'}
    <RadioRow options={row.options} value={row.get()} label={row.label} onchange={row.set} />
  {:else if row.kind === 'hotkey'}
    <HotkeyRow value={row.get()} label={row.label} onchange={row.set} />
  {:else if row.kind === 'engine'}
    <SearchEngineRow options={row.options} value={row.get()} label={row.label} onchange={row.set} />
  {:else if row.kind === 'folders'}
    <FolderListRow
      folders={row.get()}
      label={row.label}
      {disabled}
      onadd={row.add}
      onremove={row.remove}
    />
  {:else if row.kind === 'info'}
    <!-- no control: the description already says why this build cannot offer it -->
  {:else if row.kind === 'button'}
    <button
      type="button"
      class="rounded-control h-8 shrink-0 border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50 {row.danger
        ? 'border-critical text-critical hover:bg-subtle-hover'
        : 'border-divider hover:bg-subtle-hover'}"
      {disabled}
      onclick={() => void row.run()}>{row.buttonLabel}</button
    >
  {:else}
    <div
      class="settings-stepper flex shrink-0 items-center gap-1"
      role="group"
      aria-label={row.label}
    >
      <button
        type="button"
        class="settings-stepper-btn rounded-control border-divider hover:bg-subtle-hover grid size-8 place-items-center border disabled:opacity-50"
        aria-label="Smaller"
        disabled={!row.canStep(-1)}
        onclick={() => row.step(-1)}><Glyph name="minimize" size={10} /></button
      >
      <span class="settings-stepper-value w-14 text-center text-sm tabular-nums">{row.get()}</span>
      <button
        type="button"
        class="settings-stepper-btn rounded-control border-divider hover:bg-subtle-hover grid size-8 place-items-center border disabled:opacity-50"
        aria-label="Bigger"
        disabled={!row.canStep(1)}
        onclick={() => row.step(1)}><Glyph name="add" size={10} /></button
      >
      <button
        type="button"
        class="settings-stepper-reset rounded-control hover:bg-subtle-hover ml-1 h-8 px-2 text-sm"
        onclick={() => row.reset()}>Reset</button
      >
    </div>
  {/if}
</div>

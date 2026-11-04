<!-- The palette's preview pane (plan 04 4.4): the lit row's picture, text head, PDF or folder
     summary, its name and a meta line, then Open / Reveal / Copy path / Rename. Its left edge
     drags the width; Alt+→ / Alt+← show and hide it (use-palette). The picture parts are the
     explorer preview pane's own. -->
<script lang="ts">
  import {
    usePalettePreview,
    type PalettePreviewArgs,
  } from '$lib/hooks/use-palette-preview.svelte';
  import FolderIcon from '$lib/components/ui/FolderIcon.svelte';
  import EntryIcon from '$lib/components/ui/EntryIcon.svelte';
  import ImagePreview from '$lib/components/panes/preview-parts/ImagePreview.svelte';
  import PdfPreview from '$lib/components/panes/preview-parts/PdfPreview.svelte';
  import TextPreview from '$lib/components/panes/preview-parts/TextPreview.svelte';

  let props: PalettePreviewArgs = $props();
  // svelte-ignore state_referenced_locally
  const pv = usePalettePreview(props);
  const { state } = pv;
</script>

{#snippet action(label: string, run: () => void, primary = false)}
  <button
    type="button"
    class="rounded-control h-7 px-2.5 text-xs {primary
      ? 'bg-accent text-accent-text hover:opacity-90'
      : 'hover:bg-subtle-hover border-divider border'}"
    onpointerdown={(e) => e.preventDefault()}
    onclick={run}>{label}</button
  >
{/snippet}

<aside
  class="border-divider relative flex min-h-0 shrink-0 flex-col gap-3 border-l p-3"
  style:width="{pv.width}px"
  aria-label="Preview"
  data-palette-preview=""
>
  <!-- the drag handle: the pane's left edge -->
  <div
    class="absolute inset-y-0 -left-1 w-2 cursor-col-resize"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize preview"
    onpointerdown={pv.startResize}
  ></div>
  {#if pv.target}
    <div class="rounded-card bg-layer flex min-h-0 flex-1 flex-col overflow-auto">
      {#if pv.isDir}
        <div class="grid flex-1 place-items-center"><FolderIcon size={64} /></div>
      {:else if pv.kind === 'image'}
        <ImagePreview src={pv.url} alt={pv.name} />
      {:else if pv.kind === 'pdf' && pv.entry}
        <PdfPreview src={pv.url} title={pv.name} entry={pv.entry} onopen={pv.open} />
      {:else if pv.kind === 'text'}
        <div class="p-3">
          <TextPreview head={state.text} loading={state.text === null} error={state.textError} />
        </div>
      {:else if pv.poster}
        <ImagePreview src={pv.poster} alt={pv.name} />
      {:else if pv.entry}
        <div class="grid flex-1 place-items-center">
          <EntryIcon entry={pv.entry} size={32} box={64} />
        </div>
      {/if}
    </div>
    <div class="flex min-w-0 shrink-0 flex-col gap-1">
      {#if state.renaming}
        <input
          class="rounded-control border-accent bg-layer h-7 border px-2 text-sm"
          aria-label="New name"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          autocomplete="off"
          bind:value={state.draft}
          onkeydown={pv.renameKeydown}
          onblur={() => (state.renaming = false)}
          use:pv.attachRename
        />
        {#if state.renameError}
          <p class="text-critical text-xs" role="alert">{state.renameError}</p>
        {/if}
      {:else}
        <h2 class="truncate text-sm font-semibold" title={pv.name}>{pv.name}</h2>
      {/if}
      {#if pv.meta}<p class="text-text-secondary truncate font-mono text-[11px]">{pv.meta}</p>{/if}
    </div>
    <div class="flex shrink-0 flex-wrap gap-1.5">
      {@render action('Open', pv.open, true)}
      {@render action('Reveal', pv.reveal)}
      {#each pv.copyForms as form (form.key)}
        {@render action(
          state.copied === form.key ? 'Copied' : form.label,
          () => void pv.copy(form),
        )}
      {/each}
      {@render action('Rename', pv.startRename)}
    </div>
  {:else}
    <p class="text-text-secondary grid flex-1 place-items-center text-center text-xs">No preview</p>
  {/if}
</aside>

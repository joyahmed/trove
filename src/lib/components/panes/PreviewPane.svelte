<!-- The preview pane: the one selected file as a rounded preview, its name in the serif face, a
     mono meta line, Open / Reveal, and a facts list; else a summary of the folder or the
     selection. Mounted lazily by PaneHost on Alt+P / View › Preview pane. -->
<script lang="ts">
  import { previewFacts, previewMeta, usePreviewPane } from '$lib/hooks/use-preview-pane.svelte';
  import EntryIcon from '$lib/components/ui/EntryIcon.svelte';
  import Glyph from '$lib/components/ui/Glyph.svelte';
  import ImagePreview from './preview-parts/ImagePreview.svelte';
  import VideoPreview from './preview-parts/VideoPreview.svelte';
  import PdfPreview from './preview-parts/PdfPreview.svelte';
  import TextPreview from './preview-parts/TextPreview.svelte';
  import PreviewSummary from './preview-parts/PreviewSummary.svelte';
  import { previewEntryIcon } from '$lib/hooks/use-preview-pane-icon';
  import { wantsPosterThumb } from '$lib/data/preview-poster';
  import { thumbUrl } from '$lib/api/icons';
  import { thumbStamp } from '$lib/utils/thumb-stamp';

  const pane = usePreviewPane();
</script>

<div class="flex min-h-0 flex-1 flex-col" data-mac="pane">
  <header class="flex h-9 shrink-0 items-center justify-end gap-2 pr-1 pl-4 text-sm">
    {#if !pane.entry}<span class="text-text-secondary flex-1 truncate">Preview</span>{/if}
    <button
      type="button"
      class="rounded-control hover:bg-subtle-hover grid size-7 place-items-center"
      title="Close preview pane"
      aria-label="Close preview pane"
      onclick={pane.close}
    >
      <Glyph name="close" size={10} />
    </button>
  </header>
  {#if pane.entry}
    {@const entry = pane.entry}
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 pb-4">
      <div
        class="rounded-card bg-layer flex h-56 shrink-0 flex-col overflow-auto"
        data-mac="preview-box"
      >
        {#if pane.notice}
          <p class="text-text-secondary grid flex-1 place-items-center p-4 text-center text-sm">
            {pane.notice}
          </p>
        {:else if pane.kind !== 'none' && pane.kind !== 'text' && !pane.url}
          <!-- a file inside an archive while its temp copy is made -->
          <p class="text-text-secondary grid flex-1 place-items-center text-sm">Loading…</p>
        {:else if pane.kind === 'video' && wantsPosterThumb(entry, pane.kind)}
          <VideoPreview
            src={pane.url}
            audio={false}
            {entry}
            onopen={() => pane.open(entry)}
            poster={thumbUrl(entry.path, 256, thumbStamp(entry))}
          />
        {:else if pane.kind === 'none' && wantsPosterThumb(entry, pane.kind)}
          <ImagePreview src={thumbUrl(entry.path, 256, thumbStamp(entry))} alt={entry.name} />
        {:else if pane.kind === 'image'}
          <ImagePreview src={pane.url} alt={entry.name} />
        {:else if pane.kind === 'video' || pane.kind === 'audio'}
          <VideoPreview
            src={pane.url}
            audio={pane.kind === 'audio'}
            {entry}
            onopen={() => pane.open(entry)}
          />
        {:else if pane.kind === 'pdf'}
          <PdfPreview src={pane.url} title={entry.name} {entry} onopen={() => pane.open(entry)} />
        {:else if pane.kind === 'text'}
          <TextPreview head={pane.text} loading={pane.loading} error={pane.error} />
        {:else}
          <div class="grid flex-1 place-items-center">
            {#if previewEntryIcon(entry) === 'bin'}
              <Glyph name="delete" size={64} />
            {:else}
              <EntryIcon {entry} size={32} box={64} />
            {/if}
          </div>
        {/if}
      </div>
      <div class="flex min-w-0 flex-col gap-1" data-mac="preview-name">
        <h2 class="line-clamp-2 text-lg leading-snug font-semibold break-words" title={entry.name}>
          {entry.name}
        </h2>
        <p class="text-text-secondary font-mono text-[11px]">{previewMeta(entry)}</p>
      </div>
      <div class="flex gap-2">
        <button
          type="button"
          class="bg-accent text-accent-text rounded-control h-8 flex-1 px-3 text-sm hover:opacity-90"
          onclick={() => pane.open(entry)}
        >
          Open
        </button>
        <button
          type="button"
          class="hover:bg-subtle-hover rounded-control h-8 px-3 text-sm"
          title="Show in its folder"
          onclick={() => void pane.reveal(entry)}
        >
          Reveal
        </button>
      </div>
      <dl
        class="border-divider grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t pt-3 text-xs"
        data-mac="info-grid"
      >
        {#each previewFacts(entry) as fact (fact.label)}
          <dt class="text-text-secondary">{fact.label}</dt>
          <dd class="min-w-0 break-words" title={fact.value}>{fact.value}</dd>
        {/each}
      </dl>
    </div>
  {:else}
    <div class="flex min-h-0 flex-1 flex-col overflow-auto px-4 pb-4">
      <PreviewSummary
        entry={null}
        count={pane.count}
        folderLabel={pane.folderLabel}
        folderCount={pane.folderCount}
        icon={pane.placeIcon}
      />
    </div>
  {/if}
</div>

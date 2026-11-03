<!-- Video or audio with the webview's own controls; metadata only until played. On Linux the file
     comes in as a blob first (`use-media-src`): WebKitGTK cannot play the preview protocol. A file
     too big for that (over 512 MB) shows its thumbnail and a "Play in <default app>" button that
     opens it in the system's player instead (plan 02 2.9). -->
<script lang="ts">
  import type { FileEntry } from '$lib/types/fs';
  import { useVideoPreview } from '$lib/hooks/use-video-preview.svelte';
  import EntryIcon from '$lib/components/ui/EntryIcon.svelte';

  interface Props {
    src: string;
    audio: boolean;
    entry: FileEntry;
    /** opens the file with the system's default app */
    onopen: () => void;
    /** a thumbnail shown (and sizing the player) until the video's own frame is there */
    poster?: string;
  }
  let { src, audio, entry, onopen, poster }: Props = $props();
  const media = useVideoPreview(
    () => src,
    () => entry.path,
  );
</script>

<div class="grid min-h-0 flex-1 place-items-center">
  {#if media.refused}
    <div class="flex min-h-0 flex-col items-center justify-center gap-3 p-3">
      {#if poster}
        <img src={poster} alt={entry.name} class="max-h-28 max-w-full object-contain" />
      {:else}
        <EntryIcon {entry} size={32} box={64} />
      {/if}
      <button
        type="button"
        class="hover:bg-subtle-hover rounded-control h-8 px-3 text-sm"
        onclick={onopen}
      >
        {media.playLabel}
      </button>
    </div>
  {:else if media.src === null}
    <p class="text-text-secondary text-sm">Loading…</p>
  {:else if audio}
    <audio src={media.src} controls preload="metadata" class="w-full"></audio>
  {:else}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      src={media.src}
      {poster}
      controls
      preload="metadata"
      class="max-h-full max-w-full object-contain"
    ></video>
  {/if}
</div>

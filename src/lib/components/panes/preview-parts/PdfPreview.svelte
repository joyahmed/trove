<!-- The webview's built-in PDF viewer, full size. Linux's WebKitGTK has none (the frame stays
     blank), so there the box shows the file's icon and an Open button instead. Windows
     (WebView2) and macOS (WKWebView) render PDFs themselves. -->
<script lang="ts">
  import type { FileEntry } from '$lib/types/fs';
  import { onMac, onWindows } from '$lib/utils/platform';
  import EntryIcon from '$lib/components/ui/EntryIcon.svelte';

  interface Props {
    src: string;
    title: string;
    entry: FileEntry;
    onopen: () => void;
  }
  let { src, title, entry, onopen }: Props = $props();
  const framed = onWindows() || onMac();
</script>

{#if framed}
  <iframe {src} {title} class="min-h-0 w-full flex-1 border-0"></iframe>
{:else}
  <div class="flex flex-1 flex-col items-center justify-center gap-3">
    <EntryIcon {entry} size={32} box={64} />
    <button
      type="button"
      class="hover:bg-subtle-hover rounded-control h-8 px-3 text-sm"
      onclick={onopen}
    >
      Open
    </button>
  </div>
{/if}

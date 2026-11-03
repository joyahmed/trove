<!-- A picture Rust decodes off Windows (plan 14.2, `core/image_thumbs.rs`): the category glyph
     first, the thumbnail once it has loaded, and the glyph for good when the request fails — 404
     (too big, unreadable, an unsupported variant) or 503 (shed under a scroll burst). Never a
     broken image. The request waits until the row or tile has stayed mounted (`useSettled`), so
     a scrollbar drag asks Rust to decode nothing. -->
<script lang="ts">
  import { thumbUrl, type BigIconSize } from '$lib/api/icons'; // a pure URL formatter, not IPC
  import { useSettled } from '$lib/hooks/use-settled.svelte';
  import { RETRY_DELAY_MS, isFresh, thumbKey } from '$lib/utils/thumb-stamp';
  import FileTypeIcon from './FileTypeIcon.svelte';

  interface Props {
    path: string;
    name: string;
    /** the box, px */
    size: number;
    /** the thumbnail size asked of Rust: 48 for a 16 px row (sharp on a 2x screen), else the box */
    request: BigIconSize;
    /** the glyph's size while there is no picture; the box by default */
    glyphSize?: number;
    /** fill the box (Gallery) rather than fit inside it at no more than the picture's own size */
    cover?: boolean;
    /** the entry's `size-mtime` (`thumbStamp`): a changed file is a new request, not a known failure */
    stamp?: string;
    /** the entry's mtime, ms: a failure on a file under 10 s old gets one automatic retry */
    modifiedMs?: number | null;
    /** a square that fills its container's width, `size` px at most (the Details pane header) */
    fluid?: boolean;
  }
  let {
    path,
    name,
    size,
    request,
    glyphSize = size,
    cover = false,
    stamp = '',
    modifiedMs = null,
    fluid = false,
  }: Props = $props();
  const settled = useSettled();
  // Keyed by path + size + mtime, not plain flags: a virtualized row is handed other entries, and
  // "loaded" or "failed" must not stick to whichever file comes next — nor to this file after it
  // changed (a copy that has finished arriving) or was relisted.
  const key = $derived(thumbKey(path, stamp));
  let loadedFor = $state('');
  let failedFor = $state('');
  // the key already retried once (a plain variable: only read in the error handler)
  let retriedKey = '';
  let retryOf = $state<{ key: string; n: number }>({ key: '', n: 0 });
  const attempt = $derived(retryOf.key === key ? retryOf.n : 0);
  const ask = $derived(settled.ready && failedFor !== key);
  const shown = $derived(ask && loadedFor === key);
  const src = $derived(thumbUrl(path, request, attempt ? `${stamp}-r${attempt}` : stamp));

  function failed() {
    const k = key;
    failedFor = k;
    // A file under 10 s old may simply not have arrived yet (the backend retries those too):
    // ask once more after a moment. Once only, so a truly bad file is not polled.
    if (isFresh(modifiedMs) && retriedKey !== k) {
      retriedKey = k;
      setTimeout(() => {
        if (key !== k) return; // the row moved on to another file
        retryOf = { key: k, n: 1 };
        failedFor = '';
      }, RETRY_DELAY_MS);
    }
  }
</script>

<span
  class="relative grid shrink-0 place-items-center"
  style:width={fluid ? '100%' : `${size}px`}
  style:height={fluid ? null : `${size}px`}
  style:max-width={fluid ? `${size}px` : null}
  style:aspect-ratio={fluid ? '1' : null}
>
  {#if !shown}
    <FileTypeIcon {name} size={glyphSize} />
  {/if}
  {#if ask}
    <!-- not `object-contain` + full size: that would blow a 16 px favicon up to the box. Capped
         at the box and centred, at no more than its own size (Rust never enlarges either). -->
    <img
      {src}
      alt=""
      onload={() => (loadedFor = key)}
      onerror={failed}
      class="absolute inset-0 {cover
        ? 'size-full object-cover'
        : 'm-auto max-h-full max-w-full'} {shown ? '' : 'invisible'}"
      decoding="async"
      draggable="false"
    />
  {/if}
</span>

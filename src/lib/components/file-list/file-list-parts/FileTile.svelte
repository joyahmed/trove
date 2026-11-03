<!-- Icons view: a card whose box follows the icon size (Medium 48, Large 96, Extra large 256):
     the shell's big icon or thumbnail centred in a rounded thumbnail box, then the name and a
     muted meta line. Heights are fixed per size in `tileGeometries`. -->
<script lang="ts">
  import { rowId } from '$lib/utils/row-id';
  import type { FileEntry } from '$lib/types/fs';
  import { dropPathOf, shownName } from '$lib/utils/app-bundle';
  import { tileIconUrl, tilePlaceholderUrl } from '$lib/utils/tile-icon'; // pure URL formatters, not IPC
  import { useSettled } from '$lib/hooks/use-settled.svelte';
  import { tileGeometry } from '$lib/data/view-layouts';
  import { tabs } from '$lib/state/tabs.svelte';
  import { useInfotip } from '$lib/hooks/use-infotip.svelte';
  import FolderIcon from '$lib/components/ui/FolderIcon.svelte';
  import { DRAWN_FILE_ICONS, fileIconKind } from '$lib/utils/file-icon';
  import FileTypeIcon from '$lib/components/ui/FileTypeIcon.svelte';
  import DecodedThumb from '$lib/components/ui/DecodedThumb.svelte';
  import { thumbStamp } from '$lib/utils/thumb-stamp';
  import LinkBadge from '$lib/components/ui/LinkBadge.svelte';
  import { fmtSize } from '$lib/utils/format';
  import { shortKindOf } from '$lib/utils/short-kind';
  import { tileMetaLine } from '$lib/utils/tile-meta';
  import Infotip from './Infotip.svelte';
  import RenameBox from './RenameBox.svelte';

  interface Props {
    entry: FileEntry;
    /** position in the visible list, for aria-rowindex (rows are virtualized) */
    index: number;
    selected: boolean;
    focused: boolean;
    renaming: boolean;
    /** on the cut clipboard: dimmed until pasted */
    cut: boolean;
    /** a drag hovers this folder: it is the drop target */
    dragover: boolean;
    onclick: (e: MouseEvent) => void;
    onpointerdown: (e: PointerEvent) => void;
    /** middle-click: a folder opens in a new tab */
    onauxclick: (e: MouseEvent) => void;
    oncontextmenu: (e: MouseEvent) => void;
    onopen: () => void;
  }
  let {
    entry,
    index,
    selected,
    focused,
    renaming,
    cut,
    dragover,
    onclick,
    onpointerdown,
    onauxclick,
    oncontextmenu,
    onopen,
  }: Props = $props();
  const tile = $derived(tileGeometry(tabs.active.iconSize));
  // Every icon size asks the shell per file — thumbnails for what has them (images, video,
  // PDF), the big icon for everything else — because that is what Explorer does from Medium
  // up. See `tile-icon.ts` for the measurement, and `use-virtual-rows` for why per-file is
  // affordable: only the tiles on screen exist, and each `<img>` is `loading="lazy"`.
  const icon = $derived(tileIconUrl(entry, tile.icon));
  // the thumbnail is only requested once the tile has stayed mounted ~120 ms; until then the
  // cheap extension icon stands in, so a scrollbar drag asks the shell for nothing
  const settled = useSettled();
  // The icon protocol answers 503 when a burst of requests overflows its queue and the oldest
  // is dropped. Keyed by path, not a plain flag, because a virtualized tile is handed other
  // entries: the fallback must not stick to whichever file comes next. Keyed by the URL, which
  // carries the file's size + mtime, so a file that grew or was relisted after a failure (a copy
  // that has finished arriving, B.5.5) asks again instead of keeping the type icon.
  let failedFor = $state('');
  const src = $derived(settled.ready && failedFor !== icon ? icon : tilePlaceholderUrl(entry));
  const tip = useInfotip(() => entry);
  // Off Windows there is no shell icon at any size (plan 14): every folder draws the SVG at the
  // tile's size and every file its category glyph, except a picture Rust decodes (plan 14.2),
  // which shows its own thumbnail. Windows is unchanged: the SVG at 48 only.
  const kind = $derived(fileIconKind(entry));
  // a folder says Folder, a Mac's `X.app` says App (`shortKindOf`)
  const meta = $derived(
    entry.isDir ? shortKindOf(entry) : tileMetaLine(entry.name, fmtSize(entry.size), kind),
  );
</script>

<!-- The selection chip follows Explorer's structure, not its colours: the FILL says "selected"
     and a neutral 1px rim says "focused". `inset-ring` and not `outline`, because an outline
     paints outside the border box — on the bare layer, at full contrast, in the 4px gap between
     tiles — which is what made the old accent outline read as a focus ring bolted onto the tile
     rather than the edge of it. The measurements are in `app.css` beside `--color-selection`.
     ⚠️ `focused` here is the list's roving cursor (`selection.focused`, one path per tab), NOT
     window focus — Trove has no window-blur selection state, so there are three states to get
     right and not four: hover, selected, cursor (selected or not). -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div
  class="rounded-card flex flex-col items-stretch gap-1.5 overflow-hidden p-2 text-center {selected
    ? 'bg-selection'
    : 'hover:bg-subtle-hover'} {focused
    ? 'inset-ring-selection-stroke inset-ring-1'
    : ''} {entry.isHidden || cut ? 'opacity-60' : ''} {dragover
    ? 'bg-selection outline-accent outline-1'
    : ''}"
  style:width="{tile.width}px"
  style:height="{tile.height}px"
  id={rowId(entry.path)}
  role="row"
  aria-rowindex={index + 1}
  aria-selected={selected}
  data-cursor={focused}
  data-mac="tile"
  data-drop={dropPathOf(entry)}
  data-drop-kind="row"
  {onclick}
  {onpointerdown}
  {onauxclick}
  {oncontextmenu}
  ondblclick={onopen}
  onpointerenter={tip.onpointerenter}
  onpointermove={tip.onpointermove}
  onpointerleave={tip.onpointerleave}
>
  <!-- no `title`: the infotip carries the clamped name, and a native tooltip would race it -->
  <Infotip {entry} {tip} />
  <span
    class="bg-subtle-pressed grid shrink-0 place-items-center rounded-lg"
    data-mac="tile-icon"
    style:height="{tile.icon + 16}px"
  >
    <span class="relative inline-flex shrink-0">
      {#if kind === 'folder' && (tile.icon === 48 || DRAWN_FILE_ICONS)}
        <FolderIcon size={tile.icon} />
      {:else if kind === 'drawn'}
        <FileTypeIcon name={entry.name} size={tile.icon} />
      {:else if kind === 'thumb'}
        <DecodedThumb
          path={entry.path}
          name={entry.name}
          size={tile.icon}
          request={tile.icon}
          stamp={thumbStamp(entry)}
          modifiedMs={entry.modifiedMs}
        />
      {:else}
        <span
          class="grid shrink-0 place-items-center"
          style:width="{tile.icon}px"
          style:height="{tile.icon}px"
        >
          <img
            {src}
            onerror={() => (failedFor = icon)}
            alt=""
            class="max-h-full max-w-full object-contain"
            decoding="async"
            loading="lazy"
            draggable="false"
          />
        </span>
      {/if}
      {#if entry.isLink}<LinkBadge size={tile.icon} />{/if}
    </span>
  </span>
  {#if renaming}
    <RenameBox centered />
  {:else}
    <span class="w-full truncate text-xs leading-4" data-mac="tile-name">{shownName(entry)}</span>
    <span class="text-text-secondary -mt-1 w-full truncate text-[11px] leading-4">{meta}</span>
  {/if}
</div>

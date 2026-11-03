// Which icon URL a grid tile draws, for each of Explorer's three icon sizes.
//
// ⭐ Measured against real Explorer on this machine (Windows 11) rather than reasoned about:
//   • Details / List / Small icons (16 px) draw the **association** icon — three visually
//     different wallpapers side by side all get the identical generic "JPG File" glyph, the
//     MP4 gets the VLC cone, the PDF the Chrome badge. Explorer does NOT thumbnail at 16.
//   • The icon views (Medium 48 and up) draw the file's own **thumbnail** — the wallpapers
//     show their pictures, the MP4 its first frame, the PDF its first page.
// So `FileRow` / `FileListItem` keeping `ext/<e>` at 16 px is correct-as-is; the grid asking
// for the same per-extension icon at Medium was the bug.
//
// ────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ There is no allow-list of "extensions the shell can thumbnail", and re-adding one is a
// regression. `src/lib/data/thumbnail-exts.ts` was exactly that and was deleted; this comment
// is the evidence it was carrying, so that nobody has to rediscover it.
//
// Why no allow-list: `thumbs.rs::shell_image_rgba` asks
// `GetImage(SIIGBF_THUMBNAILONLY).or_else(GetImage(SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK))`,
// so for a file with no registered provider the `thumb/` route returns the *same bytes* as the
// `big/` route — `thumbs.rs::a_file_with_no_thumbnail_falls_back_to_its_icon` asserts that
// equality. The two failure modes are therefore not symmetric:
//   • a wrong **exclusion** is VISIBLE — an association glyph where a picture belongs, which is
//     the bug Joy screenshotted ("when the icons are small they show no thumnails");
//   • a wrong **inclusion** is INVISIBLE — one shell call that hands back the icon anyway.
// An allow-list fails visible. And any hardcoded list permanently lags what is actually
// installed: providers arrive with a codec pack, a camera-raw plug-in, Office, a PDF reader.
// `.pdf` has had NO provider on this machine since before `d48f650` routed it through `thumb/`,
// and it has silently taken the icon fallback ever since with no ill effect — the proof in
// production that a generous route is free.
//
// What the registry said when the allow-list was written (kept for the shape, not the list):
// 114 `HKCR\.<ext>\ShellEx\{E357FCCD-A995-4576-B01F-234630154E96}` (IThumbnailProvider) keys
// resolving to six handlers — shell32's {9DBD2C50-62AD-11D0-B806-00C04FD706EC} "Property
// Thumbnail Handler" for ~45 media containers (`.mkv` among them, which is why omitting `.mkv`
// was our bug and never a platform limit) and for audio, where it reads the embedded picture
// frame so album art now comes free; {C7657C4A-9F68-40fa-A4DF-96BC08EB3551} "Photo Thumbnail
// Provider" for `.webp`/`.heic`/camera raw, with plain `png`/`jpg`/`gif`/`bmp`/`tif` reaching it
// indirectly through `PerceivedType=image` →
// `HKCR\SystemFileAssociations\image\ShellEx\{E357FCCD-…}`; and the Word / Excel / PowerPoint /
// Visio handlers. Per-machine, every one of them — which is the point.
//
// ⚠️ The ONE thing the removal has to keep is below, and it is a *cost* rule, not a
// correctness rule. See `THUMBNAIL_TOO_SLOW`.
// ────────────────────────────────────────────────────────────────────────────────────────────
//
// ⚠️ This is NOT `preview-kinds.ts` and must not be re-coupled to it. That map answers what the
// preview *pane* can render; this function answers what the shell can draw. `.mkv` thumbnails
// (shell32 has a provider) but is absent from `KINDS.video` on purpose, because WebView2 has no
// Matroska demuxer — the gate here used to be `previewKindOf(entry)`, and that is why
// `video-b.mkv` drew the VLC cone next to an `.mp4` showing its first frame. Merging the two
// trades an honest "no preview" for a black `<video>` box, or a picture for a glyph.
import type { FileEntry } from '$lib/types/fs';
import type { IconSize } from '$lib/state/settings.svelte';
import { bigIconUrl, iconUrl, thumbUrl } from '$lib/api/icons';
import { isArchivePath } from '$lib/utils/archive-location';
import { thumbStamp } from '$lib/utils/thumb-stamp';

/**
 * Extensions where asking for a thumbnail is too expensive to be worth it — NOT extensions
 * that lack a provider (those are free, see the header) but ones where a provider exists,
 * takes the file, scans all of it, and only then gives up.
 *
 * ⭐ Measured on this machine, `GetImage(SIIGBF_THUMBNAILONLY)` at 48 px, cold, per file:
 *   • a provider-less extension (`.rs`, `.json`, `.svelte`, `.txt`, `.zip`, `.zzqq`) — ~1.8 ms,
 *     against ~0.45 ms for the icon call it replaces. ~1.4 ms of margin, and the shell keeps a
 *     negative answer (a repeat on the same file drops to ~0.08 ms).
 *   • a provider that SUCCEEDS is cheaper still — a real 512×512 PNG thumbnail is ~0.23 ms.
 *   • ⛔ `.ts` — **137 ms** (p50 131 ms, worst 233 ms), measured over 150 real `.ts` files in
 *     this repo. The shell matches `.ts` to MPEG-2 *transport stream* and hands it to the
 *     demuxer, which reads the whole file hunting for sync bytes before failing. Derived, not
 *     measured: a 1400×800 grid at Medium holds ~14 × 7 tiles (`view-layouts.ts`: 96×112, gap
 *     4) and the virtualizer's `overscan: 2` adds two rows either side, so ~154 tiles ask at
 *     once — **~21 seconds** of shell calls for one screen of a TypeScript source tree, and
 *     they serialize behind the single `SHELL` mutex in `icons.rs`.
 *
 * The same demux-then-fail cost hits the rest of the MPEG program/transport-stream family —
 * `vob` 173 ms, `m1v` 164 ms, `m2v` 162 ms, `mpg` 153 ms, `mpe` 153 ms, `mts` 152 ms, `m2t`
 * 140 ms, `mpeg` 136 ms, `m2ts` 136 ms, `ogv` 48 ms — but ONLY when the file is not really
 * that format, and nobody names a non-video file `.vob`. `.ts` is the one extension where the
 * collision is the common case rather than the pathological one, so it is the only entry here.
 *
 * ⚠️ The cost of this entry: a genuine MPEG-TS video draws its association icon instead of its
 * first frame. That is the trade, it is the one the deleted allow-list already made, and it is
 * the right way round — a deny-list fails safe (one icon where a picture could have been, on a
 * rare file) where an allow-list failed visible (a glyph on every picture it forgot).
 */
const THUMBNAIL_TOO_SLOW: ReadonlySet<string> = new Set(['ts']);

/**
 * A tile's `<img src>`: the file's own thumbnail where the shell has one, else the shell's
 * icon rendered at the tile's size — the shell decides, per file, and that is affordable
 * because the list is virtualized and the tiles are `loading="lazy"` (only what is on screen
 * ever asks), because `icons.rs` caches every answer in memory and on disk keyed on path +
 * mtime, and because its per-key gate collapses the simultaneous cold misses of a first paint.
 *
 * ⚠️ Folders are the exception and keep the icon route. A folder's image is an **icon**
 * question — the shell's folder glyph, or whatever `desktop.ini`/IconResource themes it into —
 * and `big/` is the route that honours that. A themed folder arrives here as `file/<path>`
 * rather than `folder` (`fs.rs` swaps the key when `desktop.ini` exists), which makes it the
 * folder that actually reaches `<img>` at 48 px, where a bare one draws `FolderIcon.svelte`.
 */
export const tileIconUrl = (entry: FileEntry, size: IconSize): string =>
  // a file inside an archive has no file for the shell to thumbnail: its extension's icon
  !entry.isDir && isArchivePath(entry.path)
    ? iconUrl(entry.iconKey, 32)
    : entry.isDir || (entry.ext !== null && THUMBNAIL_TOO_SLOW.has(entry.ext))
      ? bigIconUrl(entry.path, size)
      : // the stamp makes a file that grew or changed a new URL, so a cached failure is not reused
        thumbUrl(entry.path, size, thumbStamp(entry));

/**
 * What a tile draws until it has settled (`use-settled`): the cheap per-extension icon, which
 * the shell answers from its cache in well under a millisecond, so a scroll through a huge
 * folder shows glyphs and asks for no thumbnails. `undefined` — no `src` at all — for anything
 * that is not an `ext/` key: a `file/<path>` icon is a per-file shell call, exactly what the
 * gate exists to hold back.
 */
export const tilePlaceholderUrl = (entry: FileEntry): string | undefined =>
  entry.iconKey.startsWith('ext/') ? iconUrl(entry.iconKey, 32) : undefined;

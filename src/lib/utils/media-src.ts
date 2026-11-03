// How the preview pane's `<audio>` / `<video>` gets its bytes. ⛔ Linux is different: WebKitGTK's
// GStreamer player loads only http(s), file and blob URLs, so a `preview://` src fails at once
// with `loadingFailed: FormatError` (measured 2026-10-19: the mp3 bar said "Error", the mp4 was a
// black box) however well the protocol answers Range requests. There the file is fetched through
// the protocol (`<img>` and `fetch` load custom schemes fine) and handed to the player as a blob.
// Windows and Mac keep the protocol URL and its ranged streaming.
import { injected, onLinux, type TrovePlatform } from '$lib/utils/platform';

/** Whether the player must be given a `blob:` URL rather than the protocol URL. */
export const needsBlobMedia = (platform: TrovePlatform | undefined = injected()): boolean =>
  onLinux(platform);

/** The file behind `src` as a `blob:` URL (the caller revokes it), or `null` when the protocol
 * refused it: too large to send whole (413, over preview.rs's `MAX_SERVED_BYTES`), or gone. */
export const loadMediaBlob = async (
  src: string,
  load: (url: string) => Promise<Response> = fetch,
  toUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): Promise<string | null> => {
  const res = await load(src);
  if (!res.ok) return null;
  return toUrl(await res.blob());
};

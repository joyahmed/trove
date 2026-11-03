// The src the preview pane's player plays. Off Linux it is the protocol URL as given; on Linux the
// file is fetched into a blob first (`media-src.ts`: WebKitGTK cannot play a custom scheme), and
// the blob URL is revoked when the file changes or the player goes.
import { loadMediaBlob, needsBlobMedia } from '$lib/utils/media-src';

export const useMediaSrc = (src: () => string) => {
  const viaBlob = needsBlobMedia();
  let blobUrl = $state<string | null>(null);
  let refused = $state(false);

  $effect(() => {
    if (!viaBlob) return;
    const from = src();
    let live = true;
    let made: string | null = null;
    blobUrl = null;
    refused = false;
    loadMediaBlob(from)
      .then((url) => {
        if (!live) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (url) blobUrl = made = url;
        else refused = true;
      })
      .catch(() => {
        if (live) refused = true;
      });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  });

  return {
    /** what the player plays, or null while the blob is still loading */
    get src() {
      return viaBlob ? blobUrl : src();
    },
    /** the file could not be loaded whole (over 512 MB, or gone), so it cannot play here */
    get refused() {
      return refused;
    },
  };
};

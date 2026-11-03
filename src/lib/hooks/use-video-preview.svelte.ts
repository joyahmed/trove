// The preview pane's player: what it plays (`use-media-src`), and for a file too big to play here
// (Linux, over 512 MB) the label of the button that hands it to the system's default app.
import { useMediaSrc } from '$lib/hooks/use-media-src.svelte';
import { playInLabel, useDefaultAppName } from '$lib/hooks/use-default-app-name.svelte';

export const useVideoPreview = (src: () => string, path: () => string) => {
  const media = useMediaSrc(src);
  // asked only once the file is refused: every other preview needs no app name
  const app = useDefaultAppName(() => (media.refused ? path() : null));

  return {
    get src() {
      return media.src;
    },
    get refused() {
      return media.refused;
    },
    get playLabel() {
      return playInLabel(app.name);
    },
  };
};

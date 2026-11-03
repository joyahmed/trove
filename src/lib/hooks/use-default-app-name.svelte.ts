// The name of the app that opens a file by default ("VLC media player"), for a "Play in …" button.
// Looked up only while `path` gives a path, from the same list the Open with flyout shows; null
// while loading, when no app is the default, or when the lookup fails.
import { openWithApps } from '$lib/api/open-with';

/** "Play in VLC media player", or a plain fallback while the name is unknown. */
export const playInLabel = (app: string | null): string =>
  app ? `Play in ${app}` : 'Play in your default app';

export const useDefaultAppName = (path: () => string | null) => {
  let name = $state<string | null>(null);

  $effect(() => {
    const p = path();
    name = null;
    if (!p) return;
    let live = true;
    openWithApps(p)
      .then((apps) => {
        if (live) name = apps.find((a) => a.isDefault)?.name ?? null;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  });

  return {
    get name() {
      return name;
    },
  };
};

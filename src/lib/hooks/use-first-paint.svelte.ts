// The start-time line (plan 21 gap 6): once the first view is ready, wait for the frame that
// draws it and tell Rust, which logs `starting → painted` in ms. Once per window; Rust keeps
// it to once per process, so a second window or a reload says nothing.
import { startupPainted } from '$lib/api/startup-timing';
import { logError } from '$lib/api/log';
import { places } from '$lib/state/places.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { firstPaintReady } from '$lib/utils/first-paint';

export const useFirstPaint = () => {
  // ⚠️ A window that starts hidden (tray residency, start with Windows) paints no frame until
  // it is shown, so its number would be "time until someone opened it". It says nothing.
  let done = typeof document === 'undefined' || document.hidden;
  $effect(() => {
    if (done) return;
    const ready = firstPaintReady(tabs.active, places.loaded);
    if (!ready) return;
    done = true;
    // the first frame runs the update, the second is the one after it reached the screen
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        startupPainted(ready.what, ready.rows).catch((e: unknown) => logError('startupPainted', e));
      }),
    );
  });
};

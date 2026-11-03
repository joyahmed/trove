// The icon an app draws, by the shape of its entry — shared by the palette's APPS rows and the
// Applications place's tiles, so both show the same picture for the same app.
import type { AppEntry, PaletteResult } from '$lib/types/palette';
import { iconUrl, thumbUrl } from '$lib/api/icons';
import { keyedIcon } from '$lib/utils/file-icon';

/** The icon a row draws, by the shape of the entry (`path` ends `.app` = Mac, `.desktop` = Ubuntu). */
export const appIcon = (a: AppEntry): Pick<PaletteResult, 'iconKey' | 'glyph'> => {
  if (a.lnkPath) return { iconKey: `file/${a.lnkPath}` };
  if (a.path.toLowerCase().endsWith('.app')) return { iconKey: `file/${a.path}` };
  if (a.path.toLowerCase().endsWith('.desktop')) return { iconKey: `file/${a.path}` };
  return { iconKey: `app/${a.aumid}` };
};

/**
 * The image URL an Applications tile draws for an icon key: the same `keyedIcon` mapping the
 * palette rows use, so both places agree. A Mac `.app` is the bundle's QuickLook thumb; every
 * other key (Windows, Linux `.desktop`, `app/…`) keeps the shell icon route exactly as before.
 */
export const appTileSrc = (
  iconKey: string,
  drawn?: boolean,
  mac?: boolean,
): { kind: 'thumb' | 'shell'; src: string } => {
  const keyed = keyedIcon(iconKey, 32, undefined, drawn, mac);
  return keyed.kind === 'thumb'
    ? { kind: 'thumb', src: thumbUrl(keyed.path, 96) }
    : { kind: 'shell', src: iconUrl(iconKey, 32) };
};

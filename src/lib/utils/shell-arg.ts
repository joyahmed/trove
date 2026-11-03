// What a launch argument means. Explorer's callers pass shell folders as `::{CLSID}` (a
// desktop double-click on the Recycle Bin, Win+E's This PC) or as `shell:<name>`; Trove shows
// two of those itself and hands every other one back to explorer.exe, which knows them all.
import { parseLocation } from '$lib/utils/location';

export type LaunchArgKind = 'this-pc' | 'recycle-bin' | 'explorer' | 'path';

export const classifyLaunchArg = (text: string): LaunchArgKind => {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('::{') || lower.startsWith('shell:')) {
    const place = parseLocation(trimmed);
    if (place.kind === 'this-pc') return 'this-pc';
    if (place.kind === 'recycle-bin') return 'recycle-bin';
    return 'explorer';
  }
  return 'path';
};

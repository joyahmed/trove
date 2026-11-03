import { describe, expect, it } from 'vitest';
import { iconUrl, thumbUrl } from '$lib/api/icons';
import { appIcon, appTileSrc } from '$lib/utils/app-icon';
import { keyedIcon } from '$lib/utils/file-icon';
import type { AppEntry } from '$lib/types/palette';

const entry = (path: string): AppEntry => ({ path, aumid: '', name: 'x' }) as unknown as AppEntry;

describe('app icons by platform', () => {
  it('a Mac .app tile and a Spotlight row both resolve to the QuickLook thumb', () => {
    const { iconKey } = appIcon(entry('/Applications/Calculator.app'));
    expect(keyedIcon(iconKey!, 16, undefined, true, true).kind).toBe('thumb');
    expect(appTileSrc(iconKey!, true, true)).toEqual({
      kind: 'thumb',
      src: thumbUrl('/Applications/Calculator.app', 96),
    });
  });

  it('a Linux .desktop tile keeps the shell icon route, untouched', () => {
    const { iconKey } = appIcon(entry('/usr/share/applications/gedit.desktop'));
    expect(appTileSrc(iconKey!, true, false)).toEqual({
      kind: 'shell',
      src: iconUrl(iconKey!, 32),
    });
    expect(keyedIcon(iconKey!, 16, undefined, true, false).kind).toBe('shell');
  });

  it('Windows keeps the shell icon route', () => {
    expect(appTileSrc('app/Foo!App', false, false).kind).toBe('shell');
  });
});

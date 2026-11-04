import { afterEach, describe, expect, it } from 'vitest';
import { settings } from '$lib/state/settings.svelte';
import { displayName } from './display-name';
import { nameLabel } from '$lib/utils/file-name';

const file = (name: string) => ({ isDir: false, name });
const folder = (name: string) => ({ isDir: true, name });

describe('displayName', () => {
  afterEach(() => (settings.showExtensions = true));

  it('shows the full name while extensions are on (the default)', () => {
    expect(settings.showExtensions).toBe(true);
    expect(displayName(file('report.pdf'))).toBe('report.pdf');
  });

  it('follows the setting live once it is turned off', () => {
    settings.showExtensions = false;
    expect(displayName(file('report.pdf'))).toBe('report');
    expect(displayName(file('archive.tar.gz'))).toBe('archive.tar');
    expect(displayName(file('.bashrc'))).toBe('.bashrc');
  });

  it('never strips a folder name, even one with a dot in it', () => {
    expect(nameLabel(folder('v1.2'), false)).toBe('v1.2');
    expect(nameLabel(folder('.config'), false)).toBe('.config');
    expect(nameLabel(file('a.txt'), false)).toBe('a');
  });
});

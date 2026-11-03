// The words around a Replace (plan 15 G.2): the dialog says whether Undo can bring the old
// files back, before the person picks; the notice says it again when one was lost.
import { afterEach, describe, expect, it } from 'vitest';
import { comingFrom } from '$lib/state/coming-from.svelte';
import { conflictChoices } from '$lib/data/conflict-choices';
import { replaceDetail, replaceLostNotice } from './no-bin';

describe('replace wording', () => {
  afterEach(() => {
    comingFrom.choice = 'native';
  });

  it('where the bin keeps the old files, Replace says Undo brings them back', () => {
    expect(replaceDetail(null)).toBe(
      'The old files go to the Recycle Bin, so Undo can bring them back.',
    );
  });

  it('where there is no bin, Replace says plainly the old files are gone for good', () => {
    expect(replaceDetail('N:')).toBe(
      'N: has no Recycle Bin: the old files are overwritten for good, and Undo cannot bring them back.',
    );
  });

  it('on a Mac it says Undo cannot put the old files back', () => {
    comingFrom.choice = 'mac';
    expect(replaceDetail(null, { os: 'macos', thisPcLabel: 'This Mac' })).toBe(
      "The old files go to the Trash. Undo can't put them back: drag them out of the Trash in Finder.",
    );
  });

  it('on a Mac the Replace line names the bin by the chosen style', () => {
    const mac = { os: 'macos', thisPcLabel: 'This Mac' } as const;
    comingFrom.choice = 'windows';
    const win = replaceDetail(null, mac);
    expect(win).toContain('Recycle Bin');
    expect(win).not.toContain('Trash');
    comingFrom.choice = 'mac';
    expect(replaceDetail(null, mac)).toContain('Trash');
  });

  it('follows the bin word of the chosen style', () => {
    comingFrom.choice = 'mac';
    expect(replaceDetail(null)).toBe('The old files go to the Trash, so Undo can bring them back.');
    expect(replaceDetail('WSL')).toContain('WSL has no Trash');
  });

  it('the conflict dialog shows it under Replace, and only there', () => {
    const [replace, skip, both] = conflictChoices('N:');
    expect(replace.key).toBe('replace');
    expect(replace.detail).toBe(replaceDetail('N:'));
    expect(skip.detail).not.toContain('Recycle Bin');
    expect(both.detail).not.toContain('Recycle Bin');
    expect(conflictChoices()[0].detail).toBe(replaceDetail(null));
  });

  it('the lost notice counts one or many', () => {
    expect(replaceLostNotice(1)).toEqual({
      title: 'Old file overwritten for good',
      message:
        'The file it replaced could not go to the Recycle Bin, so Undo cannot bring it back.',
    });
    expect(replaceLostNotice(3)).toEqual({
      title: 'Old files overwritten for good',
      message:
        'The 3 files it replaced could not go to the Recycle Bin, so Undo cannot bring them back.',
    });
  });
});

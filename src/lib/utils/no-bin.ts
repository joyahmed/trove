// The "no Recycle Bin here" refusal and its question, shared by everything that puts what it
// made in the bin on Undo (state/actions, state/archives).
import type { NoRecycleBin } from '$lib/api/fs';
import { binName, onMac, injected, type TrovePlatform } from '$lib/utils/platform';

/**
 * A network share, a mapped drive, WSL or a USB stick has no Recycle Bin: Windows deletes there
 * for good, so the backend refuses to "trash" them and deletes nothing (core/ops.rs `trash`).
 * That refusal is the ONLY test — no path is guessed at here. Whatever meets it asks first, then
 * deletes permanently, and leaves no "restore from bin" undo behind.
 *
 * Duck-typed rather than `instanceof`: a test that mocks `$lib/api/fs` without the class must
 * not turn an ordinary failure into a TypeError.
 */
export const noRecycleBin = (e: unknown): NoRecycleBin | null =>
  e instanceof Error && e.name === 'NoRecycleBin' && typeof (e as NoRecycleBin).place === 'string'
    ? (e as NoRecycleBin)
    : null;

/** "WSL has no Recycle Bin — permanently delete this file?" / "N: has no Trash — …". The bin's
 * word follows "I'm coming from" (plan 19, 1.4.3); ⛔ only the word — the question is still asked. */
export const noBinQuestion = (
  { place, reason }: Pick<NoRecycleBin, 'place' | 'reason'>,
  what: string,
) => {
  const bin = binName();
  if (reason === 'off')
    return `The ${bin} is turned off for ${place} — permanently delete ${what}?`;
  if (reason === 'denied')
    return `macOS did not let Trove use the ${bin} — permanently delete ${what}?`;
  if (reason === 'tooBig')
    return `Too big for the ${bin} on ${place} — permanently delete ${what}?`;
  return `${place} has no ${bin} — permanently delete ${what}?`;
};

/**
 * The conflict dialog's words under "Replace" (plan 15 G.2). Where the bin takes the old files,
 * say Undo brings them back; where `noBin` names a place without one, say plainly that they are
 * overwritten for good — before the person picks.
 */
export const replaceDetail = (
  noBin: string | null | undefined,
  platform: TrovePlatform | undefined = injected(),
) => {
  const bin = binName();
  // the Mac Trash cannot be read back by the app, so Undo cannot return the old files
  if (!noBin && onMac(platform))
    return `The old files go to the ${bin}. Undo can't put them back: drag them out of the ${bin} in Finder.`;
  return noBin
    ? `${noBin} has no ${bin}: the old files are overwritten for good, and Undo cannot bring them back.`
    : `The old files go to the ${bin}, so Undo can bring them back.`;
};

/** The warning after a Replace whose old files the bin would not take (`replaced: 'lost'`). */
export const replaceLostNotice = (count: number) => {
  const bin = binName();
  const what = count === 1 ? 'The file it replaced' : `The ${count} files it replaced`;
  return {
    title: count === 1 ? 'Old file overwritten for good' : 'Old files overwritten for good',
    message: `${what} could not go to the ${bin}, so Undo cannot bring ${count === 1 ? 'it' : 'them'} back.`,
  };
};

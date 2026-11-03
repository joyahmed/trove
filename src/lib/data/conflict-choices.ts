// The three answers to "the destination already has files with these names", in Explorer's
// order. Rendered once by ConflictDialog; Replace's words depend on whether the bin keeps the old files.
import type { Resolution } from '$lib/types/transfer';
import { replaceDetail } from '$lib/utils/no-bin';

export interface ConflictChoice {
  key: Resolution;
  label: string;
  detail: string;
}

/** `noBin`: the place with no Recycle Bin the Replace would overwrite in (`replaceDetail`). */
export const conflictChoices = (noBin: string | null = null): ConflictChoice[] => [
  {
    key: 'replace',
    label: 'Replace the files in the destination',
    detail: replaceDetail(noBin),
  },
  {
    key: 'skip',
    label: 'Skip these files',
    detail: 'Everything else is still copied or moved.',
  },
  {
    key: 'keep-both',
    label: 'Keep both files',
    detail: 'The new ones get a "(2)" after their name.',
  },
];

// What a `/select,<item>` launch can do once its folder is listed: select the row, reveal it
// first because it is hidden and "show hidden" is off, or give up because it is not there.
import type { FileEntry } from '$lib/types/fs';
import { samePath } from '$lib/utils/path';

export type SelectPlan = 'select' | 'reveal-hidden' | 'missing';

export const selectPlan = (
  select: string,
  visible: readonly FileEntry[],
  entries: readonly FileEntry[],
): SelectPlan => {
  if (visible.some((e) => samePath(e.path, select))) return 'select';
  if (entries.some((e) => samePath(e.path, select))) return 'reveal-hidden';
  return 'missing';
};

import { onWindows } from '$lib/utils/platform';

/** Windows' registered shell entries exist only on Windows (`core/shell_verbs.rs` reads the
 * registry); off Windows there is nothing to count or refresh, so the dialog hides both. */
export const showsWindowsEntries = (): boolean => onWindows();

/** The line under the Customize title. */
export const customizeIntro = (verbCount: number, windows: boolean = onWindows()): string =>
  windows
    ? `Windows' own entries (${verbCount}) come from the registry and appear on their own. Your commands are listed here.`
    : 'Your commands are listed here.';

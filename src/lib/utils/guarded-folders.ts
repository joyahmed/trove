// How a Mac privacy-guarded folder (core/privacy_folders.rs) is named in "Not searched: …".
import { nameOf } from '$lib/utils/path';

/** The folders under `~/Library` whose own name says nothing to a person. */
const LIBRARY_NAMES: Record<string, string> = {
  'Mobile Documents': 'iCloud Drive',
  CloudStorage: 'Cloud storage',
  'Group Containers': "Other apps' data",
  Calendars: 'Calendars',
  AddressBook: 'Contacts',
  Photos: 'Photos library',
};

/** "Desktop", "iCloud Drive", "Photos library" — the word a person knows the folder by. */
export const guardedName = (path: string): string => {
  const name = nameOf(path);
  return /[\\/]Library[\\/]/.test(path) ? (LIBRARY_NAMES[name] ?? name) : name;
};

/** The first `max` names, an ellipsis when there are more: "Desktop, Documents, Downloads…". */
export const guardedNames = (paths: string[], max = 3): string =>
  paths.slice(0, max).map(guardedName).join(', ') + (paths.length > max ? '…' : '');

/** The palette's and the search header's quiet row. */
export const notSearchedTitle = (paths: string[]): string => `Not searched: ${guardedNames(paths)}`;

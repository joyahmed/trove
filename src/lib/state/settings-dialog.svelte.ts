// The Settings dialog's own state: open or not, and which section shows. The values it edits
// live in `settings` (and `defaultHandler` for the one toggle that touches the registry).

export type SettingsSectionKey =
  | 'general'
  | 'behaviour'
  | 'appearance'
  | 'keyboard'
  | 'quick-access'
  | 'context-menu'
  | 'apps'
  | 'search-index'
  | 'advanced';

class SettingsDialogState {
  open = $state(false);
  section = $state<SettingsSectionKey>('general');

  show(section: SettingsSectionKey = 'general') {
    this.section = section;
    this.open = true;
  }

  close() {
    this.open = false;
  }
}

export const settingsDialog = new SettingsDialogState();
